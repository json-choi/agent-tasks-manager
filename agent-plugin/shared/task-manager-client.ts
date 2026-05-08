import { existsSync, readFileSync } from "node:fs";
import {
  classifySlackTaskificationMessage,
  hasMentionTaskificationIntent as hasQualifiedMentionTaskificationIntent,
  qualifySlackTaskificationMessage
} from "../../src/shared/slack-qualification";
import type { SlackTaskAssigneeResolution } from "../../src/shared/slack-qualification";

export interface TaskManagerClientOptions {
  apiUrl: string;
  agentId: string;
  token: string;
  slackTaskificationPath?: string;
  fetchImpl?: typeof fetch;
}

export class TaskManagerApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly traceId: string | null;
  readonly responseBody: unknown;

  constructor(message: string, input: { status: number; path: string; traceId?: string | null; responseBody?: unknown }) {
    super(message);
    this.name = "TaskManagerApiError";
    this.status = input.status;
    this.path = input.path;
    this.traceId = input.traceId ?? null;
    this.responseBody = input.responseBody;
  }
}

export interface SlackMessageContext {
  workspaceId?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  threadTs?: string | null;
  messageTs?: string | null;
  authorId?: string | null;
  authorName?: string | null;
  permalink?: string | null;
  agentName?: string | null;
  messages?: Array<{
    userId?: string;
    botId?: string;
    text: string;
    ts?: string;
  }>;
}

export type TaskCommand =
  | { type: "propose"; assigneeId: string | null }
  | { type: "ask_assignee"; taskId: string | null; assigneeId: string | null }
  | { type: "status"; taskId: string | null; signal: string }
  | { type: "today"; assigneeId: string | null }
  | { type: "none" };

export type SlackTaskCommandSource = "slash_command" | "app_mention" | "message_mention" | "message";

export interface TaskCommandContext {
  eventType?: string | null;
  agentUserId?: string | null;
  botUserId?: string | null;
  addressedUserIds?: Array<string | null | undefined> | null;
}

export interface SlackTaskificationPayload {
  text?: string | null;
  eventType?: string | null;
  workspaceId?: string | null;
  teamId?: string | null;
  userId?: string | null;
  userName?: string | null;
  botId?: string | null;
  botUserId?: string | null;
  agentUserId?: string | null;
  addressedUserIds?: Array<string | null | undefined> | null;
  channelId?: string | null;
  channelName?: string | null;
  messageTs?: string | null;
  threadTs?: string | null;
  permalink?: string | null;
}

export interface SlackTaskificationRequest {
  command: Exclude<TaskCommand, { type: "none" }>;
  source: SlackTaskCommandSource;
  workspaceId: string | null;
  channelId: string | null;
  channelName: string | null;
  threadTs: string | null;
  messageTs: string | null;
  messageText: string;
  reporterId: string | null;
  reporterName: string | null;
  sourceUrl: string | null;
  assigneeCandidates: string[];
  assigneeResolution: SlackTaskAssigneeResolution;
  requiresAssigneeConfirmation: boolean;
  primaryAssigneeId: string | null;
  context: SlackMessageContext;
}

export interface ATMTaskificationMetadata {
  workspaceId: string | null;
  channelId: string | null;
  threadTs: string | null;
  messageTs: string | null;
  messageText: string;
  source: SlackTaskCommandSource;
  isWorkRelated: boolean;
  taskTitle: string;
  taskDescription: string;
  assignee: string | null;
  assigneeCandidates: string[];
  assigneeResolution: SlackTaskAssigneeResolution;
  requiresAssigneeConfirmation: boolean;
  leaderReviewer: string | null;
  confirmationTarget: string | null;
  confirmationState: "proposed" | "assigning";
  confirmationAction: null;
  dedupeKey: string | null;
  dueAt: string | null;
  nextAction: string | null;
  sourceUrl: string | null;
  markdownPath: null;
}

