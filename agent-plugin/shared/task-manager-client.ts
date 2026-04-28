export interface TaskManagerClientOptions {
  apiUrl: string;
  agentId: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface SlackMessageContext {
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
  | { type: "propose" }
  | { type: "ask_assignee"; taskId: string | null; assigneeId: string | null }
  | { type: "status"; taskId: string | null; signal: string }
  | { type: "today"; assigneeId: string | null }
  | { type: "none" };

export class TaskManagerClient {
  private readonly apiUrl: string;
  private readonly agentId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TaskManagerClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.agentId = options.agentId;
    this.token = options.token;
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
    title?: string;
    description?: string;
    assignee?: string;
    reporter?: string;
    priority?: "P0" | "P1" | "P2";
    category?: "general" | "coding";
    initiative?: string;
    nextAction?: string;
    githubRef?: string;
    dueAt?: string;
    confirmed?: boolean;
    automatic?: boolean;
  }) {
    return this.request("/api/agent/task/propose", { method: "POST", body: input });
  }

  askAssignee(taskId: string, assigneeId?: string | null) {
    return this.request(`/api/agent/task/${encodeURIComponent(taskId)}/ask-assignee`, {
      method: "POST",
      body: { assigneeId }
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

  today(assigneeId?: string | null, channelId?: string | null, threadTs?: string | null) {
    const params = new URLSearchParams();
    if (assigneeId) params.set("assignee", assigneeId);
    if (channelId) params.set("channelId", channelId);
    if (threadTs) params.set("threadTs", threadTs);
    return this.request(`/api/agent/tasks/today?${params.toString()}`, { method: "GET" });
  }

  collectSlackDigest(input: {
    channelId: string;
    channelName?: string | null;
    messages: Array<Record<string, unknown>>;
    nextLastTs?: string | null;
    includeThreads?: boolean;
  }) {
    return this.request("/api/agent/slack/digest/collect", { method: "POST", body: input });
  }

  commitSlackDigest(input: {
    digestId: string;
    selectedCandidateIds?: string[];
    createTasks?: boolean;
  }) {
    return this.request("/api/agent/slack/digest/commit", { method: "POST", body: input });
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

  private async request(path: string, options: { method: string; body?: unknown }) {
    const init: RequestInit = {
      method: options.method,
      headers: {
        "content-type": "application/json",
        "x-agent-id": this.agentId,
        authorization: `Bearer ${this.token}`
      }
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    const response = await this.fetchImpl(`${this.apiUrl}${path}`, init);

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof data.error === "string" ? data.error : response.statusText;
      throw new Error(`Task Manager API failed: ${message}`);
    }

    return data;
  }
}

export function clientFromEnv(fetchImpl?: typeof fetch, envFilePath?: string): TaskManagerClient {
  const envFile = envFilePath ? readEnvFile(envFilePath) : {};
  const apiUrl = process.env.TASK_MANAGER_API_URL ?? envFile.TASK_MANAGER_API_URL;
  const agentId = process.env.TASK_MANAGER_AGENT_ID ?? envFile.TASK_MANAGER_AGENT_ID;
  const token = process.env.TASK_MANAGER_API_TOKEN ?? envFile.TASK_MANAGER_API_TOKEN;

  if (!apiUrl || !agentId || !token) {
    throw new Error(
      "TASK_MANAGER_API_URL, TASK_MANAGER_AGENT_ID, and TASK_MANAGER_API_TOKEN are required in the environment or task-manager.env"
    );
  }

  const options: TaskManagerClientOptions = { apiUrl, agentId, token };
  if (fetchImpl) options.fetchImpl = fetchImpl;
  return new TaskManagerClient(options);
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

export function classifyTaskCommand(text: string): TaskCommand {
  const normalized = text.trim().toLowerCase();
  const taskId = extractTaskId(text);
  const assigneeId = extractMention(text);

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
    normalized.includes("스레드 태스크로 정리해줘") ||
    normalized.includes("make this a task")
  ) {
    return { type: "propose" };
  }

  return { type: "none" };
}

export function extractTaskId(text: string): string | null {
  return /\btask_[a-z0-9_]+\b/i.exec(text)?.[0] ?? null;
}

export function extractMention(text: string): string | null {
  return /<@([A-Z0-9]+)>/i.exec(text)?.[1] ?? null;
}
import { existsSync, readFileSync } from "node:fs";
