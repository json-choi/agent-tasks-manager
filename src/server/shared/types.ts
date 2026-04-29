export const taskStates = [
  "proposed",
  "confirmed",
  "assigning",
  "in_progress",
  "blocked",
  "review_needed",
  "done",
  "cancelled"
] as const;

export type TaskState = (typeof taskStates)[number];

export const taskPriorities = ["P0", "P1", "P2"] as const;

export type TaskPriority = (typeof taskPriorities)[number];

export const taskCategories = ["general", "coding"] as const;

export type TaskCategory = (typeof taskCategories)[number];

export const channelModes = ["manual_only", "suggest_only"] as const;

export type ChannelMode = (typeof channelModes)[number];

export const agentTypes = ["openclaw"] as const;

export type AgentType = (typeof agentTypes)[number];

export const userRoles = ["owner", "member"] as const;

export type UserRole = (typeof userRoles)[number];

export interface UserProfile {
  userId: string;
  role: UserRole;
  ownerId: string | null;
  slackUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MemberInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface MemberInvitation {
  id: string;
  ownerId: string;
  ownerName: string | null;
  slackUserId: string;
  email: string | null;
  status: MemberInvitationStatus;
  expiresAt: string;
  acceptedUserId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface SlackAction {
  kind: "thread_reply" | "dm" | "reaction";
  channelId?: string | null;
  threadTs?: string | null;
  userId?: string | null;
  text?: string;
  emoji?: string;
  blocks?: unknown;
  metadata?: unknown;
}

export interface SlackThreadMessage {
  userId?: string;
  botId?: string;
  text: string;
  ts?: string;
}

export interface AgentThreadContext {
  channelId?: string | null;
  channelName?: string | null;
  threadTs?: string | null;
  messageTs?: string | null;
  authorId?: string | null;
  authorName?: string | null;
  permalink?: string | null;
  agentName?: string | null;
  messages?: SlackThreadMessage[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskState;
  priority: TaskPriority;
  category: TaskCategory;
  assignee: string | null;
  reporter: string | null;
  notify: boolean;
  initiative: string | null;
  nextAction: string | null;
  result: string | null;
  githubRef: string | null;
  channelId: string | null;
  threadTs: string | null;
  sourceAgentId: string | null;
  sourceAgentName: string | null;
  sourceAuthor: string | null;
  sourceUrl: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  markdownPath: string;
  dedupeKey: string | null;
}

export interface AgentSettings {
  id: string;
  type: AgentType;
  name: string;
  apiTokenPreview: string | null;
  cliPath: string | null;
  configPath: string | null;
  workspacePath: string | null;
  status: "pending" | "connected" | "error";
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelPolicy {
  channelId: string;
  mode: ChannelMode;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerMapping {
  id: string;
  ownerName: string;
  slackUserId: string | null;
  aliases: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AssignmentRequestStatus = "pending" | "accepted" | "delegated" | "declined" | "expired" | "cancelled";

export interface AssignmentRequest {
  id: string;
  taskId: string;
  agentId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  slackUserId: string | null;
  status: AssignmentRequestStatus;
  round: number;
  previousRequestId: string | null;
  requestedBy: string | null;
  responseText: string | null;
  slackMessageTs: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
}

export interface SlackDigestCandidate {
  id: string;
  channelId: string;
  channelName: string | null;
  ts: string;
  threadTs: string | null;
  userId: string | null;
  userName: string | null;
  text: string;
  permalink: string | null;
  reason: string;
}

export interface SlackDigest {
  id: string;
  agentId: string;
  channelId: string;
  status: "pending" | "committed";
  payload: {
    channelName?: string | null;
    messages: Array<Record<string, unknown>>;
    candidates: SlackDigestCandidate[];
    nextLastTs?: string | null;
  };
  createdAt: string;
  committedAt: string | null;
}

export interface SlackCursor {
  agentId: string;
  channelId: string;
  lastTs: string;
  lastScannedAt: string;
  includeThreads: boolean;
}

export interface GitHubSettings {
  enabled: boolean;
  autoCreateIssues: boolean;
  autoUpdateTaskStatusFromGitHub: boolean;
  autoCompleteClosedIssues: boolean;
  tokenConfigured: boolean;
  rules: Array<{
    repo: string;
    projectLabel?: string;
    initiativeIncludes?: string[];
    codeIndicators?: string[];
  }>;
  labels: string[];
  assigneesByOwner: Record<string, string>;
  updatedAt: string | null;
}

export interface SetupReviewSettings {
  slackPermissionsReviewedAt: string | null;
}

export interface PublicAccessSettings {
  provider: "cloudflare";
  mode: "quick" | "remote";
  publicUrl: string | null;
  localServiceUrl: string;
  tunnelName: string | null;
  tunnelTokenConfigured: boolean;
  tunnelTokenPreview: string | null;
  accessProtected: boolean;
  updatedAt: string | null;
}

export interface OutboxItem {
  id: string;
  agentId: string;
  type: string;
  payload: unknown;
  status: "pending" | "acked";
  createdAt: string;
  ackedAt: string | null;
}

export interface Diagnostic {
  ok: boolean;
  label: string;
  message: string;
}