export interface ATMTaskificationRequest {
  context: SlackMessageContext;
  intakeTraceId?: string;
  source: SlackTaskCommandSource;
  workspaceId: string | null;
  channelId: string | null;
  threadTs: string | null;
  messageTs: string | null;
  messageText: string;
  title: string;
  description: string;
  assignee?: string;
  assigneeCandidates: string[];
  assigneeResolution: SlackTaskAssigneeResolution;
  requiresAssigneeConfirmation: boolean;
  reporter?: string;
  sourceUrl?: string;
  priority?: "P0" | "P1" | "P2";
  nextAction?: string;
  dueAt?: string;
  confirmationState: "proposed" | "assigning";
  dedupeKey: string | null;
  confirmed: boolean;
  automatic: boolean;
  taskification: ATMTaskificationMetadata;
  taskificationMetadata: ATMTaskificationMetadata;
}

export interface SlackCollectionScopeSettings {
  workspace: string | null;
  workspaces: string[];
  channels: string[];
  channelThreadScopes: Record<string, "parent_messages" | "active_threads" | "full_thread_history">;
  threads: string[];
  mentions: string[];
  keywords: string[];
  updatedAt: string | null;
}

export interface SlackCollectionScopeValidation {
  invalid: Record<string, string[]>;
  duplicates: Record<string, string[]>;
  saved: Record<string, string[]>;
  hasInvalid: boolean;
  hasDuplicates: boolean;
}

export interface SlackCollectionScopeSchema {
  version: "slack_collection_scope.v1";
  supportedTriggers: readonly ["manual", "scheduled"];
  defaults: SlackCollectionScopeSettings;
  fields: Record<string, Record<string, unknown>>;
  scheduledTarget: {
    expansion: string;
    emptyWorkspaces: string;
    defaultThreadCollectionMode: SlackCollectionTarget["threadCollectionMode"];
    cursorKey: string;
  };
}

export interface SlackCollectionTarget {
  workspaceId: string | null;
  channelId: string;
  threadCollectionMode: "parent_messages" | "active_threads" | "full_thread_history";
  cursor: {
    agentId: string;
    channelId: string;
    lastTs: string;
    lastScannedAt: string;
    includeThreads: boolean;
  } | null;
}

export interface SlackUnprocessedCollectedMessage {
  message: Record<string, unknown>;
  collectionRun: Record<string, unknown> | null;
}

export class TaskManagerClient {
  private readonly apiUrl: string;
  private readonly agentId: string;
  private readonly token: string;
  private readonly slackTaskificationPath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TaskManagerClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.agentId = options.agentId;
    this.token = options.token;
    this.slackTaskificationPath = normalizeApiPath(options.slackTaskificationPath, "/api/agent/task/propose");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  connectTest(payload: Record<string, unknown> = {}) {
    return this.request("/api/agent/connect/test", { method: "POST", body: payload });
  }

  captureThread(context: SlackMessageContext) {
    return this.request("/api/agent/thread/capture", { method: "POST", body: context });
  }

  proposeTask(input: {
    context: SlackMessageContext;
    intakeTraceId?: string;
    source?: SlackTaskCommandSource;
    workspaceId?: string | null;
    channelId?: string | null;
    threadTs?: string | null;
    messageTs?: string | null;
    messageText?: string;
    title?: string;
    description?: string;
    assignee?: string;
    assigneeCandidates?: string[];
    assigneeResolution?: SlackTaskAssigneeResolution;
    requiresAssigneeConfirmation?: boolean;
    reporter?: string;
    sourceUrl?: string;
    priority?: "P0" | "P1" | "P2";
    category?: "general" | "coding";
    initiative?: string;
    nextAction?: string;
    githubRef?: string;
    dueAt?: string;
    confirmationState?: "proposed" | "assigning";
    dedupeKey?: string | null;
    confirmed?: boolean;
    automatic?: boolean;
    taskification?: ATMTaskificationMetadata;
    taskificationMetadata?: ATMTaskificationMetadata;
  }) {
    const intakeTraceId = input.intakeTraceId ?? createIntakeTraceId(input.dedupeKey);
    return this.request(this.slackTaskificationPath, {
      method: "POST",
      body: { ...input, intakeTraceId },
      traceId: intakeTraceId
    });
  }

  askAssignee(taskId: string, assigneeId?: string | null) {
    return this.request(`/api/agent/task/${encodeURIComponent(taskId)}/ask-assignee`, {
      method: "POST",
      body: { assigneeId }
    });
  }

