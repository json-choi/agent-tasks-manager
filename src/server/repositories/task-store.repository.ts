import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentSettings,
  AgentThreadContext,
  AgentType,
  ChannelMode,
  ChannelPolicy,
  GitHubSettings,
  OwnerMapping,
  OutboxItem,
  SlackCursor,
  SlackDigest,
  SlackDigestCandidate,
  Task,
  TaskPriority,
  TaskState
} from "../shared/types";
import { channelModes, taskPriorities, taskStates } from "../shared/types";
import { compactText, hashSecret, newId, newSecret, nowIso, safeJsonParse, tokenPreview } from "../shared/utils";

interface AgentRow {
  id: string;
  type: AgentType;
  name: string;
  api_token_hash: string | null;
  api_token_preview: string | null;
  cli_path: string | null;
  config_path: string | null;
  workspace_path: string | null;
  status: "pending" | "connected" | "error";
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: TaskState;
  priority: TaskPriority;
  assignee: string | null;
  reporter: string | null;
  notify: number;
  initiative: string | null;
  next_action: string | null;
  result: string | null;
  github_ref: string | null;
  channel_id: string | null;
  thread_ts: string | null;
  source_agent_id: string | null;
  source_agent_name: string | null;
  source_author: string | null;
  source_url: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  markdown_path: string;
  dedupe_key: string | null;
}

interface OwnerMappingRow {
  id: string;
  owner_name: string;
  slack_user_id: string | null;
  aliases: string;
  active: number;
  created_at: string;
  updated_at: string;
}

interface SlackCursorRow {
  agent_id: string;
  channel_id: string;
  last_ts: string;
  last_scanned_at: string;
  include_threads: number;
}

interface SlackDigestRow {
  id: string;
  agent_id: string;
  channel_id: string;
  status: "pending" | "committed";
  payload: string;
  created_at: string;
  committed_at: string | null;
}

interface GitHubSettingsRow {
  id: string;
  payload: string;
  updated_at: string;
}

interface ChannelPolicyRow {
  channel_id: string;
  mode: ChannelMode;
  created_at: string;
  updated_at: string;
}

interface OutboxRow {
  id: string;
  agent_id: string;
  type: string;
  payload: string;
  status: "pending" | "acked";
  created_at: string;
  acked_at: string | null;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskState;
  priority?: TaskPriority;
  assignee?: string | null;
  reporter?: string | null;
  notify?: boolean;
  initiative?: string | null;
  nextAction?: string | null;
  result?: string | null;
  githubRef?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  sourceAgentId?: string | null;
  sourceAgentName?: string | null;
  sourceAuthor?: string | null;
  sourceUrl?: string | null;
  dueAt?: string | null;
  dedupeKey?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskState;
  priority?: TaskPriority;
  assignee?: string | null;
  reporter?: string | null;
  notify?: boolean;
  initiative?: string | null;
  nextAction?: string | null;
  result?: string | null;
  githubRef?: string | null;
  dueAt?: string | null;
}

export interface UpsertOwnerInput {
  id?: string;
  ownerName: string;
  slackUserId?: string | null;
  aliases?: string[];
  active?: boolean;
}

export interface SlackDigestMessageInput {
  channelId?: string | null;
  channelName?: string | null;
  ts: string;
  threadTs?: string | null;
  parentTs?: string | null;
  userId?: string | null;
  userName?: string | null;
  text: string;
  permalink?: string | null;
  botId?: string | null;
}

export interface CreateSlackDigestInput {
  channelId: string;
  channelName?: string | null;
  messages: SlackDigestMessageInput[];
  nextLastTs?: string | null;
  includeThreads?: boolean;
}

export interface CommitSlackDigestInput {
  digestId: string;
  selectedCandidateIds?: string[];
  createTasks?: boolean;
}

export interface UpsertAgentInput {
  id?: string;
  type: AgentType;
  name?: string;
  cliPath?: string | null;
  configPath?: string | null;
  workspacePath?: string | null;
  regenerateToken?: boolean;
}

export interface StorageHealth {
  ok: boolean;
  dataDir: string;
  tasksDir: string;
  eventsDir: string;
  auditDir: string;
  configPath: string;
  sqlitePath: string;
  missing: string[];
}

export class TaskStore {
  readonly dataDir: string;
  readonly tasksDir: string;
  readonly eventsDir: string;
  readonly auditDir: string;
  readonly configDir: string;
  readonly configPath: string;
  readonly sqlitePath: string;

  readonly db: Database;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.tasksDir = join(dataDir, "tasks");
    this.eventsDir = join(dataDir, "events");
    this.auditDir = join(dataDir, "audit");
    this.configDir = join(dataDir, "config");
    this.configPath = join(this.configDir, "app.yml");
    this.sqlitePath = join(dataDir, "index.sqlite");

