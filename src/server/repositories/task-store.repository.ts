import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentSettings,
  AgentThreadContext,
  AgentType,
  AssignmentRequest,
  AssignmentRequestStatus,
  ChannelMode,
  ChannelPolicy,
  GitHubSettings,
  MemberInvitation,
  MemberInvitationStatus,
  OwnerMapping,
  OutboxItem,
  PublicAccessSettings,
  SlackCollectedMessage,
  SlackCollectedMessageWithRun,
  SlackCollectionRun,
  SlackCollectionRunStatus,
  SlackCollectionTrigger,
  SetupReviewSettings,
  SlackCursor,
  SlackCollectionScopeSettings,
  SlackDigest,
  SlackDigestCandidate,
  SlackConfirmationAction,
  SlackTaskCandidateRecord,
  SlackTaskCandidateConfirmationRequest,
  SlackTaskCandidateMetadata,
  SlackThreadCollectionMode,
  SlackWorkspaceConnection,
  SlackWorkspaceChannel,
  Task,
  TaskCategory,
  TaskPriority,
  TaskState,
  UserProfile,
  UserRole
} from "../shared/types";
import {
  channelModes,
  slackConfirmationActions,
  slackConfirmationResponseStates,
  slackCollectionRunStatuses,
  slackCollectionTriggers,
  slackThreadCollectionModes,
  taskCategories,
  taskPriorities,
  taskStates,
  userRoles
} from "../shared/types";
import { normalizeSlackCollectionScopeSettings } from "../shared/parsers";
import { classifySlackTaskificationMessage, type SlackTaskificationClassification } from "../../shared/slack-qualification";
import {
  deriveSlackTaskCandidateContent,
  detectSlackMemberMappingUncertainties,
  validateSlackTaskCandidateMetadata
} from "../services/slack-task.service";
import { compactText, hashSecret, newId, newSecret, nowIso, safeJsonParse, stringValue, tokenPreview } from "../shared/utils";

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
  category: TaskCategory;
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