  assignmentRequest(taskId: string, input: {
    ownerId?: string | null;
    assigneeId?: string | null;
    assignee?: string | null;
    previousRequestId?: string | null;
    requestedBy?: string | null;
  }) {
    return this.request(`/api/agent/task/${encodeURIComponent(taskId)}/assignment-request`, {
      method: "POST",
      body: input
    });
  }

  assignmentResponse(taskId: string, accepted: boolean, assigneeId?: string | null, text?: string) {
    return this.request(`/api/agent/task/${encodeURIComponent(taskId)}/assignment-response`, {
      method: "POST",
      body: { accepted, assigneeId, text }
    });
  }

  statusSignal(taskId: string, signal: string, confidence = 1, requireConfirmation = false) {
    return this.request(`/api/agent/task/${encodeURIComponent(taskId)}/status-signal`, {
      method: "POST",
      body: { signal, confidence, requireConfirmation }
    });
  }

  slackInteraction(payload: unknown) {
    return this.request("/api/agent/slack/interaction", {
      method: "POST",
      body: payload
    });
  }

  owners() {
    return this.request("/api/agent/owners", { method: "GET" });
  }

  today(assigneeId?: string | null, channelId?: string | null, threadTs?: string | null) {
    const params = new URLSearchParams();
    if (assigneeId) params.set("assignee", assigneeId);
    if (channelId) params.set("channelId", channelId);
    if (threadTs) params.set("threadTs", threadTs);
    return this.request(`/api/agent/tasks/today?${params.toString()}`, { method: "GET" });
  }

  collectSlackDigest(input: {
    channelId: string;
    workspaceId?: string | null;
    workspaceName?: string | null;
    channelName?: string | null;
    messages: Array<Record<string, unknown>>;
    nextLastTs?: string | null;
    includeThreads?: boolean;
    threadCollectionMode?: "parent_messages" | "active_threads" | "full_thread_history";
    collectionScope?: Partial<SlackCollectionScopeSettings>;
    collectionScopeOverrides?: Partial<SlackCollectionScopeSettings>;
  }) {
    return this.request("/api/agent/slack/digest/collect", { method: "POST", body: input });
  }

  slackCollectionScope(): Promise<{
    ok: true;
    collectionScope: SlackCollectionScopeSettings;
    collectionScopeSchema?: SlackCollectionScopeSchema;
    validation?: SlackCollectionScopeValidation;
    collectionReady?: boolean;
    targets: SlackCollectionTarget[];
  }> {
    return this.request("/api/agent/slack/collection-scope", { method: "GET" });
  }

  commitSlackDigest(input: {
    digestId: string;
    selectedCandidateIds?: string[];
    createTasks?: boolean;
  }) {
    return this.request("/api/agent/slack/digest/commit", { method: "POST", body: input });
  }

  unprocessedSlackMessages(input: {
    workspaceId?: string | null;
    teamId?: string | null;
    channelId?: string | null;
    collectionRunId?: string | null;
    digestId?: string | null;
    limit?: number;
  } = {}): Promise<{ ok: true; count: number; messages: SlackUnprocessedCollectedMessage[] }> {
    const params = new URLSearchParams();
    if (input.workspaceId) params.set("workspaceId", input.workspaceId);
    if (input.teamId) params.set("teamId", input.teamId);
    if (input.channelId) params.set("channelId", input.channelId);
    if (input.collectionRunId) params.set("collectionRunId", input.collectionRunId);
    if (input.digestId) params.set("digestId", input.digestId);
    if (input.limit) params.set("limit", String(input.limit));
    const suffix = params.toString();
    return this.request(`/api/agent/slack/messages/unprocessed${suffix ? `?${suffix}` : ""}`, { method: "GET" });
  }

  taskCards(owner?: string | null, channelId?: string | null, threadTs?: string | null, scope = "all") {
    const params = new URLSearchParams();
    if (owner) params.set("owner", owner);
    if (channelId) params.set("channelId", channelId);
    if (threadTs) params.set("threadTs", threadTs);
    params.set("scope", scope);
    return this.request(`/api/agent/tasks/cards?${params.toString()}`, { method: "GET" });
  }

  dailyDigest(owner?: string | null, enqueue = true) {
    return this.request("/api/agent/tasks/daily-digest", {
      method: "POST",
      body: { owner, enqueue }
    });
  }