    this.prepareStorage();
    this.db = new Database(this.sqlitePath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  prepareStorage(): StorageHealth {
    mkdirSync(this.tasksDir, { recursive: true });
    mkdirSync(this.eventsDir, { recursive: true });
    mkdirSync(this.auditDir, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });

    if (!existsSync(this.configPath)) {
      writeFileSync(this.configPath, this.bootstrapConfigYaml(), "utf8");
    }

    return this.storageHealth();
  }

  storageHealth(): StorageHealth {
    const expected = [this.dataDir, this.tasksDir, this.eventsDir, this.auditDir, this.configDir];
    const missing = expected.filter((path) => !existsSync(path));
    if (!existsSync(this.configPath)) missing.push(this.configPath);

    return {
      ok: missing.length === 0 && existsSync(this.sqlitePath),
      dataDir: this.dataDir,
      tasksDir: this.tasksDir,
      eventsDir: this.eventsDir,
      auditDir: this.auditDir,
      configPath: this.configPath,
      sqlitePath: this.sqlitePath,
      missing
    };
  }

  countAdmins(): number {
    const row = this.db.query('SELECT count(*) AS count FROM "user"').get() as { count: number };
    return row.count;
  }

  isSetupLocked(): boolean {
    return this.countAdmins() > 0;
  }

  recordAudit(type: string, payload: unknown): void {
    this.audit(type, payload);
  }

  refreshAppConfig(): void {
    this.writeAppConfig();
  }

  listAgents(): AgentSettings[] {
    const rows = this.db
      .query(
        "SELECT id, type, name, api_token_hash, api_token_preview, cli_path, config_path, workspace_path, status, last_seen_at, created_at, updated_at FROM agents ORDER BY created_at ASC"
      )
      .all() as AgentRow[];
    return rows.map(agentFromRow);
  }

  getAgent(id: string): AgentSettings | null {
    const row = this.db
      .query(
        "SELECT id, type, name, api_token_hash, api_token_preview, cli_path, config_path, workspace_path, status, last_seen_at, created_at, updated_at FROM agents WHERE id = ?"
      )
      .get(id) as AgentRow | null;
    return row ? agentFromRow(row) : null;
  }

  getAgentForAuth(id: string, token: string): AgentSettings | null {
    const row = this.db
      .query(
        "SELECT id, type, name, api_token_hash, api_token_preview, cli_path, config_path, workspace_path, status, last_seen_at, created_at, updated_at FROM agents WHERE id = ?"
      )
      .get(id) as AgentRow | null;
    if (!row?.api_token_hash) return null;
    if (row.api_token_hash !== hashSecret(token)) return null;
    return agentFromRow(row);
  }