interface UserProfileRow {
  user_id: string;
  role: UserRole;
  owner_id: string | null;
  slack_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MemberInvitationRow {
  id: string;
  token_hash: string;
  owner_id: string;
  owner_name: string | null;
  slack_user_id: string;
  email: string | null;
  status: MemberInvitationStatus;
  expires_at: string;
  accepted_user_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
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

interface SlackCollectedMessageRow {
  id: string;
  agent_id: string;
  collection_run_id: string | null;
  workspace_id: string | null;
  channel_id: string;
  channel_name: string | null;
  thread_ts: string | null;
  message_ts: string;
  user_id: string | null;
  user_name: string | null;
  text: string;
  permalink: string | null;
  bot_id: string | null;
  digest_id: string | null;
  collection_scope_source: "saved" | "manual_override";
  thread_collection_mode: SlackThreadCollectionMode;
  collection_scope: string;
  dedupe_key: string;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SlackCollectionRunRow {
  id: string;
  agent_id: string;
  digest_id: string | null;
  workspace_id: string | null;
  channel_id: string;
  channel_name: string | null;
  collection_trigger: string;
  collection_scope_source: "saved" | "manual_override";
  thread_collection_mode: SlackThreadCollectionMode;
  collection_scope: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  received_message_count: number;
  parsed_message_count: number;
  retained_message_count: number;
  inserted_message_count: number;
  duplicate_message_count: number;
  candidate_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
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

interface AssignmentRequestRow {
  id: string;
  task_id: string;
  agent_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  slack_user_id: string | null;
  status: AssignmentRequestStatus;
  round: number;
  previous_request_id: string | null;
  requested_by: string | null;
  response_text: string | null;
  slack_message_ts: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  responded_at: string | null;
}

interface SlackTaskCandidateConfirmationRequestRow {
  id: string;
  agent_id: string;
  task_id: string;
  outbox_id: string | null;
  workspace_id: string;
  channel_id: string;
  thread_ts: string | null;
  message_ts: string;
  assignee_key: string;
  confirmation_target: string;
  confirmation_state: string;
  confirmation_action: string | null;
  selected_assignee: string | null;
  selected_classification: string | null;
  response_text: string | null;
  responded_at: string | null;
  dedupe_key: string;
  payload: string;
  created_at: string;
  updated_at: string;
}

interface SlackTaskCandidateRow {
  id: string;
  agent_id: string;
  task_id: string;
  workspace_id: string;
  channel_id: string;
  thread_ts: string | null;
  message_ts: string;
  source_ts: string | null;
  assignee_key: string;
  confirmation_target: string | null;
  confirmation_state: string;
  dedupe_key: string;
  payload: string;
  created_at: string;
  updated_at: string;
}

interface RuntimeSettingRow {
  key: string;
  payload: string;
  updated_at: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskState;
  priority?: TaskPriority;
  category?: TaskCategory;
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
  category?: TaskCategory;
  assignee?: string | null;
  reporter?: string | null;
  notify?: boolean;
  initiative?: string | null;
  nextAction?: string | null;
  result?: string | null;
  githubRef?: string | null;
  dueAt?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  sourceAgentId?: string | null;
  sourceAgentName?: string | null;
  sourceAuthor?: string | null;
  sourceUrl?: string | null;
  dedupeKey?: string | null;
}

export interface UpsertOwnerInput {
  id?: string;
  ownerName: string;
  slackUserId?: string | null;
  aliases?: string[];
  active?: boolean;
}

export interface CreateMemberInvitationInput {
  id?: string;
  token?: string;
  owner: OwnerMapping;
  email?: string | null;
  createdByUserId?: string | null;
  expiresAt?: string | null;
}

export interface CreateAssignmentRequestInput {
  taskId: string;
  agentId?: string | null;
  owner: OwnerMapping;
  previousRequestId?: string | null;
  requestedBy?: string | null;
  expiresAt?: string | null;
}

export interface UpsertSlackTaskCandidateConfirmationRequestInput {
  agentId: string;
  taskId: string;
  outboxId?: string | null;
  candidate: SlackTaskCandidateMetadata;
  decision?: {
    confirmationAction?: SlackConfirmationAction | null;
    selectedAssignee?: string | null;
    selectedClassification?: TaskCategory | null;
    responseText?: string | null;
    respondedAt?: string | null;
  };
}

export interface UpsertSlackTaskCandidateInput {
  agentId: string;
  taskId: string;
  candidate: SlackTaskCandidateMetadata | PendingSlackTaskCandidateMetadata;
}

type PendingSlackTaskCandidateMetadata = Omit<SlackTaskCandidateMetadata, "confirmationState"> & {
  confirmationState?: SlackTaskCandidateMetadata["confirmationState"] | null;
};

export interface SlackDigestMessageInput {
  workspaceId?: string | null;
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
  workspaceId?: string | null;
  channelId: string;
  channelName?: string | null;
  messages: SlackDigestMessageInput[];
  nextLastTs?: string | null;
  includeThreads?: boolean;
  threadCollectionMode?: SlackThreadCollectionMode;
  collectionScope?: SlackCollectionScopeSettings;
  collectionScopeSource?: "saved" | "manual_override";
  collectionTrigger?: SlackCollectionTrigger;
  receivedMessageCount?: number;
  parsedMessageCount?: number;
}

export interface CommitSlackDigestInput {
  digestId: string;
  selectedCandidateIds?: string[];
  createTasks?: boolean;
}

export interface SlackWorkspaceConnectionInput {
  workspaceId?: string | null;
  teamId?: string | null;
  workspaceName?: string | null;
  teamName?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  channels?: unknown;
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

  getUserProfile(userId: string): UserProfile | null {
    const row = this.db
      .query("SELECT user_id, role, owner_id, slack_user_id, created_at, updated_at FROM user_profiles WHERE user_id = ?")
      .get(userId) as UserProfileRow | null;
    return row ? userProfileFromRow(row) : null;
  }

  ensureOwnerProfile(userId: string): UserProfile {
    const existing = this.getUserProfile(userId);
    if (existing) return existing;

    const now = nowIso();
    this.db
      .query(
        `INSERT INTO user_profiles
         (user_id, role, owner_id, slack_user_id, created_at, updated_at)
         VALUES (?, 'owner', NULL, NULL, ?, ?)`
      )
      .run(userId, now, now);
    this.audit("user_profile.owner_created", { userId });
    const profile = this.getUserProfile(userId);
    if (!profile) throw new Error("Owner profile create failed");
    return profile;
  }

  createMemberProfile(userId: string, owner: OwnerMapping): UserProfile {
    const existing = this.getUserProfile(userId);
    if (existing) return existing;
    if (!owner.slackUserId) throw new Error("Member profile owner must have a Slack user ID.");

    const now = nowIso();
    this.db
      .query(
        `INSERT INTO user_profiles
         (user_id, role, owner_id, slack_user_id, created_at, updated_at)
         VALUES (?, 'member', ?, ?, ?, ?)`
      )
      .run(userId, owner.id, owner.slackUserId, now, now);
    this.audit("user_profile.member_created", { userId, ownerId: owner.id, slackUserId: owner.slackUserId });
    const profile = this.getUserProfile(userId);
    if (!profile) throw new Error("Member profile create failed");
    return profile;
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
    const category = input.category ?? "general";
    const markdownPath = this.taskMarkdownPath(id, now);

    this.db
      .query(
        `INSERT INTO tasks
         (id, title, description, status, priority, category, assignee, channel_id, thread_ts, source_agent_id,
          source_agent_name, source_author, source_url, due_at, created_at, updated_at,
          confirmed_at, markdown_path, dedupe_key, reporter, notify, initiative,
          next_action, result, github_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.description ?? "",
        status,
        priority,
        category,
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

  findTaskBySlackSource(input: {
    channelId?: string | null;
    threadTs?: string | null;
    sourceUrl?: string | null;
    assignee?: string | null;
  }): Task | null {
    const assigneeClause = input.assignee ? "assignee = ?" : "assignee IS NULL";
    const assigneeParams = input.assignee ? [input.assignee] : [];

    if (input.sourceUrl) {
      const row = this.db
        .query(`SELECT * FROM tasks WHERE source_url = ? AND ${assigneeClause} ORDER BY updated_at DESC LIMIT 1`)
        .get(input.sourceUrl, ...assigneeParams) as TaskRow | null;
      if (row) return taskFromRow(row);
    }

    if (input.channelId && input.threadTs) {
      const row = this.db
        .query(`SELECT * FROM tasks WHERE channel_id = ? AND thread_ts = ? AND ${assigneeClause} ORDER BY updated_at DESC LIMIT 1`)
        .get(input.channelId, input.threadTs, ...assigneeParams) as TaskRow | null;
      if (row) return taskFromRow(row);
    }

    return null;
  }

  updateTask(id: string, input: UpdateTaskInput): Task | null {
    const existing = this.getTask(id);
    if (!existing) return null;

    const title = input.title ?? existing.title;
    const description = input.description ?? existing.description;
    const status = input.status ?? existing.status;
    const priority = input.priority ?? existing.priority;
    const category = input.category ?? existing.category;
    const assignee = input.assignee === undefined ? existing.assignee : input.assignee;
    const reporter = input.reporter === undefined ? existing.reporter : input.reporter;
    const notify = input.notify === undefined ? existing.notify : input.notify;
    const initiative = input.initiative === undefined ? existing.initiative : input.initiative;
    const nextAction = input.nextAction === undefined ? existing.nextAction : input.nextAction;
    const result = input.result === undefined ? existing.result : input.result;
    const githubRef = input.githubRef === undefined ? existing.githubRef : input.githubRef;
    const dueAt = input.dueAt === undefined ? existing.dueAt : input.dueAt;
    const channelId = input.channelId === undefined ? existing.channelId : input.channelId;
    const threadTs = input.threadTs === undefined ? existing.threadTs : input.threadTs;
    const sourceAgentId = input.sourceAgentId === undefined ? existing.sourceAgentId : input.sourceAgentId;
    const sourceAgentName = input.sourceAgentName === undefined ? existing.sourceAgentName : input.sourceAgentName;
    const sourceAuthor = input.sourceAuthor === undefined ? existing.sourceAuthor : input.sourceAuthor;
    const sourceUrl = input.sourceUrl === undefined ? existing.sourceUrl : input.sourceUrl;
    const dedupeKey = input.dedupeKey === undefined ? existing.dedupeKey : input.dedupeKey;
    const now = nowIso();
    const confirmedAt =
      existing.confirmedAt ?? (status === "confirmed" || status === "in_progress" ? now : null);

    this.db
      .query(
        `UPDATE tasks
         SET title = ?, description = ?, status = ?, priority = ?, assignee = ?, reporter = ?,
             category = ?, notify = ?, initiative = ?, next_action = ?, result = ?, github_ref = ?, due_at = ?,
             channel_id = ?, thread_ts = ?, source_agent_id = ?, source_agent_name = ?, source_author = ?,
             source_url = ?, dedupe_key = ?, updated_at = ?, confirmed_at = ?
         WHERE id = ?`
      )
      .run(
        title,
        description,
        status,
        priority,
        assignee,
        reporter,
        category,
        notify ? 1 : 0,
        initiative,
        nextAction,
        result,
        githubRef,
        dueAt,
        channelId,
        threadTs,
        sourceAgentId,
        sourceAgentName,
        sourceAuthor,
        sourceUrl,
        dedupeKey,
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

  hasOutboxPayloadDedupeKey(agentId: string, dedupeKey: string): boolean {
    const rows = this.db
      .query("SELECT payload FROM outbox WHERE agent_id = ?")
      .all(agentId) as Array<{ payload: string }>;
    return rows.some((row) => {
      const payload = safeJsonParse<Record<string, unknown>>(row.payload, {});
      return stringValue(payload.dedupeKey) === dedupeKey;
    });
  }

  hasSlackTaskCandidateConfirmationDedupeKey(agentId: string, dedupeKey: string): boolean {
    const row = this.db
      .query("SELECT id FROM slack_task_candidate_confirmations WHERE agent_id = ? AND dedupe_key = ?")
      .get(agentId, dedupeKey) as { id: string } | null;
    return Boolean(row);
  }

  upsertSlackTaskCandidate(input: UpsertSlackTaskCandidateInput): SlackTaskCandidateRecord {
    const candidate = normalizePendingSlackTaskCandidate(input.candidate);
    const candidateValidation = validateSlackTaskCandidateMetadata(candidate, { requireConfirmationBackedFields: true });
    if (!candidateValidation.ok) {
      throw new Error(
        `Slack task candidate metadata is missing or invalid: ${[
          ...candidateValidation.missing,
          ...candidateValidation.invalid
        ].join(", ")}`
      );
    }
    const now = nowIso();
    const assigneeKey =
      assigneeKeyFromSlackTaskCandidateDedupeKey(candidate.dedupeKey) ??
      candidate.assignee ??
      candidate.assigneeCandidates[0] ??
      "unassigned";
    const sourceTs = slackTaskCandidateSourceTs(candidate);
    const existing =
      this.getSlackTaskCandidateByDedupeKey(input.agentId, candidate.dedupeKey) ??
      this.getSlackTaskCandidateBySourceIdentity(input.agentId, {
        workspaceId: candidate.workspaceId,
        channelId: candidate.channelId,
        sourceTs,
        assigneeKey
      });

    if (existing) {
      this.db
        .query(
          `UPDATE slack_task_candidates
           SET task_id = ?, workspace_id = ?, channel_id = ?, thread_ts = ?, message_ts = ?,
               source_ts = ?, assignee_key = ?, confirmation_target = ?, confirmation_state = ?,
               dedupe_key = ?, payload = ?, updated_at = ?
          WHERE id = ?`
        )
        .run(
          input.taskId,
          candidate.workspaceId,
          candidate.channelId,
          candidate.threadTs,
          candidate.messageTs,
          sourceTs,
          assigneeKey,
          candidate.confirmationTarget || null,
          candidate.confirmationState,
          candidate.dedupeKey,
          JSON.stringify(candidate),
          now,
          existing.id
        );
      const updated = this.getSlackTaskCandidate(existing.id);
      if (!updated) throw new Error("Slack task candidate update failed");
      return updated;
    }

    const id = newId("cand");
    this.db
      .query(
        `INSERT INTO slack_task_candidates
         (id, agent_id, task_id, workspace_id, channel_id, thread_ts, message_ts, source_ts, assignee_key,
          confirmation_target, confirmation_state, dedupe_key, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.agentId,
        input.taskId,
        candidate.workspaceId,
        candidate.channelId,
        candidate.threadTs,
        candidate.messageTs,
        sourceTs,
        assigneeKey,
        candidate.confirmationTarget || null,
        candidate.confirmationState,
        candidate.dedupeKey,
        JSON.stringify(candidate),
        now,
        now
      );
    const persisted = this.getSlackTaskCandidate(id);
    if (!persisted) throw new Error("Slack task candidate create failed");
    this.audit("slack.task_candidate.persisted", {
      id,
      taskId: input.taskId,
      dedupeKey: candidate.dedupeKey,
      workspaceId: candidate.workspaceId,
      channelId: candidate.channelId,
      messageTs: candidate.messageTs
    });
    return persisted;
  }

  getSlackTaskCandidate(id: string): SlackTaskCandidateRecord | null {
    const row = this.db
      .query("SELECT * FROM slack_task_candidates WHERE id = ?")
      .get(id) as SlackTaskCandidateRow | null;
    return row ? slackTaskCandidateFromRow(row) : null;
  }

  getSlackTaskCandidateByDedupeKey(agentId: string, dedupeKey: string): SlackTaskCandidateRecord | null {
    const row = this.db
      .query("SELECT * FROM slack_task_candidates WHERE agent_id = ? AND dedupe_key = ?")
      .get(agentId, dedupeKey) as SlackTaskCandidateRow | null;
    return row ? slackTaskCandidateFromRow(row) : null;
  }

  getSlackTaskCandidateBySourceIdentity(
    agentId: string,
    identity: { workspaceId: string; channelId: string; sourceTs: string; assigneeKey: string }
  ): SlackTaskCandidateRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM slack_task_candidates
         WHERE agent_id = ? AND workspace_id = ? AND channel_id = ? AND source_ts = ? AND assignee_key = ?`
      )
      .get(agentId, identity.workspaceId, identity.channelId, identity.sourceTs, identity.assigneeKey) as SlackTaskCandidateRow | null;
    return row ? slackTaskCandidateFromRow(row) : null;
  }

  upsertSlackTaskCandidateConfirmationRequest(
    input: UpsertSlackTaskCandidateConfirmationRequestInput
  ): SlackTaskCandidateConfirmationRequest {
    const candidate = normalizePendingSlackTaskCandidate(input.candidate);
    const candidateValidation = validateSlackTaskCandidateMetadata(candidate, {
      requireConfirmationTarget: true,
      requireConfirmationBackedFields: true
    });
    if (!candidateValidation.ok) {
      throw new Error(
        `Slack task candidate metadata is missing or invalid: ${[
          ...candidateValidation.missing,
          ...candidateValidation.invalid
        ].join(", ")}`
      );
    }
    const existing = this.getSlackTaskCandidateConfirmationByDedupeKey(input.agentId, candidate.dedupeKey);
    const now = nowIso();
    const decisionRespondedAt =
      input.decision && input.decision.confirmationAction !== null
        ? input.decision.respondedAt ?? now
        : input.decision?.respondedAt;
    const assigneeKey =
      assigneeKeyFromSlackTaskCandidateDedupeKey(candidate.dedupeKey) ??
      candidate.assignee ??
      candidate.assigneeCandidates[0] ??
      "unassigned";

    if (existing) {
      this.db
        .query(
          `UPDATE slack_task_candidate_confirmations
           SET task_id = ?, outbox_id = ?, workspace_id = ?, channel_id = ?, thread_ts = ?,
               message_ts = ?, assignee_key = ?, confirmation_target = ?, confirmation_state = ?,
               confirmation_action = ?, selected_assignee = ?, selected_classification = ?,
               response_text = ?, responded_at = ?, payload = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.taskId,
          input.outboxId ?? existing.outboxId,
          candidate.workspaceId,
          candidate.channelId,
          candidate.threadTs,
          candidate.messageTs,
          assigneeKey,
          candidate.confirmationTarget,
          candidate.confirmationState,
          input.decision?.confirmationAction === undefined ? existing.confirmationAction : input.decision.confirmationAction,
          input.decision?.selectedAssignee === undefined ? existing.selectedAssignee : input.decision.selectedAssignee,
          input.decision?.selectedClassification === undefined
            ? existing.selectedClassification
            : input.decision.selectedClassification,
          input.decision?.responseText === undefined ? existing.responseText : input.decision.responseText,
          decisionRespondedAt === undefined ? existing.respondedAt : decisionRespondedAt,
          JSON.stringify(candidate),
          now,
          existing.id
        );
      const updated = this.getSlackTaskCandidateConfirmation(existing.id);
      if (!updated) throw new Error("Slack task candidate confirmation update failed");
      return updated;
    }

    const id = newId("cfm");
    this.db
      .query(
        `INSERT INTO slack_task_candidate_confirmations
         (id, agent_id, task_id, outbox_id, workspace_id, channel_id, thread_ts, message_ts,
          assignee_key, confirmation_target, confirmation_state, confirmation_action, selected_assignee,
          selected_classification, response_text, responded_at, dedupe_key, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.agentId,
        input.taskId,
        input.outboxId ?? null,
        candidate.workspaceId,
        candidate.channelId,
        candidate.threadTs,
        candidate.messageTs,
        assigneeKey,
        candidate.confirmationTarget,
        candidate.confirmationState,
        input.decision?.confirmationAction ?? null,
        input.decision?.selectedAssignee ?? null,
        input.decision?.selectedClassification ?? null,
        input.decision?.responseText ?? null,
        decisionRespondedAt ?? null,
        candidate.dedupeKey,
        JSON.stringify(candidate),
        now,
        now
      );
    const request = this.getSlackTaskCandidateConfirmation(id);
    if (!request) throw new Error("Slack task candidate confirmation create failed");
    this.audit("slack.task_candidate_confirmation.requested", {
      id,
      taskId: input.taskId,
      dedupeKey: candidate.dedupeKey,
      workspaceId: candidate.workspaceId,
      channelId: candidate.channelId,
      messageTs: candidate.messageTs
    });
    return request;
  }

  getSlackTaskCandidateConfirmation(id: string): SlackTaskCandidateConfirmationRequest | null {
    const row = this.db
      .query("SELECT * FROM slack_task_candidate_confirmations WHERE id = ?")
      .get(id) as SlackTaskCandidateConfirmationRequestRow | null;
    return row ? slackTaskCandidateConfirmationFromRow(row) : null;
  }

  getSlackTaskCandidateConfirmationByDedupeKey(
    agentId: string,
    dedupeKey: string
  ): SlackTaskCandidateConfirmationRequest | null {
    const row = this.db
      .query("SELECT * FROM slack_task_candidate_confirmations WHERE agent_id = ? AND dedupe_key = ?")
      .get(agentId, dedupeKey) as SlackTaskCandidateConfirmationRequestRow | null;
    return row ? slackTaskCandidateConfirmationFromRow(row) : null;
  }

  listSlackTaskCandidateConfirmationsPastNoResponseTimeout(
    agentId: string,
    timeoutMinutes: number,
    now = new Date()
  ): SlackTaskCandidateConfirmationRequest[] {
    const threshold = new Date(now.getTime() - timeoutMinutes * 60 * 1000).toISOString();
    const rows = this.db
      .query(
        `SELECT * FROM slack_task_candidate_confirmations
         WHERE agent_id = ?
           AND confirmation_action IS NULL
           AND responded_at IS NULL
           AND confirmation_state IN ('proposed', 'assigning')
           AND created_at <= ?
         ORDER BY created_at ASC`
      )
      .all(agentId, threshold) as SlackTaskCandidateConfirmationRequestRow[];
    return rows.map(slackTaskCandidateConfirmationFromRow);
  }

  transitionSlackTaskCandidateConfirmationsPastNoResponseTimeoutToReviewNeeded(
    agentId: string,
    timeoutMinutes: number,
    now = new Date()
  ): SlackTaskCandidateConfirmationRequest[] {
    const timedOut = this.listSlackTaskCandidateConfirmationsPastNoResponseTimeout(agentId, timeoutMinutes, now);
    const transitionedIds: string[] = [];

    this.db.transaction(() => {
      for (const confirmation of timedOut) {
        const task = this.getTask(confirmation.taskId);
        const candidate = this.getSlackTaskCandidateByDedupeKey(agentId, confirmation.dedupeKey);
        if (!task || !candidate) continue;
        if (task.status !== "proposed" && task.status !== "assigning") continue;
        if (candidate.confirmationState !== "proposed" && candidate.confirmationState !== "assigning") continue;

        const updatedTask = this.updateTask(task.id, { status: "review_needed" });
        if (!updatedTask) continue;

        const confirmationTarget = stringValue(confirmation.payload.leaderReviewer) ?? confirmation.confirmationTarget;
        const updatedCandidate: SlackTaskCandidateMetadata = {
          ...candidate.payload,
          ...confirmation.payload,
          taskTitle: updatedTask.title,
          taskDescription: updatedTask.description,
          taskClassification: updatedTask.category,
          assignee: updatedTask.assignee,
          confirmationState: "review_needed",
          confirmationTarget,
          dueAt: updatedTask.dueAt,
          nextAction: updatedTask.nextAction,
          sourceUrl: updatedTask.sourceUrl,
          markdownPath: updatedTask.markdownPath
        };

        this.upsertSlackTaskCandidate({
          agentId,
          taskId: updatedTask.id,
          candidate: updatedCandidate
        });
        const updatedConfirmation = this.upsertSlackTaskCandidateConfirmationRequest({
          agentId,
          taskId: updatedTask.id,
          outboxId: confirmation.outboxId,
          candidate: updatedCandidate
        });
        transitionedIds.push(updatedConfirmation.id);
      }
    })();

    return transitionedIds
      .map((id) => this.getSlackTaskCandidateConfirmation(id))
      .filter((confirmation): confirmation is SlackTaskCandidateConfirmationRequest => Boolean(confirmation));
  }

  ackOutbox(agentId: string, id: string): OutboxItem | null {
    this.db
      .query("UPDATE outbox SET status = 'acked', acked_at = ? WHERE id = ? AND agent_id = ?")
      .run(nowIso(), id, agentId);
    return this.getOutboxItem(id);
  }

  createAssignmentRequest(input: CreateAssignmentRequestInput): AssignmentRequest {
    const id = newId("asn");
    const now = nowIso();
    const previous = input.previousRequestId ? this.getAssignmentRequest(input.previousRequestId) : null;
    const round = previous ? previous.round + 1 : 1;
    this.db
      .query(
        `INSERT INTO assignment_requests
         (id, task_id, agent_id, owner_id, owner_name, slack_user_id, status, round,
          previous_request_id, requested_by, response_text, slack_message_ts, expires_at,
          created_at, updated_at, responded_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`
      )
      .run(
        id,
        input.taskId,
        input.agentId ?? null,
        input.owner.id,
        input.owner.ownerName,
        input.owner.slackUserId,
        round,
        input.previousRequestId ?? null,
        input.requestedBy ?? null,
        input.expiresAt ?? null,
        now,
        now
      );
    const request = this.getAssignmentRequest(id);
    if (!request) throw new Error("Assignment request create failed");
    this.audit("assignment.requested", { id, taskId: input.taskId, ownerName: input.owner.ownerName });
    return request;
  }

  getAssignmentRequest(id: string): AssignmentRequest | null {
    const row = this.db.query("SELECT * FROM assignment_requests WHERE id = ?").get(id) as AssignmentRequestRow | null;
    return row ? assignmentRequestFromRow(row) : null;
  }

  updateAssignmentRequest(
    id: string,
    input: {
      status?: AssignmentRequestStatus;
      responseText?: string | null;
      slackMessageTs?: string | null;
      respondedAt?: string | null;
    }
  ): AssignmentRequest | null {
    const existing = this.getAssignmentRequest(id);
    if (!existing) return null;
    const status = input.status ?? existing.status;
    const now = nowIso();
    const respondedAt = input.respondedAt === undefined
      ? existing.respondedAt ?? (status !== "pending" ? now : null)
      : input.respondedAt;
    this.db
      .query(
        `UPDATE assignment_requests
         SET status = ?, response_text = ?, slack_message_ts = ?, updated_at = ?, responded_at = ?
         WHERE id = ?`
      )
      .run(
        status,
        input.responseText === undefined ? existing.responseText : input.responseText,
        input.slackMessageTs === undefined ? existing.slackMessageTs : input.slackMessageTs,
        now,
        respondedAt,
        id
      );
    return this.getAssignmentRequest(id);
  }

  getPendingAssignmentRequestsOlderThan(minutes: number): AssignmentRequest[] {
    const threshold = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const rows = this.db
      .query("SELECT * FROM assignment_requests WHERE status = 'pending' AND updated_at < ? ORDER BY updated_at ASC")
      .all(threshold) as AssignmentRequestRow[];
    return rows.map(assignmentRequestFromRow);
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

  getOwner(id: string): OwnerMapping | null {
    const row = this.db
      .query(
        "SELECT id, owner_name, slack_user_id, aliases, active, created_at, updated_at FROM owner_mappings WHERE id = ?"
      )
      .get(id) as OwnerMappingRow | null;
    return row ? ownerFromRow(row) : null;
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

  hasMemberProfileForOwner(ownerId: string): boolean {
    const row = this.db
      .query("SELECT count(*) AS count FROM user_profiles WHERE role = 'member' AND owner_id = ?")
      .get(ownerId) as { count: number };
    return row.count > 0;
  }

  expireMemberInvitations(now = nowIso()): void {
    const staleClaimThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    this.db
      .query(
        `UPDATE member_invitations
         SET status = 'expired', updated_at = ?
         WHERE status IN ('pending', 'accepted') AND accepted_user_id IS NULL AND expires_at <= ?`
      )
      .run(now, now);
    this.db
      .query(
        `UPDATE member_invitations
         SET status = 'pending', updated_at = ?, accepted_at = NULL
         WHERE status = 'accepted' AND accepted_user_id IS NULL AND accepted_at < ? AND expires_at > ?`
      )
      .run(now, staleClaimThreshold, now);
  }

  listMemberInvitations(): MemberInvitation[] {
    this.expireMemberInvitations();
    const rows = this.db
      .query(
        `SELECT member_invitations.*, owner_mappings.owner_name
         FROM member_invitations
         LEFT JOIN owner_mappings ON owner_mappings.id = member_invitations.owner_id
         ORDER BY member_invitations.created_at DESC`
      )
      .all() as MemberInvitationRow[];
    return rows.map(memberInvitationFromRow);
  }

  getMemberInvitation(id: string): MemberInvitation | null {
    this.expireMemberInvitations();
    const row = this.db
      .query(
        `SELECT member_invitations.*, owner_mappings.owner_name
         FROM member_invitations
         LEFT JOIN owner_mappings ON owner_mappings.id = member_invitations.owner_id
         WHERE member_invitations.id = ?`
      )
      .get(id) as MemberInvitationRow | null;
    return row ? memberInvitationFromRow(row) : null;
  }

  getPendingMemberInvitationForOwner(ownerId: string): MemberInvitation | null {
    this.expireMemberInvitations();
    const row = this.db
      .query(
        `SELECT member_invitations.*, owner_mappings.owner_name
         FROM member_invitations
         LEFT JOIN owner_mappings ON owner_mappings.id = member_invitations.owner_id
         WHERE member_invitations.owner_id = ? AND member_invitations.status = 'pending'
         ORDER BY member_invitations.created_at DESC
         LIMIT 1`
      )
      .get(ownerId) as MemberInvitationRow | null;
    return row ? memberInvitationFromRow(row) : null;
  }

  createMemberInvitation(input: CreateMemberInvitationInput): { invitation: MemberInvitation; token: string } {
    if (!input.owner.slackUserId) throw new Error("Member invitation owner must have a Slack user ID.");

    const id = input.id ?? newId("inv");
    const token = input.token ?? newSecret("invite");
    const tokenHash = hashSecret(token);
    const now = nowIso();
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db
      .query(
        `INSERT INTO member_invitations
         (id, token_hash, owner_id, slack_user_id, email, status, expires_at,
          accepted_user_id, created_by_user_id, created_at, updated_at, accepted_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, ?, NULL, NULL)`
      )
      .run(
        id,
        tokenHash,
        input.owner.id,
        input.owner.slackUserId,
        input.email ?? null,
        expiresAt,
        input.createdByUserId ?? null,
        now,
        now
      );
    const invitation = this.getMemberInvitation(id);
    if (!invitation) throw new Error("Member invitation create failed");
    this.audit("member_invitation.created", { id, ownerId: input.owner.id, slackUserId: input.owner.slackUserId });
    return { invitation, token };
  }

  getMemberInvitationByToken(token: string): MemberInvitation | null {
    this.expireMemberInvitations();
    const row = this.db
      .query(
        `SELECT member_invitations.*, owner_mappings.owner_name
         FROM member_invitations
         LEFT JOIN owner_mappings ON owner_mappings.id = member_invitations.owner_id
         WHERE member_invitations.token_hash = ?`
      )
      .get(hashSecret(token)) as MemberInvitationRow | null;
    return row ? memberInvitationFromRow(row) : null;
  }

  claimMemberInvitation(id: string): MemberInvitation | null {
    this.expireMemberInvitations();
    const now = nowIso();
    const result = this.db
      .query(
        `UPDATE member_invitations
         SET status = 'accepted', updated_at = ?, accepted_at = ?
         WHERE id = ? AND status = 'pending' AND expires_at > ?`
      )
      .run(now, now, id, now) as { changes: number };
    if (result.changes < 1) return null;
    return this.getMemberInvitation(id);
  }

  completeMemberInvitation(id: string, input: { userId: string; email: string }): MemberInvitation | null {
    const existing = this.getMemberInvitation(id);
    if (!existing || existing.status !== "accepted" || existing.acceptedUserId) return existing;

    const now = nowIso();
    this.db
      .query(
        `UPDATE member_invitations
         SET accepted_user_id = ?, email = ?, updated_at = ?
         WHERE id = ? AND status = 'accepted' AND accepted_user_id IS NULL`
      )
      .run(input.userId, input.email.toLowerCase(), now, id);
    this.audit("member_invitation.accepted", { id, userId: input.userId, ownerId: existing.ownerId });
    return this.getMemberInvitation(id);
  }

  releaseMemberInvitationClaim(id: string): MemberInvitation | null {
    const existing = this.getMemberInvitation(id);
    if (!existing || existing.status !== "accepted" || existing.acceptedUserId) return existing;

    const now = nowIso();
    this.db
      .query(
        `UPDATE member_invitations
         SET status = 'pending', updated_at = ?, accepted_at = NULL
         WHERE id = ? AND status = 'accepted' AND accepted_user_id IS NULL`
      )
      .run(now, id);
    return this.getMemberInvitation(id);
  }

  revokeMemberInvitation(id: string): MemberInvitation | null {
    this.expireMemberInvitations();
    const existing = this.getMemberInvitation(id);
    if (!existing) return null;
    if (existing.status !== "pending" && !(existing.status === "accepted" && !existing.acceptedUserId)) return existing;

    const now = nowIso();
    this.db
      .query("UPDATE member_invitations SET status = 'revoked', updated_at = ?, revoked_at = ? WHERE id = ?")
      .run(now, now, id);
    this.audit("member_invitation.revoked", { id, ownerId: existing.ownerId });
    return this.getMemberInvitation(id);
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
    const collectionRunId = newId("slkrun");
    const persisted = this.persistSlackCollectedMessages(agentId, id, collectionRunId, input);
    const reusedMessages = this.slackCollectedMessagesWithExistingCandidates(agentId, input, persisted.duplicates);
    const uniqueInput = { ...input, messages: [...persisted.messages, ...reusedMessages] };
    const classifications = buildSlackDigestMessageClassifications(uniqueInput);
    const candidates = buildSlackDigestCandidates(uniqueInput, classifications).map((candidate) => {
      const assigneeOwner = resolveSlackDigestCandidateAssignee(this, candidate);
      const memberMappingUncertainties = detectSlackMemberMappingUncertainties(
        {
          authorId: candidate.userId,
          authorName: candidate.userName,
          assigneeCandidates: candidate.assigneeCandidates
        },
        (value) => this.resolveOwner(value)
      );
      return {
        ...candidate,
        assignee: assigneeOwner?.ownerName ?? candidate.assignee,
        assigneeResolution: assigneeOwner
          ? "assigned"
          : candidate.assigneeSlackUserId
            ? "unassigned"
            : candidate.assigneeResolution,
        requiresAssigneeConfirmation: !assigneeOwner,
        memberMappingUncertainties
      };
    });
    const collectionTrigger =
      input.collectionTrigger ?? (input.collectionScopeSource === "manual_override" ? "manual" : "scheduled");
    const collectionScopeSource = input.collectionScopeSource ?? "saved";
    const threadCollectionMode =
      input.threadCollectionMode ?? (input.includeThreads === false ? "parent_messages" : "active_threads");
    const collectionScope = input.collectionScope ?? this.getSlackCollectionScopeSettings();
    const payload = {
      workspaceId: input.workspaceId ?? null,
      channelName: input.channelName ?? null,
      messages: uniqueInput.messages.map((message) => ({ ...message })),
      classifications,
      candidates,
      nextLastTs: input.nextLastTs ?? latestSlackTs(input.messages),
      threadCollectionMode,
      collectionRunId,
      collectionPersistence: {
        insertedMessages: persisted.insertedCount,
        duplicateMessages: persisted.duplicateCount,
        dedupeKeys: persisted.records.map((record) => record.dedupeKey)
      }
    };

    this.db
      .query(
        `INSERT INTO slack_digests
         (id, agent_id, channel_id, status, payload, created_at, committed_at)
         VALUES (?, ?, ?, 'pending', ?, ?, NULL)`
      )
      .run(id, agentId, input.channelId, JSON.stringify(payload), now);
    this.db
      .query(
        `INSERT INTO slack_collection_runs
         (id, agent_id, digest_id, workspace_id, channel_id, channel_name, collection_trigger,
          collection_scope_source, thread_collection_mode, collection_scope, status, started_at,
          completed_at, received_message_count, parsed_message_count, retained_message_count,
          inserted_message_count, duplicate_message_count, candidate_count, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        collectionRunId,
        agentId,
        id,
        input.workspaceId ?? null,
        input.channelId,
        input.channelName ?? null,
        collectionTrigger,
        collectionScopeSource,
        threadCollectionMode,
        JSON.stringify(collectionScope),
        now,
        now,
        nonNegativeInteger(input.receivedMessageCount, input.messages.length),
        nonNegativeInteger(input.parsedMessageCount, input.messages.length),
        input.messages.length,
        persisted.insertedCount,
        persisted.duplicateCount,
        candidates.length,
        now,
        now
      );
    this.recordEvent(agentId, "slack.digest.collected", {
      digestId: id,
      collectionRunId,
      channelId: input.channelId,
      messageCount: input.messages.length,
      persistedMessageCount: persisted.insertedCount,
      duplicateMessageCount: persisted.duplicateCount,
      candidateCount: candidates.length
    });
    const digest = this.getSlackDigest(agentId, id);
    if (!digest) throw new Error("Slack digest create failed");
    return digest;
  }

  listSlackCollectionRuns(filters: { agentId?: string; channelId?: string; digestId?: string } = {}): SlackCollectionRun[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filters.agentId) {
      clauses.push("agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.channelId) {
      clauses.push("channel_id = ?");
      params.push(filters.channelId);
    }
    if (filters.digestId) {
      clauses.push("digest_id = ?");
      params.push(filters.digestId);
    }
    const sql = `SELECT * FROM slack_collection_runs ${
      clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    } ORDER BY started_at ASC`;
    const rows = this.db.query(sql).all(...params) as SlackCollectionRunRow[];
    return rows.map(slackCollectionRunFromRow);
  }

  listSlackCollectedMessages(filters: { agentId?: string; channelId?: string } = {}): SlackCollectedMessage[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filters.agentId) {
      clauses.push("agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.channelId) {
      clauses.push("channel_id = ?");
      params.push(filters.channelId);
    }
    const sql = `SELECT * FROM slack_collected_messages ${
      clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    } ORDER BY created_at ASC`;
    const rows = this.db.query(sql).all(...params) as SlackCollectedMessageRow[];
    return rows.map(slackCollectedMessageFromRow);
  }

  listUnprocessedSlackCollectedMessages(
    filters: {
      agentId?: string;
      workspaceId?: string;
      channelId?: string;
      collectionRunId?: string;
      digestId?: string;
      limit?: number;
    } = {}
  ): SlackCollectedMessageWithRun[] {
    const clauses = ["processed_at IS NULL"];
    const params: string[] = [];
    if (filters.agentId) {
      clauses.push("agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(filters.workspaceId);
    }
    if (filters.channelId) {
      clauses.push("channel_id = ?");
      params.push(filters.channelId);
    }
    if (filters.collectionRunId) {
      clauses.push("collection_run_id = ?");
      params.push(filters.collectionRunId);
    }
    if (filters.digestId) {
      clauses.push("digest_id = ?");
      params.push(filters.digestId);
    }
    const limit = Math.min(Math.max(nonNegativeInteger(filters.limit, 100), 1), 500);
    const rows = this.db
      .query(`SELECT * FROM slack_collected_messages WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC LIMIT ?`)
      .all(...params, String(limit)) as SlackCollectedMessageRow[];
    return rows.map((row) => {
      const message = slackCollectedMessageFromRow(row);
      return {
        message,
        collectionRun: message.collectionRunId ? this.getSlackCollectionRun(message.collectionRunId, message.agentId) : null
      };
    });
  }

  getSlackCollectionRun(id: string, agentId?: string): SlackCollectionRun | null {
    const row = agentId
      ? (this.db.query("SELECT * FROM slack_collection_runs WHERE id = ? AND agent_id = ?").get(id, agentId) as
          | SlackCollectionRunRow
          | null)
      : (this.db.query("SELECT * FROM slack_collection_runs WHERE id = ?").get(id) as SlackCollectionRunRow | null);
    return row ? slackCollectionRunFromRow(row) : null;
  }

  private persistSlackCollectedMessages(
    agentId: string,
    digestId: string,
    collectionRunId: string,
    input: CreateSlackDigestInput
  ): {
    messages: SlackDigestMessageInput[];
    duplicates: SlackDigestMessageInput[];
    records: SlackCollectedMessage[];
    insertedCount: number;
    duplicateCount: number;
  } {
    const now = nowIso();
    const collectionScope = input.collectionScope ?? this.getSlackCollectionScopeSettings();
    const collectionScopeSource = input.collectionScopeSource ?? "saved";
    const threadCollectionMode =
      input.threadCollectionMode ?? (input.includeThreads === false ? "parent_messages" : "active_threads");
    const insertedMessages: SlackDigestMessageInput[] = [];
    const duplicateMessages: SlackDigestMessageInput[] = [];
    const records: SlackCollectedMessage[] = [];
    let duplicateCount = 0;

    for (const message of input.messages) {
      const normalizedMessage: SlackDigestMessageInput = {
        ...message,
        workspaceId: message.workspaceId ?? input.workspaceId ?? null,
        channelId: message.channelId ?? input.channelId,
        channelName: message.channelName ?? input.channelName ?? null
      };
      const dedupeKey = buildSlackCollectedMessageDedupeKey(input, normalizedMessage);
      const existing = this.getSlackCollectedMessageByDedupeKey(agentId, dedupeKey);
      if (existing) {
        duplicateCount += 1;
        this.db
          .query(
            `UPDATE slack_collected_messages
             SET digest_id = ?, collection_run_id = ?, channel_name = ?, user_id = ?, user_name = ?, text = ?, permalink = ?,
                 bot_id = ?, collection_scope_source = ?, thread_collection_mode = ?,
                 collection_scope = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(
            digestId,
            collectionRunId,
            normalizedMessage.channelName ?? null,
            normalizedMessage.userId ?? null,
            normalizedMessage.userName ?? null,
            normalizedMessage.text,
            normalizedMessage.permalink ?? null,
            normalizedMessage.botId ?? null,
            collectionScopeSource,
            threadCollectionMode,
            JSON.stringify(collectionScope),
            now,
            existing.id
          );
        const updated = this.getSlackCollectedMessageByDedupeKey(agentId, dedupeKey);
        if (updated) records.push(updated);
        duplicateMessages.push(normalizedMessage);
        continue;
      }

      const id = newId("slkmsg");
      this.db
        .query(
          `INSERT INTO slack_collected_messages
           (id, agent_id, collection_run_id, workspace_id, channel_id, channel_name, thread_ts, message_ts,
            user_id, user_name, text, permalink, bot_id, digest_id, collection_scope_source,
            thread_collection_mode, collection_scope, dedupe_key, processed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          id,
          agentId,
          collectionRunId,
          normalizedMessage.workspaceId ?? null,
          normalizedMessage.channelId ?? input.channelId,
          normalizedMessage.channelName ?? null,
          normalizedMessage.threadTs ?? normalizedMessage.parentTs ?? null,
          normalizedMessage.ts,
          normalizedMessage.userId ?? null,
          normalizedMessage.userName ?? null,
          normalizedMessage.text,
          normalizedMessage.permalink ?? null,
          normalizedMessage.botId ?? null,
          digestId,
          collectionScopeSource,
          threadCollectionMode,
          JSON.stringify(collectionScope),
          dedupeKey,
          now,
          now
        );
      insertedMessages.push(normalizedMessage);
      const record = this.getSlackCollectedMessageByDedupeKey(agentId, dedupeKey);
      if (record) records.push(record);
    }

    return { messages: insertedMessages, duplicates: duplicateMessages, records, insertedCount: insertedMessages.length, duplicateCount };
  }

  private slackCollectedMessagesWithExistingCandidates(
    agentId: string,
    input: CreateSlackDigestInput,
    messages: SlackDigestMessageInput[]
  ): SlackDigestMessageInput[] {
    const messageByTs = new Map(messages.map((message) => [message.ts, message]));
    return buildSlackDigestCandidates({ ...input, messages }).flatMap((candidate) => {
      if (!this.getSlackTaskCandidateByDedupeKey(agentId, buildSlackDigestTaskDedupeKey(candidate))) return [];
      const message = messageByTs.get(candidate.ts);
      return message ? [message] : [];
    });
  }

  private getSlackCollectedMessageByDedupeKey(agentId: string, dedupeKey: string): SlackCollectedMessage | null {
    const row = this.db
      .query("SELECT * FROM slack_collected_messages WHERE agent_id = ? AND dedupe_key = ?")
      .get(agentId, dedupeKey) as SlackCollectedMessageRow | null;
    return row ? slackCollectedMessageFromRow(row) : null;
  }

  private markSlackCollectedMessageProcessed(
    agentId: string,
    input: { digestId: string; channelId: string; threadTs: string | null; messageTs: string }
  ): void {
    const now = nowIso();
    const threadClause = input.threadTs ? "thread_ts = ?" : "thread_ts IS NULL";
    const params = input.threadTs
      ? [now, now, agentId, input.digestId, input.channelId, input.threadTs, input.messageTs]
      : [now, now, agentId, input.digestId, input.channelId, input.messageTs];
    this.db
      .query(
        `UPDATE slack_collected_messages
         SET processed_at = ?, updated_at = ?
         WHERE agent_id = ? AND digest_id = ? AND channel_id = ? AND ${threadClause} AND message_ts = ?`
      )
      .run(...params);
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
        const assigneeOwner = resolveSlackDigestCandidateAssignee(this, candidate);
        const result = this.createTask({
          title: candidate.taskTitle,
          description: renderSlackCandidateDescription(candidate),
          status: "proposed",
          priority: inferPriority(candidate.text),
          assignee: assigneeOwner?.ownerName ?? null,
          reporter: candidate.userName ?? candidate.userId,
          channelId: candidate.channelId,
          threadTs: candidate.threadTs ?? candidate.ts,
          sourceAgentId: agent.id,
          sourceAgentName: agent.name,
          sourceAuthor: candidate.userId ?? candidate.userName,
          sourceUrl: candidate.permalink,
          dueAt: candidate.dueAt,
          nextAction: candidate.nextAction,
          dedupeKey: buildSlackDigestTaskDedupeKey(candidate)
        });
        tasks.push(result.task);
        this.markSlackCollectedMessageProcessed(agent.id, {
          digestId: digest.id,
          channelId: candidate.channelId,
          threadTs: candidate.threadTs,
          messageTs: candidate.ts
        });
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
            digest.payload.threadCollectionMode !== "parent_messages"
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

  getSlackCollectionScopeSettings(): SlackCollectionScopeSettings {
    const row = this.db
      .query("SELECT key, payload, updated_at FROM runtime_settings WHERE key = 'slack_collection_scope'")
      .get() as RuntimeSettingRow | null;
    const payload = row ? safeJsonParse<Partial<SlackCollectionScopeSettings>>(row.payload, {}) : {};
    return normalizeSlackCollectionScopeSettings(payload, row?.updated_at ?? null);
  }

  updateSlackCollectionScopeSettings(input: Partial<SlackCollectionScopeSettings>): SlackCollectionScopeSettings {
    const current = this.getSlackCollectionScopeSettings();
    const now = nowIso();
    const merged: Partial<SlackCollectionScopeSettings> = {
      ...current,
      ...input,
      updatedAt: now
    };
    if (input.workspaces !== undefined || input.workspace !== undefined) {
      const workspaceInput: Partial<SlackCollectionScopeSettings> = {};
      if (input.workspaces !== undefined) workspaceInput.workspaces = input.workspaces;
      if (input.workspace !== undefined) workspaceInput.workspace = input.workspace;
      const workspaceScope = normalizeSlackCollectionScopeSettings(workspaceInput);
      merged.workspaces = workspaceScope.workspaces;
      merged.workspace = workspaceScope.workspace;
    }
    const next = normalizeSlackCollectionScopeSettings(merged, now);
    this.db
      .query(
        `INSERT INTO runtime_settings (key, payload, updated_at)
         VALUES ('slack_collection_scope', ?, ?)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(next), now);
    this.audit("slack_collection_scope.updated", {
      workspaces: next.workspaces,
      workspace: next.workspace,
      channels: next.channels,
      channelThreadScopes: next.channelThreadScopes,
      threads: next.threads,
      mentions: next.mentions,
      keywords: next.keywords
    });
    this.writeAppConfig();
    return this.getSlackCollectionScopeSettings();
  }

  listSlackWorkspaceConnections(): SlackWorkspaceConnection[] {
    const row = this.db
      .query("SELECT key, payload, updated_at FROM runtime_settings WHERE key = 'slack_workspace_connections'")
      .get() as RuntimeSettingRow | null;
    const saved = row ? safeJsonParse<SlackWorkspaceConnection[]>(row.payload, []) : [];
    const byWorkspace = new Map<string, SlackWorkspaceConnection>();

    for (const connection of saved) {
      if (!isSlackWorkspaceId(connection.workspaceId)) continue;
      byWorkspace.set(connection.workspaceId, {
        workspaceId: connection.workspaceId,
        workspaceName: stringOrNull(connection.workspaceName),
        agentId: stringOrNull(connection.agentId),
        agentName: stringOrNull(connection.agentName),
        channels: normalizeSlackWorkspaceChannels(connection.channels),
        status: connection.status === "connected" ? "connected" : "configured",
        lastSeenAt: stringOrNull(connection.lastSeenAt)
      });
    }

    const scope = this.getSlackCollectionScopeSettings();
    for (const workspaceId of scope.workspaces) {
      if (byWorkspace.has(workspaceId)) continue;
      byWorkspace.set(workspaceId, {
        workspaceId,
        workspaceName: null,
        agentId: null,
        agentName: null,
        channels: [],
        status: "configured",
        lastSeenAt: null
      });
    }

    return Array.from(byWorkspace.values()).sort((a, b) => {
      const aSeen = a.lastSeenAt ?? "";
      const bSeen = b.lastSeenAt ?? "";
      if (aSeen !== bSeen) return bSeen.localeCompare(aSeen);
      return a.workspaceId.localeCompare(b.workspaceId);
    });
  }

  recordSlackWorkspaceConnection(agent: AgentSettings, input: SlackWorkspaceConnectionInput): SlackWorkspaceConnection | null {
    const workspaceId = stringValue(input.workspaceId) ?? stringValue(input.teamId);
    if (!workspaceId || !isSlackWorkspaceId(workspaceId)) return null;
    const now = nowIso();
    const previous = this.listSlackWorkspaceConnections().find((item) => item.workspaceId === workspaceId);
    const channels = mergeSlackWorkspaceChannels(
      previous?.channels ?? [],
      slackWorkspaceChannelsFromInput(input, now)
    );
    const connection: SlackWorkspaceConnection = {
      workspaceId,
      workspaceName: stringValue(input.workspaceName) ?? stringValue(input.teamName),
      agentId: agent.id,
      agentName: agent.name,
      channels,
      status: "connected",
      lastSeenAt: now
    };
    const next = [
      connection,
      ...this.listSlackWorkspaceConnections().filter((item) => item.workspaceId !== workspaceId)
    ];
    this.db
      .query(
        `INSERT INTO runtime_settings (key, payload, updated_at)
         VALUES ('slack_workspace_connections', ?, ?)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(next), now);
    this.audit("slack_workspace_connection.seen", {
      workspaceId: connection.workspaceId,
      workspaceName: connection.workspaceName,
      agentId: connection.agentId
    });
    this.writeAppConfig();
    return connection;
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

  upsertGitHubTaskLink(input: {
    taskId: string;
    repo: string;
    issueNumber: number;
    issueUrl?: string | null;
    state?: string | null;
  }): void {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO github_task_links
         (task_id, repo, issue_number, issue_url, state, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           repo = excluded.repo,
           issue_number = excluded.issue_number,
           issue_url = excluded.issue_url,
           state = excluded.state,
           last_synced_at = excluded.last_synced_at`
      )
      .run(input.taskId, input.repo, input.issueNumber, input.issueUrl ?? null, input.state ?? null, now);
  }

  updateGitHubTaskLinkState(taskId: string, state: string | null): void {
    const now = nowIso();
    this.db
      .query("UPDATE github_task_links SET state = ?, last_synced_at = ? WHERE task_id = ?")
      .run(state, now, taskId);
  }

  findTaskByGitHubIssue(repo: string, issueNumber: number): Task | null {
    const linked = this.db
      .query(
        `SELECT tasks.*
         FROM github_task_links
         JOIN tasks ON tasks.id = github_task_links.task_id
         WHERE lower(github_task_links.repo) = lower(?) AND github_task_links.issue_number = ?`
      )
      .get(repo, issueNumber) as TaskRow | null;
    if (linked) return taskFromRow(linked);

    const ref = `${repo}#${issueNumber}`;
    const row = this.db
      .query("SELECT * FROM tasks WHERE lower(github_ref) = lower(?)")
      .get(ref) as TaskRow | null;
    return row ? taskFromRow(row) : null;
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

  getSetupReviewSettings(): SetupReviewSettings {
    const row = this.db
      .query("SELECT key, payload, updated_at FROM runtime_settings WHERE key = 'setup_review'")
      .get() as RuntimeSettingRow | null;
    const payload = row ? safeJsonParse<Partial<SetupReviewSettings>>(row.payload, {}) : {};
    return {
      slackPermissionsReviewedAt: payload.slackPermissionsReviewedAt ?? null
    };
  }

  updateSetupReviewSettings(input: Partial<SetupReviewSettings>): SetupReviewSettings {
    const current = this.getSetupReviewSettings();
    const next: SetupReviewSettings = {
      ...current,
      ...input
    };
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO runtime_settings (key, payload, updated_at)
         VALUES ('setup_review', ?, ?)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(next), now);
    this.audit("setup_review.updated", next);
    this.writeAppConfig();
    return this.getSetupReviewSettings();
  }

  getPublicAccessSettings(): PublicAccessSettings {
    const row = this.db
      .query("SELECT key, payload, updated_at FROM runtime_settings WHERE key = 'public_access'")
      .get() as RuntimeSettingRow | null;
    const payload = row ? safeJsonParse<Partial<PublicAccessSettings>>(row.payload, {}) : {};
    return {
      provider: "cloudflare",
      mode: payload.mode === "remote" ? "remote" : "quick",
      publicUrl: payload.publicUrl ?? null,
      localServiceUrl: payload.localServiceUrl ?? "http://localhost:3011",
      tunnelName: payload.tunnelName ?? null,
      tunnelTokenConfigured: Boolean(payload.tunnelTokenConfigured),
      tunnelTokenPreview: payload.tunnelTokenPreview ?? null,
      accessProtected: Boolean(payload.accessProtected),
      updatedAt: payload.updatedAt ?? row?.updated_at ?? null
    };
  }

  updatePublicAccessSettings(input: Partial<PublicAccessSettings>): PublicAccessSettings {
    const current = this.getPublicAccessSettings();
    const now = nowIso();
    const next: PublicAccessSettings = {
      ...current,
      ...input,
      provider: "cloudflare",
      updatedAt: now
    };
    this.db
      .query(
        `INSERT INTO runtime_settings (key, payload, updated_at)
         VALUES ('public_access', ?, ?)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(next), now);
    this.audit("public_access.updated", {
      provider: next.provider,
      mode: next.mode,
      publicUrl: next.publicUrl,
      localServiceUrl: next.localServiceUrl,
      tunnelName: next.tunnelName,
      tunnelTokenConfigured: next.tunnelTokenConfigured,
      accessProtected: next.accessProtected
    });
    this.writeAppConfig();
    return this.getPublicAccessSettings();
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
public_access:
  provider: cloudflare
  mode: quick
  public_url: null
  local_service_url: http://localhost:3011
  access_protected: false
`;
  }

  private defaultConfigYaml(): string {
    const agents = this.listAgents();
    const channels = this.listChannelPolicies();
    const publicAccess = this.getPublicAccessSettings();
    const slackCollectionScope = this.getSlackCollectionScopeSettings();
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
public_access:
  provider: ${yamlValue(publicAccess.provider)}
  mode: ${yamlValue(publicAccess.mode)}
  public_url: ${yamlValue(publicAccess.publicUrl)}
  local_service_url: ${yamlValue(publicAccess.localServiceUrl)}
  access_protected: ${publicAccess.accessProtected}
slack_collection_scope:
  workspaces: ${yamlList(slackCollectionScope.workspaces)}
  workspace: ${yamlValue(slackCollectionScope.workspace)}
  channels: ${yamlList(slackCollectionScope.channels)}
  channel_thread_scopes:
${yamlStringRecord(slackCollectionScope.channelThreadScopes, "    ")}
  threads: ${yamlList(slackCollectionScope.threads)}
  mentions: ${yamlList(slackCollectionScope.mentions)}
  keywords: ${yamlList(slackCollectionScope.keywords)}
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
    this.db.run("DELETE FROM agents WHERE type <> 'openclaw'");
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
        category TEXT NOT NULL DEFAULT 'general',
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
    this.ensureTaskColumn("category", "TEXT NOT NULL DEFAULT 'general'");
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
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        owner_id TEXT,
        slack_user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id) REFERENCES owner_mappings(id) ON DELETE SET NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS user_profiles_ownerId_idx ON user_profiles(owner_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS user_profiles_slackUserId_idx ON user_profiles(slack_user_id)`);
    this.db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_memberOwner_unique
       ON user_profiles(owner_id)
       WHERE role = 'member' AND owner_id IS NOT NULL`
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS member_invitations (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        slack_user_id TEXT NOT NULL,
        email TEXT,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        accepted_user_id TEXT,
        created_by_user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (owner_id) REFERENCES owner_mappings(id) ON DELETE CASCADE,
        FOREIGN KEY (accepted_user_id) REFERENCES "user"(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS member_invitations_ownerId_idx ON member_invitations(owner_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS member_invitations_status_idx ON member_invitations(status)`);
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
      CREATE TABLE IF NOT EXISTS slack_collected_messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        collection_run_id TEXT,
        workspace_id TEXT,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        thread_ts TEXT,
        message_ts TEXT NOT NULL,
        user_id TEXT,
        user_name TEXT,
        text TEXT NOT NULL,
        permalink TEXT,
        bot_id TEXT,
        digest_id TEXT,
        collection_scope_source TEXT NOT NULL,
        thread_collection_mode TEXT NOT NULL,
        collection_scope TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        processed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);
    this.ensureColumn("slack_collected_messages", "collection_run_id", "TEXT");
    this.ensureColumn("slack_collected_messages", "processed_at", "TEXT");
    this.db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS slack_collected_messages_agentDedupe_unique
       ON slack_collected_messages(agent_id, dedupe_key)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS slack_collected_messages_source_idx
       ON slack_collected_messages(workspace_id, channel_id, thread_ts, message_ts)`
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slack_collection_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        digest_id TEXT,
        workspace_id TEXT,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        collection_trigger TEXT NOT NULL,
        collection_scope_source TEXT NOT NULL,
        thread_collection_mode TEXT NOT NULL,
        collection_scope TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        received_message_count INTEGER NOT NULL,
        parsed_message_count INTEGER NOT NULL,
        retained_message_count INTEGER NOT NULL,
        inserted_message_count INTEGER NOT NULL,
        duplicate_message_count INTEGER NOT NULL,
        candidate_count INTEGER NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS slack_collection_runs_agentStarted_idx ON slack_collection_runs(agent_id, started_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS slack_collection_runs_digest_idx ON slack_collection_runs(digest_id)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS assignment_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT,
        owner_id TEXT,
        owner_name TEXT,
        slack_user_id TEXT,
        status TEXT NOT NULL,
        round INTEGER NOT NULL,
        previous_request_id TEXT,
        requested_by TEXT,
        response_text TEXT,
        slack_message_ts TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        responded_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
        FOREIGN KEY (owner_id) REFERENCES owner_mappings(id) ON DELETE SET NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slack_task_candidates (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT,
        message_ts TEXT NOT NULL,
        source_ts TEXT NOT NULL,
        assignee_key TEXT NOT NULL,
        confirmation_target TEXT,
        confirmation_state TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);
    this.ensureColumn("slack_task_candidates", "source_ts", "TEXT");
    this.db.run("UPDATE slack_task_candidates SET source_ts = COALESCE(thread_ts, message_ts) WHERE source_ts IS NULL OR source_ts = ''");
    this.db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS slack_task_candidates_agentDedupe_unique
       ON slack_task_candidates(agent_id, dedupe_key)`
    );
    this.db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS slack_task_candidates_source_unique
       ON slack_task_candidates(agent_id, workspace_id, channel_id, source_ts, assignee_key)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS slack_task_candidates_source_idx
       ON slack_task_candidates(workspace_id, channel_id, source_ts, assignee_key)`
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slack_task_candidate_confirmations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        outbox_id TEXT,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT,
        message_ts TEXT NOT NULL,
        assignee_key TEXT NOT NULL,
        confirmation_target TEXT NOT NULL,
        confirmation_state TEXT NOT NULL,
        confirmation_action TEXT,
        selected_assignee TEXT,
        selected_classification TEXT,
        response_text TEXT,
        responded_at TEXT,
        dedupe_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (outbox_id) REFERENCES outbox(id) ON DELETE SET NULL
      )
    `);
    this.ensureColumn("slack_task_candidate_confirmations", "confirmation_action", "TEXT");
    this.ensureColumn("slack_task_candidate_confirmations", "selected_assignee", "TEXT");
    this.ensureColumn("slack_task_candidate_confirmations", "selected_classification", "TEXT");
    this.ensureColumn("slack_task_candidate_confirmations", "response_text", "TEXT");
    this.ensureColumn("slack_task_candidate_confirmations", "responded_at", "TEXT");
    this.db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS slack_task_candidate_confirmations_agentDedupe_unique
       ON slack_task_candidate_confirmations(agent_id, dedupe_key)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS slack_task_candidate_confirmations_source_idx
       ON slack_task_candidate_confirmations(workspace_id, channel_id, thread_ts, message_ts, assignee_key)`
    );
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
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runtime_settings (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.backfillFirstOwnerProfile();
    this.writeAppConfig();
  }

  private ensureTaskColumn(name: string, definition: string): void {
    this.ensureColumn("tasks", name, definition);
  }

  private ensureColumn(tableName: string, name: string, definition: string): void {
    const rows = this.db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === name)) return;
    this.db.run(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
  }

  private backfillFirstOwnerProfile(): void {
    const profileCount = this.db.query("SELECT count(*) AS count FROM user_profiles").get() as { count: number };
    if (profileCount.count > 0) return;

    const firstUser = this.db
      .query('SELECT id FROM "user" ORDER BY createdAt ASC LIMIT 1')
      .get() as { id: string } | null;
    if (!firstUser) return;

    const now = nowIso();
    this.db
      .query(
        `INSERT INTO user_profiles
         (user_id, role, owner_id, slack_user_id, created_at, updated_at)
         VALUES (?, 'owner', NULL, NULL, ?, ?)`
      )
      .run(firstUser.id, now, now);
    this.audit("user_profile.owner_backfilled", { userId: firstUser.id });
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
  const category = taskCategories.includes(row.category) ? row.category : "general";
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status,
    priority,
    category,
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

function userProfileFromRow(row: UserProfileRow): UserProfile {
  return {
    userId: row.user_id,
    role: userRoles.includes(row.role) ? row.role : "member",
    ownerId: row.owner_id,
    slackUserId: row.slack_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function memberInvitationFromRow(row: MemberInvitationRow): MemberInvitation {
  const statuses: MemberInvitationStatus[] = ["pending", "accepted", "revoked", "expired"];
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    slackUserId: row.slack_user_id,
    email: row.email,
    status: statuses.includes(row.status) ? row.status : "expired",
    expiresAt: row.expires_at,
    acceptedUserId: row.accepted_user_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at
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

function slackCollectedMessageFromRow(row: SlackCollectedMessageRow): SlackCollectedMessage {
  const threadCollectionMode = slackThreadCollectionModes.includes(row.thread_collection_mode)
    ? row.thread_collection_mode
    : "active_threads";
  const collectionScopeSource = row.collection_scope_source === "manual_override" ? "manual_override" : "saved";

  return {
    id: row.id,
    agentId: row.agent_id,
    collectionRunId: row.collection_run_id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    threadTs: row.thread_ts,
    messageTs: row.message_ts,
    userId: row.user_id,
    userName: row.user_name,
    text: row.text,
    permalink: row.permalink,
    botId: row.bot_id,
    digestId: row.digest_id,
    collectionScopeSource,
    threadCollectionMode,
    collectionScope: normalizeSlackCollectionScopeSettings(
      safeJsonParse<Partial<SlackCollectionScopeSettings>>(row.collection_scope, {})
    ),
    dedupeKey: row.dedupe_key,
    processedAt: row.processed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function slackCollectionRunFromRow(row: SlackCollectionRunRow): SlackCollectionRun {
  const collectionTrigger = slackCollectionTriggers.includes(row.collection_trigger as SlackCollectionTrigger)
    ? (row.collection_trigger as SlackCollectionTrigger)
    : "scheduled";
  const status = slackCollectionRunStatuses.includes(row.status as SlackCollectionRunStatus)
    ? (row.status as SlackCollectionRunStatus)
    : "completed";
  const threadCollectionMode = slackThreadCollectionModes.includes(row.thread_collection_mode)
    ? row.thread_collection_mode
    : "active_threads";
  const collectionScopeSource = row.collection_scope_source === "manual_override" ? "manual_override" : "saved";

  return {
    id: row.id,
    agentId: row.agent_id,
    digestId: row.digest_id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    collectionTrigger,
    collectionScopeSource,
    threadCollectionMode,
    collectionScope: normalizeSlackCollectionScopeSettings(
      safeJsonParse<Partial<SlackCollectionScopeSettings>>(row.collection_scope, {})
    ),
    status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    receivedMessageCount: row.received_message_count,
    parsedMessageCount: row.parsed_message_count,
    retainedMessageCount: row.retained_message_count,
    insertedMessageCount: row.inserted_message_count,
    duplicateMessageCount: row.duplicate_message_count,
    candidateCount: row.candidate_count,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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

function assignmentRequestFromRow(row: AssignmentRequestRow): AssignmentRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    slackUserId: row.slack_user_id,
    status: row.status,
    round: row.round,
    previousRequestId: row.previous_request_id,
    requestedBy: row.requested_by,
    responseText: row.response_text,
    slackMessageTs: row.slack_message_ts,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    respondedAt: row.responded_at
  };
}

function slackTaskCandidateConfirmationFromRow(
  row: SlackTaskCandidateConfirmationRequestRow
): SlackTaskCandidateConfirmationRequest {
  const confirmationState = slackConfirmationResponseStates.includes(
    row.confirmation_state as SlackTaskCandidateConfirmationRequest["confirmationState"]
  )
    ? (row.confirmation_state as SlackTaskCandidateConfirmationRequest["confirmationState"])
    : "proposed";
  const confirmationAction = slackConfirmationActions.includes(row.confirmation_action as SlackConfirmationAction)
    ? (row.confirmation_action as SlackConfirmationAction)
    : null;
  const selectedClassification = taskCategories.includes(row.selected_classification as TaskCategory)
    ? (row.selected_classification as TaskCategory)
    : null;

  return {
    id: row.id,
    agentId: row.agent_id,
    taskId: row.task_id,
    outboxId: row.outbox_id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    messageTs: row.message_ts,
    assigneeKey: row.assignee_key,
    confirmationTarget: row.confirmation_target,
    confirmationState,
    confirmationAction,
    selectedAssignee: row.selected_assignee,
    selectedClassification,
    responseText: row.response_text,
    respondedAt: row.responded_at,
    dedupeKey: row.dedupe_key,
    payload: safeJsonParse<SlackTaskCandidateMetadata>(row.payload, {
      candidateId: row.task_id,
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      threadTs: row.thread_ts,
      messageTs: row.message_ts,
      messageText: "",
      taskTitle: "",
      taskDescription: "",
      sourceChannel: {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        channelName: null,
        threadTs: row.thread_ts,
        messageTs: row.message_ts
      },
      sourceMessageLink: "",
      requester: row.confirmation_target,
      relevantContext: [],
      assignee: null,
      assigneeCandidates: [],
      leaderReviewer: null,
      confirmationTarget: row.confirmation_target,
      confirmationState: "proposed",
      dedupeKey: row.dedupe_key,
      dueAt: null,
      nextAction: null,
      sourceUrl: null,
      markdownPath: null
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function slackTaskCandidateFromRow(row: SlackTaskCandidateRow): SlackTaskCandidateRecord {
  const confirmationState = slackConfirmationResponseStates.includes(
    row.confirmation_state as SlackTaskCandidateRecord["confirmationState"]
  )
    ? (row.confirmation_state as SlackTaskCandidateRecord["confirmationState"])
    : "proposed";

  return {
    id: row.id,
    agentId: row.agent_id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    messageTs: row.message_ts,
    sourceTs: row.source_ts ?? row.thread_ts ?? row.message_ts,
    assigneeKey: row.assignee_key,
    confirmationTarget: row.confirmation_target,
    confirmationState,
    dedupeKey: row.dedupe_key,
    payload: safeJsonParse<SlackTaskCandidateMetadata>(row.payload, {
      candidateId: row.task_id,
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      threadTs: row.thread_ts,
      messageTs: row.message_ts,
      messageText: "",
      taskTitle: "",
      taskDescription: "",
      sourceChannel: {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        channelName: null,
        threadTs: row.thread_ts,
        messageTs: row.message_ts
      },
      sourceMessageLink: "",
      requester: row.confirmation_target ?? "",
      relevantContext: [],
      assignee: null,
      assigneeCandidates: [],
      leaderReviewer: null,
      confirmationTarget: row.confirmation_target ?? "",
      confirmationState,
      dedupeKey: row.dedupe_key,
      dueAt: null,
      nextAction: null,
      sourceUrl: null,
      markdownPath: null
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizePendingSlackTaskCandidate(
  candidate: SlackTaskCandidateMetadata | PendingSlackTaskCandidateMetadata
): SlackTaskCandidateMetadata {
  const sourceChannel = {
    workspaceId: candidate.sourceChannel.workspaceId || candidate.workspaceId || "unknown",
    channelId: candidate.sourceChannel.channelId || candidate.channelId || "",
    channelName: candidate.sourceChannel.channelName ?? null,
    threadTs: candidate.sourceChannel.threadTs ?? candidate.threadTs ?? null,
    messageTs: candidate.sourceChannel.messageTs || candidate.messageTs || candidate.candidateId
  };
  const workspaceId = candidate.workspaceId || sourceChannel.workspaceId;
  const channelId = candidate.channelId || sourceChannel.channelId;
  const messageTs = candidate.messageTs || sourceChannel.messageTs;
  const sourceMessageLink =
    candidate.sourceMessageLink ||
    candidate.sourceUrl ||
    slackTaskCandidateFallbackSourceMessageLink(sourceChannel.channelId, sourceChannel.messageTs) ||
    "";
  const sourceUrl = candidate.sourceUrl ?? (sourceMessageLink ? sourceMessageLink : null);
  const messageText = candidate.messageText || candidate.taskDescription || candidate.taskTitle;
  const assigneeResolution =
    candidate.assigneeResolution ??
    (candidate.assignee ? "assigned" : candidate.assigneeCandidates.length > 1 ? "ambiguous" : "unassigned");
  const requiresAssigneeConfirmation =
    candidate.requiresAssigneeConfirmation ?? (assigneeResolution !== "assigned" || !candidate.assignee);
  const relevantContext = candidate.relevantContext.length
    ? candidate.relevantContext
    : [messageText, candidate.taskDescription, sourceUrl ?? ""].filter((value) => value.trim());

  return {
    ...candidate,
    workspaceId,
    channelId,
    messageTs,
    messageText,
    sourceChannel,
    sourceMessageLink,
    requester: candidate.requester || "unknown",
    relevantContext,
    assigneeResolution,
    requiresAssigneeConfirmation,
    memberMappingUncertainties: candidate.memberMappingUncertainties ?? [],
    confirmationState: candidate.confirmationState ?? "proposed"
  };
}

function slackTaskCandidateFallbackSourceMessageLink(channelId: string, messageTs: string): string | null {
  if (!channelId || !messageTs) return null;
  const permalinkTs = messageTs.replace(".", "");
  return permalinkTs ? `https://slack.com/archives/${channelId}/p${permalinkTs}` : null;
}

function slackTaskCandidateSourceTs(candidate: SlackTaskCandidateMetadata): string {
  return candidate.threadTs ?? candidate.sourceChannel.threadTs ?? candidate.messageTs ?? candidate.sourceChannel.messageTs;
}

function defaultAgentName(type: AgentType): string {
  if (type !== "openclaw") {
    throw new Error(`Unsupported agent type: ${type}`);
  }
  return "OpenClaw";
}

function renderTaskMarkdown(task: Task): string {
  return `---
id: ${yamlValue(task.id)}
title: ${yamlValue(task.title)}
status: ${yamlValue(task.status)}
priority: ${yamlValue(task.priority)}
category: ${yamlValue(task.category)}
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

function assigneeKeyFromSlackTaskCandidateDedupeKey(dedupeKey: string): string | null {
  const parts = dedupeKey.split(":");
  return parts.length >= 5 ? parts.at(-1) ?? null : null;
}

function buildSlackDigestMessageClassifications(input: CreateSlackDigestInput): SlackTaskificationClassification[] {
  const threadCollectionMode = input.threadCollectionMode ?? (input.includeThreads === false ? "parent_messages" : "active_threads");
  return input.messages.flatMap((message) => {
    if (threadCollectionMode === "parent_messages" && isSlackThreadReply(message)) return [];
    const text = message.text.trim();
    if (!text) return [];
    const channelId = message.channelId ?? input.channelId;
    return [
      classifySlackTaskificationMessage(text, {
        workspaceId: message.workspaceId ?? input.workspaceId ?? null,
        channelId,
        threadTs: message.threadTs ?? message.parentTs ?? null,
        messageTs: message.ts,
        botId: message.botId ?? null
      })
    ];
  });
}

function buildSlackDigestCandidates(
  input: CreateSlackDigestInput,
  classifications = buildSlackDigestMessageClassifications(input)
): SlackDigestCandidate[] {
  const classificationByMessageTs = new Map(classifications.map((classification) => [classification.messageTs, classification]));
  const threadCollectionMode = input.threadCollectionMode ?? (input.includeThreads === false ? "parent_messages" : "active_threads");
  return input.messages.flatMap((message) => {
    if (message.botId) return [];
    if (threadCollectionMode === "parent_messages" && isSlackThreadReply(message)) return [];
    const text = message.text.trim();
    if (!text) return [];
    const workspaceId = message.workspaceId ?? input.workspaceId ?? null;
    const channelId = message.channelId ?? input.channelId;
    const channelName = message.channelName ?? input.channelName ?? null;
    const threadTs = message.threadTs ?? message.parentTs ?? null;
    const classification = classificationByMessageTs.get(message.ts) ?? classifySlackTaskificationMessage(text, {
      workspaceId,
      channelId,
      threadTs,
      messageTs: message.ts,
      botId: message.botId ?? null
    });
    if (!classification.qualifies && !classification.isWorkRelated) return [];
    const reason = classification.reason ?? classification.excludedReason ?? "work-related";
    const relevantThreadMessages = input.messages
      .filter((item) => (item.threadTs ?? item.parentTs ?? item.ts) === (threadTs ?? message.ts))
      .map((item) => {
        const parsed = { text: item.text, ts: item.ts } as { text: string; ts: string; userId?: string; botId?: string };
        if (item.userId) parsed.userId = item.userId;
        if (item.botId) parsed.botId = item.botId;
        return parsed;
      });
    const content = deriveSlackTaskCandidateContent({
      messageText: text,
      contextMessages: relevantThreadMessages,
      channelName,
      channelId,
      requester: message.userId ?? message.userName ?? null,
      sourceUrl: message.permalink ?? null,
      reason
    });
    const assigneeSlackUserIds = slackDigestCandidateAssigneeSlackUserIds(classification.assigneeCandidates);
    return assigneeSlackUserIds.map((assigneeSlackUserId) => ({
      id: newId("cand"),
      workspaceId: classification.workspaceId,
      channelId,
      channelName,
      ts: message.ts,
      threadTs,
      userId: message.userId ?? null,
      userName: message.userName ?? null,
      text,
      taskTitle: content.title,
      taskDescription: content.description,
      dueAt: content.dueAt,
      nextAction: content.nextAction,
      relevantContext: content.relevantContext,
      permalink: message.permalink ?? null,
      sourceChannel: {
        workspaceId: classification.workspaceId ?? workspaceId ?? "unknown",
        channelId,
        channelName,
        threadTs,
        messageTs: message.ts
      },
      sourceMessageLink: message.permalink ?? "",
      requester: message.userId ?? message.userName ?? "unknown",
      assigneeCandidates: classification.assigneeCandidates,
      assignee: null,
      assigneeSlackUserId,
      assigneeResolution: classification.assigneeResolution,
      requiresAssigneeConfirmation: classification.requiresAssigneeConfirmation,
      memberMappingUncertainties: [],
      reason,
      classification
    }));
  });
}

function buildSlackDigestTaskDedupeKey(candidate: SlackDigestCandidate): string {
  return `slack:${candidate.workspaceId ?? "unknown"}:${candidate.channelId}:${candidate.threadTs ?? candidate.ts}:${candidate.assigneeSlackUserId ?? "unassigned"}`;
}

function resolveSlackDigestCandidateAssignee(
  store: { resolveOwner(value: string | null): OwnerMapping | null },
  candidate: SlackDigestCandidate
): OwnerMapping | null {
  return candidate.assigneeSlackUserId ? store.resolveOwner(candidate.assigneeSlackUserId) : null;
}

function slackDigestCandidateAssigneeSlackUserIds(assigneeCandidates: string[]): Array<string | null> {
  return assigneeCandidates.length ? assigneeCandidates : [null];
}

function buildSlackCollectedMessageDedupeKey(input: CreateSlackDigestInput, message: SlackDigestMessageInput): string {
  const workspaceId = message.workspaceId ?? input.workspaceId ?? "unknown";
  const channelId = message.channelId ?? input.channelId;
  const threadTs = message.threadTs ?? message.parentTs ?? message.ts;
  return `slackmsg:${workspaceId}:${channelId}:${threadTs}:${message.ts}`;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isSlackThreadReply(message: SlackDigestMessageInput): boolean {
  const parentTs = message.parentTs ?? message.threadTs ?? null;
  return Boolean(parentTs && parentTs !== message.ts);
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

function stringOrNull(value: unknown): string | null {
  return stringValue(value) ?? null;
}

function isSlackWorkspaceId(value: string): boolean {
  return /^[TE][A-Z0-9]{2,}$/.test(value);
}

function normalizeSlackWorkspaceChannels(channels: unknown): SlackWorkspaceChannel[] {
  if (!Array.isArray(channels)) return [];
  return mergeSlackWorkspaceChannels([], channels);
}

function slackWorkspaceChannelsFromInput(input: SlackWorkspaceConnectionInput, seenAt: string): SlackWorkspaceChannel[] {
  const channels = normalizeSlackWorkspaceChannels(input.channels);
  const channelId = stringValue(input.channelId);
  if (channelId && isSlackChannelId(channelId)) {
    channels.push({
      channelId,
      channelName: stringOrNull(input.channelName),
      lastSeenAt: seenAt
    });
  }
  return mergeSlackWorkspaceChannels([], channels);
}

function mergeSlackWorkspaceChannels(
  existing: Array<Partial<SlackWorkspaceChannel>>,
  incoming: Array<Partial<SlackWorkspaceChannel>>
): SlackWorkspaceChannel[] {
  const byChannel = new Map<string, SlackWorkspaceChannel>();
  const observedOrder = new Map<string, number>();
  for (const [index, channel] of [...existing, ...incoming].entries()) {
    const channelId = stringValue(channel.channelId);
    if (!channelId || !isSlackChannelId(channelId)) continue;
    const previous = byChannel.get(channelId);
    byChannel.set(channelId, {
      channelId,
      channelName: stringOrNull(channel.channelName) ?? previous?.channelName ?? null,
      lastSeenAt: stringOrNull(channel.lastSeenAt) ?? previous?.lastSeenAt ?? null
    });
    observedOrder.set(channelId, index);
  }
  return Array.from(byChannel.values()).sort((a, b) => {
    const aSeen = a.lastSeenAt ?? "";
    const bSeen = b.lastSeenAt ?? "";
    if (aSeen !== bSeen) return bSeen.localeCompare(aSeen);
    const orderDelta = (observedOrder.get(b.channelId) ?? 0) - (observedOrder.get(a.channelId) ?? 0);
    if (orderDelta !== 0) return orderDelta;
    return a.channelId.localeCompare(b.channelId);
  });
}

function isSlackChannelId(value: string): boolean {
  return /^[CGD][A-Z0-9]{2,}$/.test(value);
}

function renderSlackCandidateDescription(candidate: SlackDigestCandidate): string {
  const lines = [
    candidate.taskDescription || "Slack digest candidate:",
    "",
    `- Candidate: ${candidate.id}`,
    `- Workspace: ${candidate.workspaceId ?? "unknown"}`,
    `- Channel: ${candidate.channelName ? `#${candidate.channelName}` : candidate.channelId}`,
    `- User: ${candidate.userName ?? candidate.userId ?? "unknown"}`,
    `- Reason: ${candidate.reason}`,
    `- Timestamp: ${candidate.ts}`
  ];
  if (candidate.dueAt) lines.push(`- Due: ${candidate.dueAt}`);
  if (candidate.nextAction) lines.push(`- Next action: ${candidate.nextAction}`);
  if (candidate.permalink) lines.push(`- Source: ${candidate.permalink}`);
  if (!candidate.taskDescription) lines.push("", candidate.text);
  return lines.join("\n");
}

function yamlValue(value: string | null | boolean): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

function yamlList(values: string[]): string {
  return values.length ? `[${values.map((value) => yamlValue(value)).join(", ")}]` : "[]";
}

function yamlStringRecord(values: Record<string, string>, indent = "  "): string {
  const entries = Object.entries(values);
  if (!entries.length) return `${indent}{}`;
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${indent}${key}: ${yamlValue(value)}`)
    .join("\n");
}