  getOutbox(limit = 25) {
    return this.request(`/api/agent/outbox?limit=${limit}`, { method: "GET" });
  }

  ackOutbox(id: string) {
    return this.request(`/api/agent/outbox/${encodeURIComponent(id)}/ack`, {
      method: "POST",
      body: {}
    });
  }

  private async request(path: string, options: { method: string; body?: unknown; traceId?: string | null }) {
    const init: RequestInit = {
      method: options.method,
      headers: {
        "content-type": "application/json",
        "x-agent-id": this.agentId,
        authorization: `Bearer ${this.token}`
      }
    };
    if (options.traceId) {
      (init.headers as Record<string, string>)["x-atm-intake-trace-id"] = options.traceId;
    }
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    const response = await this.fetchImpl(`${this.apiUrl}${path}`, init);

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof data.error === "string" ? data.error : response.statusText;
      const traceId =
        typeof data.intakeTraceId === "string"
          ? data.intakeTraceId
          : typeof data.traceId === "string"
            ? data.traceId
            : (options.traceId ?? null);
      throw new TaskManagerApiError(`Task Manager API failed: ${message}`, {
        status: response.status,
        path,
        traceId,
        responseBody: data
      });
    }

    return data;
  }
}

export function createIntakeTraceId(dedupeKey?: string | null): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  const source = dedupeKey ? dedupeKey.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") : "slack";
  return `atm_intake_${Date.now().toString(36)}_${source.slice(0, 48)}_${suffix}`;
}

export function clientFromEnv(fetchImpl?: typeof fetch, envFilePath?: string): TaskManagerClient {
  const envFile = envFilePath ? readEnvFile(envFilePath) : {};
  const apiUrl = process.env.TASK_MANAGER_API_URL ?? envFile.TASK_MANAGER_API_URL;
  const agentId = process.env.TASK_MANAGER_AGENT_ID ?? envFile.TASK_MANAGER_AGENT_ID;
  const token = process.env.TASK_MANAGER_API_TOKEN ?? envFile.TASK_MANAGER_API_TOKEN;
  const slackTaskificationPath =
    process.env.TASK_MANAGER_SLACK_TASKIFICATION_PATH ?? envFile.TASK_MANAGER_SLACK_TASKIFICATION_PATH;

  if (!apiUrl || !agentId || !token) {
    throw new Error(
      "TASK_MANAGER_API_URL, TASK_MANAGER_AGENT_ID, and TASK_MANAGER_API_TOKEN are required in the environment or task-manager.env"
    );
  }

  const options: TaskManagerClientOptions = { apiUrl, agentId, token };
  if (slackTaskificationPath) options.slackTaskificationPath = slackTaskificationPath;
  if (fetchImpl) options.fetchImpl = fetchImpl;
  return new TaskManagerClient(options);
}