  upsertAgent(input: UpsertAgentInput): { agent: AgentSettings; token: string | null } {
    const existing = input.id ? this.getAgentRow(input.id) : null;
    const id = existing?.id ?? input.id ?? newId("agent");
    const now = nowIso();
    const token = !existing || input.regenerateToken ? newSecret("tmagt") : null;
    const tokenHash = token ? hashSecret(token) : existing?.api_token_hash ?? null;
    const tokenLabel = token ? tokenPreview(token) : existing?.api_token_preview ?? null;
    const name = input.name?.trim() || existing?.name || defaultAgentName(input.type);

    if (existing) {
      this.db
        .query(
          `UPDATE agents
           SET type = ?, name = ?, api_token_hash = ?, api_token_preview = ?, cli_path = ?,
               config_path = ?, workspace_path = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.type,
          name,
          tokenHash,
          tokenLabel,
          input.cliPath ?? existing.cli_path,
          input.configPath ?? existing.config_path,
          input.workspacePath ?? existing.workspace_path,
          now,
          id
        );
    } else {
      this.db
        .query(
          `INSERT INTO agents
           (id, type, name, api_token_hash, api_token_preview, cli_path, config_path,
            workspace_path, status, last_seen_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`
        )
        .run(
          id,
          input.type,
          name,
          tokenHash,
          tokenLabel,
          input.cliPath ?? null,
          input.configPath ?? null,
          input.workspacePath ?? null,
          now,
          now
        );
    }

    this.audit("agent.upserted", { id, type: input.type, name });
    this.writeAppConfig();
    const agent = this.getAgent(id);
    if (!agent) throw new Error("Agent upsert failed");
    return { agent, token };
  }

  markAgentSeen(id: string, status: "connected" | "error" = "connected"): void {
    this.db
      .query("UPDATE agents SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), nowIso(), id);
    this.writeAppConfig();
  }

  revokeAgentToken(id: string): AgentSettings | null {
    this.db
      .query(
        "UPDATE agents SET api_token_hash = NULL, api_token_preview = NULL, status = 'pending', updated_at = ? WHERE id = ?"
      )
      .run(nowIso(), id);
    this.audit("agent.token_revoked", { id });
    this.writeAppConfig();
    return this.getAgent(id);
  }

  listChannelPolicies(): ChannelPolicy[] {
    const rows = this.db
      .query("SELECT channel_id, mode, created_at, updated_at FROM channel_policies ORDER BY channel_id ASC")
      .all() as ChannelPolicyRow[];
    return rows.map(channelPolicyFromRow);
  }

  upsertChannelPolicy(channelId: string, mode: ChannelMode): ChannelPolicy {
    if (!channelModes.includes(mode)) {
      throw new Error(`Unsupported channel mode: ${mode}`);
    }

    const existing = this.db
      .query("SELECT channel_id, mode, created_at, updated_at FROM channel_policies WHERE channel_id = ?")
      .get(channelId) as ChannelPolicyRow | null;
    const now = nowIso();

    if (existing) {
      this.db
        .query("UPDATE channel_policies SET mode = ?, updated_at = ? WHERE channel_id = ?")
        .run(mode, now, channelId);
    } else {
      this.db
        .query(
          "INSERT INTO channel_policies (channel_id, mode, created_at, updated_at) VALUES (?, ?, ?, ?)"
        )
        .run(channelId, mode, now, now);
    }

    this.writeAppConfig();
    const row = this.db
      .query("SELECT channel_id, mode, created_at, updated_at FROM channel_policies WHERE channel_id = ?")
      .get(channelId) as ChannelPolicyRow;
    return channelPolicyFromRow(row);
  }

  getChannelMode(channelId: string | null): ChannelMode {
    if (!channelId) return "manual_only";
    const row = this.db
      .query("SELECT mode FROM channel_policies WHERE channel_id = ?")
      .get(channelId) as { mode: ChannelMode } | null;
    return row?.mode ?? "manual_only";
  }

  createTask(input: CreateTaskInput): { task: Task; duplicate: boolean } {
    if (input.dedupeKey) {
      const existing = this.findTaskByDedupeKey(input.dedupeKey);
      if (existing) return { task: existing, duplicate: true };
    }

    const now = nowIso();
    const id = newId("task");
    const status = input.status ?? "proposed";
    const priority = input.priority ?? "P2";
    const markdownPath = this.taskMarkdownPath(id, now);

    this.db
      .query(
        `INSERT INTO tasks
         (id, title, description, status, assignee, channel_id, thread_ts, source_agent_id,
          source_agent_name, source_author, source_url, due_at, created_at, updated_at,
          confirmed_at, markdown_path, dedupe_key, priority, reporter, notify, initiative,
          next_action, result, github_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.description ?? "",
        status,
        input.assignee ?? null,
        input.channelId ?? null,
        input.threadTs ?? null,
        input.sourceAgentId ?? null,
        input.sourceAgentName ?? null,
        input.sourceAuthor ?? null,
        input.sourceUrl ?? null,
        input.dueAt ?? null,
        now,
        now,
        status === "confirmed" ? now : null,
        markdownPath,
        input.dedupeKey ?? null,
        priority,
        input.reporter ?? null,
        input.notify === false ? 0 : 1,
        input.initiative ?? null,
        input.nextAction ?? null,
        input.result ?? null,
        input.githubRef ?? null
      );

    const task = this.getTask(id);
    if (!task) throw new Error("Task create failed");
    this.writeTaskMarkdown(task);
    this.audit("task.created", { id: task.id, status: task.status });
    return { task, duplicate: false };
  }

  listTasks(filters: { status?: TaskState; assignee?: string } = {}): Task[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }

    if (filters.assignee) {
      clauses.push("assignee = ?");
      params.push(filters.assignee);
    }

    const sql = `SELECT * FROM tasks ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC`;
    const rows = this.db.query(sql).all(...params) as TaskRow[];
    return rows.map(taskFromRow);
  }

  getTask(id: string): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null;
    return row ? taskFromRow(row) : null;
  }

  findTaskByDedupeKey(dedupeKey: string): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE dedupe_key = ?").get(dedupeKey) as TaskRow | null;
    return row ? taskFromRow(row) : null;
  }

  updateTask(id: string, input: UpdateTaskInput): Task | null {
    const existing = this.getTask(id);
    if (!existing) return null;

    const title = input.title ?? existing.title;
    const description = input.description ?? existing.description;
    const status = input.status ?? existing.status;
    const priority = input.priority ?? existing.priority;
    const assignee = input.assignee === undefined ? existing.assignee : input.assignee;
    const reporter = input.reporter === undefined ? existing.reporter : input.reporter;
    const notify = input.notify === undefined ? existing.notify : input.notify;
    const initiative = input.initiative === undefined ? existing.initiative : input.initiative;
    const nextAction = input.nextAction === undefined ? existing.nextAction : input.nextAction;
    const result = input.result === undefined ? existing.result : input.result;
    const githubRef = input.githubRef === undefined ? existing.githubRef : input.githubRef;
    const dueAt = input.dueAt === undefined ? existing.dueAt : input.dueAt;
    const now = nowIso();
    const confirmedAt =
      existing.confirmedAt ?? (status === "confirmed" || status === "in_progress" ? now : null);

    this.db
      .query(
        `UPDATE tasks
         SET title = ?, description = ?, status = ?, priority = ?, assignee = ?, reporter = ?,
             notify = ?, initiative = ?, next_action = ?, result = ?, github_ref = ?, due_at = ?,
             updated_at = ?, confirmed_at = ?
         WHERE id = ?`
      )
      .run(
        title,
        description,
        status,
        priority,
        assignee,
        reporter,
        notify ? 1 : 0,
        initiative,
        nextAction,
        result,
        githubRef,
        dueAt,
        now,
        confirmedAt,
        id
      );

    const task = this.getTask(id);
    if (task) {
      this.writeTaskMarkdown(task);
      this.audit("task.updated", { id: task.id, status: task.status });
    }
    return task;
  }