function normalizeApiPath(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;

  try {
    const url = new URL(trimmed);
    return `${url.pathname}${url.search}`;
  } catch {
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  }
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};

  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .reduce<Record<string, string>>((env, line) => {
      const [key, ...valueParts] = line.split("=");
      if (!key || valueParts.length === 0) return env;
      env[key] = valueParts.join("=").replace(/^["']|["']$/g, "");
      return env;
    }, {});
}

export function classifyTaskCommand(text: string, context: TaskCommandContext = {}): TaskCommand {
  const normalized = text.trim().toLowerCase();
  const taskId = extractTaskId(text);
  const addressedUserIds = taskCommandAddressedUserIds(context);
  const assigneeId = extractMention(text, addressedUserIds);
  const isMentionEvent = context.eventType === "app_mention" || containsAnyMention(text, addressedUserIds);

  if (!normalized) return { type: "none" };
  if (normalized.includes("오늘 내 할 일") || normalized.includes("today my tasks")) {
    return { type: "today", assigneeId };
  }
  if (normalized.includes("담당자 물어봐") || normalized.includes("ask assignee")) {
    return { type: "ask_assignee", taskId, assigneeId };
  }
  if (normalized.includes("상태 업데이트") || normalized.includes("status update")) {
    return { type: "status", taskId, signal: "review_needed" };
  }
  if (normalized.includes("완료") || normalized.includes("done") || normalized.includes("complete")) {
    return { type: "status", taskId, signal: "done" };
  }
  if (
    normalized.startsWith("/task") ||
    normalized.includes("태스크로 만들어줘") ||
    normalized.includes("태스크로 만들어") ||
    normalized.includes("스레드 태스크로 정리해줘") ||
    normalized.includes("태스크로 정리") ||
    normalized.includes("태스크에 넣어") ||
    normalized.includes("태스크 넣어") ||
    normalized.includes("태스크 추가") ||
    normalized.includes("태스크 등록") ||
    normalized.includes("할 일로 넣어") ||
    normalized.includes("업무로 넣어") ||
    normalized.includes("make this a task") ||
    normalized.includes("turn this into a task") ||
    normalized.includes("create a task") ||
    normalized.includes("add a task") ||
    normalized.includes("taskify")
  ) {
    return { type: "propose", assigneeId };
  }

  if (isMentionEvent && hasQualifiedMentionTaskificationIntent(normalized)) {
    return { type: "propose", assigneeId };
  }

  if (hasConversationalTaskificationIntent(text, addressedUserIds)) {
    return { type: "propose", assigneeId };
  }

  return { type: "none" };
}

export function parseSlackTaskificationRequest(
  payload: SlackTaskificationPayload,
  context: TaskCommandContext = {}
): SlackTaskificationRequest | null {
  if (payload.botId) return null;

  const text = payload.text?.trim() ?? "";
  if (!text) return null;

  const commandContext: TaskCommandContext = { ...context };
  const eventType = context.eventType ?? payload.eventType;
  const agentUserId = context.agentUserId ?? payload.agentUserId;
  const botUserId = context.botUserId ?? payload.botUserId;
  const requestedAddressedUserIds = context.addressedUserIds ?? payload.addressedUserIds;
  if (eventType !== undefined) commandContext.eventType = eventType;
  if (agentUserId !== undefined) commandContext.agentUserId = agentUserId;
  if (botUserId !== undefined) commandContext.botUserId = botUserId;
  if (requestedAddressedUserIds !== undefined) commandContext.addressedUserIds = requestedAddressedUserIds;
  const command = classifyTaskCommand(text, commandContext);
  if (command.type === "none") return null;

  const addressedUserIds = taskCommandAddressedUserIds(commandContext);
  const assigneeCandidates = extractMentions(text, addressedUserIds);
  const messageTs = payload.messageTs ?? null;
  const threadTs = payload.threadTs ?? messageTs;
  const workspaceId = payload.workspaceId ?? payload.teamId ?? null;
  const classification = classifySlackTaskificationMessage(text, {
    workspaceId,
    channelId: payload.channelId ?? null,
    threadTs,
    messageTs,
    addressedUserIds
  });
  const slackMessage: NonNullable<SlackMessageContext["messages"]>[number] = { text };
  if (payload.userId) slackMessage.userId = payload.userId;
  if (payload.botId) slackMessage.botId = payload.botId;
  if (messageTs) slackMessage.ts = messageTs;

  return {
    command,
    source: slackTaskCommandSource(text, commandContext, addressedUserIds),
    workspaceId,
    channelId: payload.channelId ?? null,
    channelName: payload.channelName ?? null,
    threadTs,
    messageTs,
    messageText: text,
    reporterId: payload.userId ?? null,
    reporterName: payload.userName ?? null,
    sourceUrl: payload.permalink ?? null,
    assigneeCandidates,
    assigneeResolution: classification.assigneeResolution,
    requiresAssigneeConfirmation: classification.requiresAssigneeConfirmation,
    primaryAssigneeId: "assigneeId" in command ? command.assigneeId : null,
    context: {
      workspaceId,
      channelId: payload.channelId ?? null,
      channelName: payload.channelName ?? null,
      threadTs,
      messageTs,
      authorId: payload.userId ?? null,
      authorName: payload.userName ?? null,
      permalink: payload.permalink ?? null,
      messages: [slackMessage]
    }
  };
}

export function normalizeSlackTaskificationRequest(request: SlackTaskificationRequest): ATMTaskificationRequest[] {
  if (request.command.type !== "propose") return [];

  const assigneeIds = request.assigneeCandidates.length
    ? request.assigneeCandidates
    : request.primaryAssigneeId
      ? [request.primaryAssigneeId]
      : [null];
  const uniqueAssigneeIds = Array.from(new Set(assigneeIds));
  const title = taskTitleFromSlackRequest(request);
  const description = taskDescriptionFromSlackRequest(request, title);
  const priority = inferSlackTaskificationPriority(request.messageText);
  const dueAt = inferSlackTaskificationDueAt(request.messageText);
  const nextAction = inferSlackTaskificationNextAction(request.messageText);

  return uniqueAssigneeIds.map((assigneeId) => {
    const context: SlackMessageContext = { ...request.context };
    if (request.context.messages) context.messages = request.context.messages.map((message) => ({ ...message }));
    const confirmationState = assigneeId ? "proposed" : "assigning";
    const dedupeKey = buildSlackTaskificationDedupeKey(request, assigneeId);
    const taskification: ATMTaskificationMetadata = {
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      threadTs: request.threadTs,
      messageTs: request.messageTs,
      messageText: request.messageText,
      source: request.source,
      isWorkRelated: true,
      taskTitle: title,
      taskDescription: description,
      assignee: assigneeId,
      assigneeCandidates: request.assigneeCandidates,
      assigneeResolution: request.assigneeResolution,
      requiresAssigneeConfirmation: request.requiresAssigneeConfirmation,
      leaderReviewer: request.reporterId,
      confirmationTarget: request.reporterId ?? assigneeId,
      confirmationState,
      confirmationAction: null,
      dedupeKey,
      dueAt: dueAt ?? null,
      nextAction: nextAction ?? null,
      sourceUrl: request.sourceUrl,
      markdownPath: null
    };
    const normalized: ATMTaskificationRequest = {
      context,
      source: request.source,
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      threadTs: request.threadTs,
      messageTs: request.messageTs,
      messageText: request.messageText,
      title,
      description,
      assigneeCandidates: request.assigneeCandidates,
      assigneeResolution: request.assigneeResolution,
      requiresAssigneeConfirmation: request.requiresAssigneeConfirmation,
      priority,
      confirmationState,
      dedupeKey,
      confirmed: false,
      automatic: request.source === "message",
      taskification,
      taskificationMetadata: taskification
    };
    if (assigneeId) normalized.assignee = assigneeId;
    if (request.reporterId) normalized.reporter = request.reporterId;
    if (request.sourceUrl) normalized.sourceUrl = request.sourceUrl;
    if (nextAction) normalized.nextAction = nextAction;
    if (dueAt) normalized.dueAt = dueAt;
    return normalized;
  });
}

export function extractTaskId(text: string): string | null {
  return /\btask_[a-z0-9_]+\b/i.exec(text)?.[0] ?? null;
}

function buildSlackTaskificationDedupeKey(request: SlackTaskificationRequest, assigneeId: string | null): string | null {
  const sourceTs = request.threadTs ?? request.messageTs;
  if (!request.channelId || !sourceTs) return null;
  return `slack:${request.workspaceId ?? "unknown"}:${request.channelId}:${sourceTs}:${assigneeId ?? "unassigned"}`;
}

export function extractMention(text: string, ignoredUserIds: Iterable<string | null | undefined> = []): string | null {
  return extractMentions(text, ignoredUserIds)[0] ?? null;
}

export function extractMentions(text: string, ignoredUserIds: Iterable<string | null | undefined> = []): string[] {
  const ignored = new Set(
    [...ignoredUserIds]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toUpperCase())
  );
  const seen = new Set<string>();
  const userIds: string[] = [];
  const matches = text.matchAll(/<@([A-Z0-9]+)>/gi);
  for (const match of matches) {
    const userId = match[1];
    const normalized = userId?.toUpperCase();
    if (userId && normalized && !ignored.has(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      userIds.push(userId);
    }
  }
  return userIds;
}

function taskCommandAddressedUserIds(context: TaskCommandContext): string[] {
  return [context.agentUserId, context.botUserId, ...(context.addressedUserIds ?? [])]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toUpperCase());
}

function containsAnyMention(text: string, userIds: string[]): boolean {
  if (userIds.length === 0) return false;
  const mentioned = new Set([...text.matchAll(/<@([A-Z0-9]+)>/gi)].map((match) => match[1]?.toUpperCase()).filter(Boolean));
  return userIds.some((userId) => mentioned.has(userId));
}

function hasConversationalTaskificationIntent(text: string, addressedUserIds: string[]): boolean {
  return qualifySlackTaskificationMessage(text, { addressedUserIds }).qualifies;
}

function slackTaskCommandSource(
  text: string,
  context: TaskCommandContext,
  addressedUserIds: string[]
): SlackTaskCommandSource {
  if (text.trim().startsWith("/")) return "slash_command";
  if (context.eventType === "app_mention") return "app_mention";
  if (containsAnyMention(text, addressedUserIds)) return "message_mention";
  return "message";
}

function taskTitleFromSlackRequest(request: SlackTaskificationRequest): string {
  const title = stripTaskificationCommandText(request.messageText, request.assigneeCandidates);
  return compactTaskificationText(title, 96) || fallbackSlackTaskTitle(request);
}

function taskDescriptionFromSlackRequest(request: SlackTaskificationRequest, title: string): string {
  const source = request.sourceUrl ? `\n\nSource: ${request.sourceUrl}` : "";
  return `Slack taskification request:\n\n${title}\n\nOriginal message:\n${request.messageText}${source}`;
}