  recordEvent(agentId: string | null, type: string, payload: unknown): void {
    const now = nowIso();
    this.db
      .query("INSERT INTO events (id, agent_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(newId("evt"), agentId, type, JSON.stringify(payload), now);
    const date = now.slice(0, 10);
    appendFileSync(
      join(this.eventsDir, `agent-${date}.ndjson`),
      `${JSON.stringify({ agentId, type, payload, createdAt: now })}\n`,
      "utf8"
    );
  }

  enqueueOutbox(agentId: string, type: string, payload: unknown): OutboxItem {
    const id = newId("out");
    const now = nowIso();
    this.db
      .query(
        "INSERT INTO outbox (id, agent_id, type, payload, status, created_at, acked_at) VALUES (?, ?, ?, ?, 'pending', ?, NULL)"
      )
      .run(id, agentId, type, JSON.stringify(payload), now);
    const item = this.getOutboxItem(id);
    if (!item) throw new Error("Outbox enqueue failed");
    return item;
  }

  listOutbox(agentId: string, limit = 25): OutboxItem[] {
    const rows = this.db
      .query(
        "SELECT id, agent_id, type, payload, status, created_at, acked_at FROM outbox WHERE agent_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?"
      )
      .all(agentId, limit) as OutboxRow[];
    return rows.map(outboxFromRow);
  }

  ackOutbox(agentId: string, id: string): OutboxItem | null {
    this.db
      .query("UPDATE outbox SET status = 'acked', acked_at = ? WHERE id = ? AND agent_id = ?")
      .run(nowIso(), id, agentId);
    return this.getOutboxItem(id);
  }

  getOpenAssignmentsOlderThan(minutes: number): Task[] {
    const threshold = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const rows = this.db
      .query("SELECT * FROM tasks WHERE status = 'assigning' AND updated_at < ? ORDER BY updated_at ASC")
      .all(threshold) as TaskRow[];
    return rows.map(taskFromRow);
  }

  getStaleInProgressOlderThan(days: number): Task[] {
    const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .query("SELECT * FROM tasks WHERE status = 'in_progress' AND updated_at < ? ORDER BY updated_at ASC")
      .all(threshold) as TaskRow[];
    return rows.map(taskFromRow);
  }

  buildDedupeKey(context: AgentThreadContext): string | null {
    if (!context.channelId || !context.threadTs) return null;
    return `slack:${context.channelId}:${context.threadTs}`;
  }

  listOwners(): OwnerMapping[] {
    const rows = this.db
      .query(
        "SELECT id, owner_name, slack_user_id, aliases, active, created_at, updated_at FROM owner_mappings ORDER BY owner_name ASC"
      )
      .all() as OwnerMappingRow[];
    return rows.map(ownerFromRow);
  }

  upsertOwner(input: UpsertOwnerInput): OwnerMapping {
    const existing = input.id
      ? (this.db
          .query(
            "SELECT id, owner_name, slack_user_id, aliases, active, created_at, updated_at FROM owner_mappings WHERE id = ?"
          )
          .get(input.id) as OwnerMappingRow | null)
      : null;
    const now = nowIso();
    const id = existing?.id ?? input.id ?? newId("owner");
    const aliases = JSON.stringify(input.aliases ?? (existing ? safeJsonParse<string[]>(existing.aliases, []) : []));
    const active = input.active ?? (existing ? existing.active === 1 : true);

    if (existing) {
      this.db
        .query(
          `UPDATE owner_mappings
           SET owner_name = ?, slack_user_id = ?, aliases = ?, active = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(input.ownerName, input.slackUserId ?? existing.slack_user_id, aliases, active ? 1 : 0, now, id);
    } else {
      this.db
        .query(
          `INSERT INTO owner_mappings
           (id, owner_name, slack_user_id, aliases, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.ownerName, input.slackUserId ?? null, aliases, active ? 1 : 0, now, now);
    }

    this.audit("owner.upserted", { id, ownerName: input.ownerName });
    const row = this.db
      .query(
        "SELECT id, owner_name, slack_user_id, aliases, active, created_at, updated_at FROM owner_mappings WHERE id = ?"
      )
      .get(id) as OwnerMappingRow;
    return ownerFromRow(row);
  }

  resolveOwner(value: string | null): OwnerMapping | null {
    if (!value) return null;
    const normalized = normalizeToken(value);
    return (
      this.listOwners().find((owner) => {
        if (!owner.active) return false;
        const values = [owner.ownerName, owner.slackUserId, ...owner.aliases].filter(
          (candidate): candidate is string => Boolean(candidate)
        );
        return values.some((candidate) => normalizeToken(candidate) === normalized);
      }) ?? null
    );
  }

  getSlackCursor(agentId: string, channelId: string): SlackCursor | null {
    const row = this.db
      .query(
        "SELECT agent_id, channel_id, last_ts, last_scanned_at, include_threads FROM slack_channel_cursors WHERE agent_id = ? AND channel_id = ?"
      )
      .get(agentId, channelId) as SlackCursorRow | null;
    return row ? slackCursorFromRow(row) : null;
  }

  upsertSlackCursor(agentId: string, channelId: string, lastTs: string, includeThreads = true): SlackCursor {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO slack_channel_cursors
         (agent_id, channel_id, last_ts, last_scanned_at, include_threads)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, channel_id) DO UPDATE SET
           last_ts = excluded.last_ts,
           last_scanned_at = excluded.last_scanned_at,
           include_threads = excluded.include_threads`
      )
      .run(agentId, channelId, lastTs, now, includeThreads ? 1 : 0);
    const cursor = this.getSlackCursor(agentId, channelId);
    if (!cursor) throw new Error("Slack cursor update failed");
    return cursor;
  }

  createSlackDigest(agentId: string, input: CreateSlackDigestInput): SlackDigest {
    const id = newId("digest");
    const now = nowIso();
    const candidates = buildSlackDigestCandidates(input);
    const payload = {
      channelName: input.channelName ?? null,
      messages: input.messages.map((message) => ({ ...message })),
      candidates,
      nextLastTs: input.nextLastTs ?? latestSlackTs(input.messages)
    };

    this.db
      .query(
        `INSERT INTO slack_digests
         (id, agent_id, channel_id, status, payload, created_at, committed_at)
         VALUES (?, ?, ?, 'pending', ?, ?, NULL)`
      )
      .run(id, agentId, input.channelId, JSON.stringify(payload), now);
    this.recordEvent(agentId, "slack.digest.collected", {
      digestId: id,
      channelId: input.channelId,
      messageCount: input.messages.length,
      candidateCount: candidates.length
    });
    const digest = this.getSlackDigest(agentId, id);
    if (!digest) throw new Error("Slack digest create failed");
    return digest;
  }

  getSlackDigest(agentId: string, digestId: string): SlackDigest | null {
    const row = this.db
      .query(
        "SELECT id, agent_id, channel_id, status, payload, created_at, committed_at FROM slack_digests WHERE agent_id = ? AND id = ?"
      )
      .get(agentId, digestId) as SlackDigestRow | null;
    return row ? slackDigestFromRow(row) : null;
  }

  commitSlackDigest(
    agent: AgentSettings,
    input: CommitSlackDigestInput
  ): { digest: SlackDigest; cursor: SlackCursor | null; tasks: Task[] } {
    const digest = this.getSlackDigest(agent.id, input.digestId);
    if (!digest) throw new Error("Slack digest not found");

    const selected = new Set(input.selectedCandidateIds ?? digest.payload.candidates.map((candidate) => candidate.id));
    const tasks: Task[] = [];

    if (input.createTasks !== false) {
      for (const candidate of digest.payload.candidates) {
        if (!selected.has(candidate.id)) continue;
        const result = this.createTask({
          title: compactText(candidate.text, 96),
          description: renderSlackCandidateDescription(candidate),
          status: "proposed",
          priority: inferPriority(candidate.text),
          reporter: candidate.userName ?? candidate.userId,
          channelId: candidate.channelId,
          threadTs: candidate.threadTs ?? candidate.ts,
          sourceAgentId: agent.id,
          sourceAgentName: agent.name,
          sourceAuthor: candidate.userId ?? candidate.userName,
          sourceUrl: candidate.permalink,
          dedupeKey: `slack:${candidate.channelId}:${candidate.threadTs ?? candidate.ts}`
        });
        tasks.push(result.task);
      }
    }

    const committedAt = nowIso();
    this.db
      .query("UPDATE slack_digests SET status = 'committed', committed_at = ? WHERE id = ? AND agent_id = ?")
      .run(committedAt, digest.id, agent.id);

    const cursor =
      digest.payload.nextLastTs || latestCandidateTs(digest.payload.candidates)
        ? this.upsertSlackCursor(
            agent.id,
            digest.channelId,
            digest.payload.nextLastTs ?? latestCandidateTs(digest.payload.candidates) ?? "",
            true
          )
        : null;
    const committed = this.getSlackDigest(agent.id, digest.id);
    if (!committed) throw new Error("Slack digest commit failed");
    this.recordEvent(agent.id, "slack.digest.committed", {
      digestId: digest.id,
      taskCount: tasks.length,
      cursor
    });
    return { digest: committed, cursor, tasks };
  }

  getGitHubSettings(): GitHubSettings {
    const row = this.db
      .query("SELECT id, payload, updated_at FROM github_settings WHERE id = 'default'")
      .get() as GitHubSettingsRow | null;
    const payload = row ? safeJsonParse<Partial<GitHubSettings>>(row.payload, {}) : {};
    return {
      enabled: payload.enabled ?? false,
      autoCreateIssues: payload.autoCreateIssues ?? false,
      autoUpdateTaskStatusFromGitHub: payload.autoUpdateTaskStatusFromGitHub ?? false,
      autoCompleteClosedIssues: payload.autoCompleteClosedIssues ?? false,
      tokenConfigured: Boolean(process.env.GITHUB_TOKEN),
      rules: payload.rules ?? [],
      labels: payload.labels ?? [],
      assigneesByOwner: payload.assigneesByOwner ?? {},
      updatedAt: row?.updated_at ?? null
    };
  }

  updateGitHubSettings(input: Partial<GitHubSettings>): GitHubSettings {
    const current = this.getGitHubSettings();
    const next: GitHubSettings = {
      ...current,
      ...input,
      tokenConfigured: Boolean(process.env.GITHUB_TOKEN),
      rules: input.rules ?? current.rules,
      labels: input.labels ?? current.labels,
      assigneesByOwner: input.assigneesByOwner ?? current.assigneesByOwner,
      updatedAt: nowIso()
    };
    this.db
      .query(
        `INSERT INTO github_settings (id, payload, updated_at)
         VALUES ('default', ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(next), next.updatedAt);
    this.audit("github.settings_updated", { enabled: next.enabled });
    return this.getGitHubSettings();
  }

  recordGitHubSyncRun(input: {
    status: "skipped" | "completed" | "error";
    summary: Record<string, unknown>;
    error?: string | null;
  }): { id: string; status: string; summary: Record<string, unknown>; error: string | null; createdAt: string } {
    const id = newId("ghrun");
    const now = nowIso();
    this.db
      .query("INSERT INTO github_sync_runs (id, status, summary, error, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.status, JSON.stringify(input.summary), input.error ?? null, now);
    return { id, status: input.status, summary: input.summary, error: input.error ?? null, createdAt: now };
  }

  private getAgentRow(id: string): AgentRow | null {
    return (
      (this.db
        .query(
          "SELECT id, type, name, api_token_hash, api_token_preview, cli_path, config_path, workspace_path, status, last_seen_at, created_at, updated_at FROM agents WHERE id = ?"
        )
        .get(id) as AgentRow | null) ?? null
    );
  }

  private getOutboxItem(id: string): OutboxItem | null {
    const row = this.db
      .query("SELECT id, agent_id, type, payload, status, created_at, acked_at FROM outbox WHERE id = ?")
      .get(id) as OutboxRow | null;
    return row ? outboxFromRow(row) : null;
  }

  private taskMarkdownPath(id: string, isoDate: string): string {
    const year = isoDate.slice(0, 4);
    const month = isoDate.slice(5, 7);
    return join(this.tasksDir, year, month, `task_${id}.md`);
  }

  private writeTaskMarkdown(task: Task): void {
    mkdirSync(dirname(task.markdownPath), { recursive: true });
    writeFileSync(task.markdownPath, renderTaskMarkdown(task), "utf8");
  }

  private audit(type: string, payload: unknown): void {
    const now = nowIso();
    const month = now.slice(0, 7);
    appendFileSync(
      join(this.auditDir, `audit-${month}.ndjson`),
      `${JSON.stringify({ type, payload, createdAt: now })}\n`,
      "utf8"
    );
  }

  private writeAppConfig(): void {
    writeFileSync(this.configPath, this.defaultConfigYaml(), "utf8");
  }

  private bootstrapConfigYaml(): string {
    return `setup_locked: false
storage:
  tasks: ${yamlValue(this.tasksDir)}
  events: ${yamlValue(this.eventsDir)}
  audit: ${yamlValue(this.auditDir)}
  sqlite: ${yamlValue(this.sqlitePath)}
agents:
  []
channel_policies:
  default: manual_only
`;
  }

  private defaultConfigYaml(): string {
    const agents = this.listAgents();
    const channels = this.listChannelPolicies();
    const agentLines = agents.length
      ? agents
          .map(
            (agent) =>
              `  - id: ${yamlValue(agent.id)}\n    type: ${yamlValue(agent.type)}\n    name: ${yamlValue(agent.name)}\n    status: ${yamlValue(agent.status)}\n    api_token_preview: ${yamlValue(agent.apiTokenPreview)}`
          )
          .join("\n")
      : "  []";
    const channelLines = channels.length
      ? channels
          .map((policy) => `  ${policy.channelId}: ${policy.mode}`)
          .join("\n")
      : "  default: manual_only";

    return `setup_locked: ${this.isSetupLocked()}
storage:
  tasks: ${yamlValue(this.tasksDir)}
  events: ${yamlValue(this.eventsDir)}
  audit: ${yamlValue(this.auditDir)}
  sqlite: ${yamlValue(this.sqlitePath)}
agents:
${agentLines}
channel_policies:
${channelLines}
`;
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS "user" (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        emailVerified INTEGER NOT NULL,
        image TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        expiresAt TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        ipAddress TEXT,
        userAgent TEXT,
        userId TEXT NOT NULL,
        FOREIGN KEY (userId) REFERENCES "user"(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS session_userId_idx ON session(userId)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS account (
        id TEXT PRIMARY KEY,
        accountId TEXT NOT NULL,
        providerId TEXT NOT NULL,
        userId TEXT NOT NULL,
        accessToken TEXT,
        refreshToken TEXT,
        idToken TEXT,
        accessTokenExpiresAt TEXT,
        refreshTokenExpiresAt TEXT,
        scope TEXT,
        password TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (userId) REFERENCES "user"(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS account_userId_idx ON account(userId)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS verification (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        value TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        api_token_hash TEXT,
        api_token_preview TEXT,
        cli_path TEXT,
        config_path TEXT,
        workspace_path TEXT,
        status TEXT NOT NULL,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS channel_policies (
        channel_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'P2',
        assignee TEXT,
        reporter TEXT,
        notify INTEGER NOT NULL DEFAULT 1,
        initiative TEXT,
        next_action TEXT,
        result TEXT,
        github_ref TEXT,
        channel_id TEXT,
        thread_ts TEXT,
        source_agent_id TEXT,
        source_agent_name TEXT,
        source_author TEXT,
        source_url TEXT,
        due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        markdown_path TEXT NOT NULL,
        dedupe_key TEXT UNIQUE
      )
    `);
    this.ensureTaskColumn("priority", "TEXT NOT NULL DEFAULT 'P2'");
    this.ensureTaskColumn("reporter", "TEXT");
    this.ensureTaskColumn("notify", "INTEGER NOT NULL DEFAULT 1");
    this.ensureTaskColumn("initiative", "TEXT");
    this.ensureTaskColumn("next_action", "TEXT");
    this.ensureTaskColumn("result", "TEXT");
    this.ensureTaskColumn("github_ref", "TEXT");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acked_at TEXT,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS owner_mappings (
        id TEXT PRIMARY KEY,
        owner_name TEXT NOT NULL UNIQUE,
        slack_user_id TEXT,
        aliases TEXT NOT NULL,
        active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slack_channel_cursors (
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_ts TEXT NOT NULL,
        last_scanned_at TEXT NOT NULL,
        include_threads INTEGER NOT NULL,
        PRIMARY KEY (agent_id, channel_id),
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slack_digests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        committed_at TEXT,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS github_settings (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS github_task_links (
        task_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        issue_number INTEGER,
        issue_url TEXT,
        state TEXT,
        last_synced_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS github_sync_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.writeAppConfig();
  }

  private ensureTaskColumn(name: string, definition: string): void {
    const rows = this.db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === name)) return;
    this.db.run(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  }
}

function agentFromRow(row: AgentRow): AgentSettings {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    apiTokenPreview: row.api_token_preview,
    cliPath: row.cli_path,
    configPath: row.config_path,
    workspacePath: row.workspace_path,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function taskFromRow(row: TaskRow): Task {
  const status = taskStates.includes(row.status) ? row.status : "proposed";
  const priority = taskPriorities.includes(row.priority) ? row.priority : "P2";
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status,
    priority,
    assignee: row.assignee,
    reporter: row.reporter,
    notify: row.notify !== 0,
    initiative: row.initiative,
    nextAction: row.next_action,
    result: row.result,
    githubRef: row.github_ref,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    sourceAgentId: row.source_agent_id,
    sourceAgentName: row.source_agent_name,
    sourceAuthor: row.source_author,
    sourceUrl: row.source_url,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    markdownPath: row.markdown_path,
    dedupeKey: row.dedupe_key
  };
}

function ownerFromRow(row: OwnerMappingRow): OwnerMapping {
  return {
    id: row.id,
    ownerName: row.owner_name,
    slackUserId: row.slack_user_id,
    aliases: safeJsonParse<string[]>(row.aliases, []),
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function slackCursorFromRow(row: SlackCursorRow): SlackCursor {
  return {
    agentId: row.agent_id,
    channelId: row.channel_id,
    lastTs: row.last_ts,
    lastScannedAt: row.last_scanned_at,
    includeThreads: row.include_threads === 1
  };
}

function slackDigestFromRow(row: SlackDigestRow): SlackDigest {
  return {
    id: row.id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    status: row.status,
    payload: safeJsonParse<SlackDigest["payload"]>(row.payload, { messages: [], candidates: [] }),
    createdAt: row.created_at,
    committedAt: row.committed_at
  };
}

function channelPolicyFromRow(row: ChannelPolicyRow): ChannelPolicy {
  return {
    channelId: row.channel_id,
    mode: row.mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function outboxFromRow(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    agentId: row.agent_id,
    type: row.type,
    payload: safeJsonParse<unknown>(row.payload, {}),
    status: row.status,
    createdAt: row.created_at,
    ackedAt: row.acked_at
  };
}

function defaultAgentName(type: AgentType): string {
  return type === "hermes" ? "Hermes Agent" : "OpenClaw";
}

function renderTaskMarkdown(task: Task): string {
  return `---
id: ${yamlValue(task.id)}
title: ${yamlValue(task.title)}
status: ${yamlValue(task.status)}
priority: ${yamlValue(task.priority)}
assignee: ${yamlValue(task.assignee)}
reporter: ${yamlValue(task.reporter)}
notify: ${yamlValue(task.notify)}
initiative: ${yamlValue(task.initiative)}
next_action: ${yamlValue(task.nextAction)}
result: ${yamlValue(task.result)}
github_ref: ${yamlValue(task.githubRef)}
channel_id: ${yamlValue(task.channelId)}
thread_ts: ${yamlValue(task.threadTs)}
source_agent_id: ${yamlValue(task.sourceAgentId)}
source_agent_name: ${yamlValue(task.sourceAgentName)}
source_author: ${yamlValue(task.sourceAuthor)}
source_url: ${yamlValue(task.sourceUrl)}
due_at: ${yamlValue(task.dueAt)}
created_at: ${yamlValue(task.createdAt)}
updated_at: ${yamlValue(task.updatedAt)}
confirmed_at: ${yamlValue(task.confirmedAt)}
dedupe_key: ${yamlValue(task.dedupeKey)}
---

# ${task.title}

${task.description || "_No description provided._"}
`;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/^<@([a-z0-9]+)>$/i, "$1").replace(/^@/, "");
}

function buildSlackDigestCandidates(input: CreateSlackDigestInput): SlackDigestCandidate[] {
  return input.messages.flatMap((message) => {
    if (message.botId) return [];
    const text = message.text.trim();
    if (!text) return [];
    const reason = candidateReason(text);
    if (!reason) return [];
    return [
      {
        id: newId("cand"),
        channelId: input.channelId,
        channelName: message.channelName ?? input.channelName ?? null,
        ts: message.ts,
        threadTs: message.threadTs ?? message.parentTs ?? null,
        userId: message.userId ?? null,
        userName: message.userName ?? null,
        text,
        permalink: message.permalink ?? null,
        reason
      }
    ];
  });
}

function candidateReason(text: string): string | null {
  const normalized = text.toLowerCase();
  if (/\/task|태스크|할 일|todo|action item|follow[- ]?up/.test(normalized)) return "explicit-task-language";
  if (/해야|해줘|필요|수정|구현|확인|담당|owner|assign|fix|bug|blocked/.test(normalized)) {
    return "action-language";
  }
  return null;
}

function inferPriority(text: string): TaskPriority {
  const normalized = text.toLowerCase();
  if (/\bp0\b|긴급|urgent|blocker|장애/.test(normalized)) return "P0";
  if (/\bp1\b|important|중요|이번주|soon/.test(normalized)) return "P1";
  return "P2";
}

function latestSlackTs(messages: SlackDigestMessageInput[]): string | null {
  return messages
    .map((message) => message.ts)
    .filter(Boolean)
    .sort((a, b) => Number(b) - Number(a))[0] ?? null;
}

function latestCandidateTs(candidates: SlackDigestCandidate[]): string | null {
  return candidates
    .map((candidate) => candidate.ts)
    .filter(Boolean)
    .sort((a, b) => Number(b) - Number(a))[0] ?? null;
}

function renderSlackCandidateDescription(candidate: SlackDigestCandidate): string {
  const lines = [
    "Slack digest candidate:",
    "",
    `- Channel: ${candidate.channelName ? `#${candidate.channelName}` : candidate.channelId}`,
    `- User: ${candidate.userName ?? candidate.userId ?? "unknown"}`,
    `- Reason: ${candidate.reason}`,
    `- Timestamp: ${candidate.ts}`
  ];
  if (candidate.permalink) lines.push(`- Source: ${candidate.permalink}`);
  lines.push("", candidate.text);
  return lines.join("\n");
}

function yamlValue(value: string | null | boolean): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}