function stripTaskificationCommandText(text: string, assigneeCandidates: string[]): string {
  const withoutMentions = text
    .replace(/<@[A-Z0-9]+>/gi, " ")
    .replace(/^\/task\b/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  const colonMatch = /^(.{0,120})(?:태스크|task|todo|할 일|업무|action item|follow[- ]?up|담당|assign|owner|for).*:\s*(.+)$/i.exec(withoutMentions);
  const commandless = colonMatch?.[2] ?? withoutMentions;
  const assigneePattern = assigneeCandidates.length ? assigneeCandidates.map(escapeRegExp).join("|") : null;
  const cleaned = commandless
    .replace(/\b(taskify|make|turn|convert|create|add|log|file|open)\b.{0,25}\b(task|todo|to-do|follow[ -]?up|action item)\b/gi, " ")
    .replace(/\b(make|turn|convert)\s+this\s+into\s+a\s+task\b/gi, " ")
    .replace(/\b(taskify|create a task|add a task|make this a task|turn this into a task)\b/gi, " ")
    .replace(/태스크.{0,12}(만들|추가|등록|정리)|할 일.{0,12}(넣|추가|등록)|업무.{0,12}(넣|추가|등록)/g, " ");
  const withoutAssigneeNames = assigneePattern
    ? cleaned.replace(new RegExp(`\\b(?:for|to|owner|assign(?:ed)? to)\\s+(?:${assigneePattern})\\b`, "gi"), " ")
    : cleaned;
  return withoutAssigneeNames
    .replace(/\s+/g, " ")
    .replace(/^[-:;,.]\s*/, "")
    .replace(/^(?:can|could|would|will|please|pls)\s+(?:you\s+)?/i, "")
    .trim();
}

function fallbackSlackTaskTitle(request: SlackTaskificationRequest): string {
  if (request.channelName) return `Task from #${request.channelName}`;
  if (request.channelId) return `Task from ${request.channelId}`;
  return "Task from Slack";
}

function compactTaskificationText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return sentenceCase(compact);
  return sentenceCase(`${compact.slice(0, maxLength - 1).trim()}...`);
}

function sentenceCase(value: string): string {
  if (!value) return value;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function inferSlackTaskificationPriority(text: string): NonNullable<ATMTaskificationRequest["priority"]> {
  const normalized = text.toLowerCase();
  if (/\bp0\b|긴급|urgent|blocker|장애/.test(normalized)) return "P0";
  if (/\bp1\b|important|중요|이번주|soon/.test(normalized)) return "P1";
  return "P2";
}

function inferSlackTaskificationDueAt(text: string): string | undefined {
  const match =
    /\b(?:by|before|due(?:\s+by)?)\s+([a-z0-9: ]{1,32})(?:[.,;!?]|$)/i.exec(text) ??
    /\b(today|tomorrow|eod)\b/i.exec(text);
  return match?.[1]?.trim();
}

function inferSlackTaskificationNextAction(text: string): string | undefined {
  const match = /\b(?:next action|next step|follow up):\s*(.+)$/i.exec(text);
  return match?.[1]?.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
