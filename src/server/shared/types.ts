import type {
  SlackTaskAssigneeResolution,
  SlackTaskificationClassification
} from "../../shared/slack-qualification";

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

export const slackThreadCollectionModes = ["parent_messages", "active_threads", "full_thread_history"] as const;

export type SlackThreadCollectionMode = (typeof slackThreadCollectionModes)[number];

export const slackCollectionScopeSchema = {
  version: "slack_collection_scope.v1",
  supportedTriggers: ["manual", "scheduled"],
  defaults: {
    workspace: null,
    workspaces: [],
    channels: [],
    channelThreadScopes: {},
    threads: [],
    mentions: [],
    keywords: [],
    updatedAt: null
  },
  fields: {
    workspace: {
      type: "string|null",
      aliases: ["workspaces"],
      pattern: "^[TE][A-Z0-9]{2,}$",
      description: "Primary Slack workspace id. The first valid workspace is mirrored here for older clients."
    },
    workspaces: {
      type: "string[]",
      itemPattern: "^[TE][A-Z0-9]{2,}$",
      description: "Slack workspace ids included in scheduled or manual ATM collection."
    },
    channels: {
      type: "string[]",
      itemPattern: "^[CGD][A-Z0-9]{2,}$",
      requiredForScheduled: true,
      description: "Slack channel ids to collect. Scheduled collection is not ready until at least one channel is saved."
    },
    channelThreadScopes: {
      type: "Record<channelId, threadCollectionMode>",
      allowedValues: slackThreadCollectionModes,
      aliases: ["channel_thread_scopes"],
      description: "Per-channel thread collection mode used when OpenClaw expands scheduled collection targets."
    },
    threads: {
      type: "string[]",
      itemPattern: "^\\d{10,}\\.\\d{1,6}$",
      description: "Specific Slack thread timestamps to include as collection filters."
    },
    mentions: {
      type: "string[]",
      itemPattern: "^[UW][A-Z0-9]{2,}$|^@[A-Za-z0-9._-]{1,80}$",
      description: "Slack user ids or @aliases that include matching messages in the collection filter."
    },
    keywords: {
      type: "string[]",
      maxLength: 120,
      description: "Case-insensitive keywords that include matching messages in the collection filter."
    },
    updatedAt: {
      type: "string|null",
      description: "Server timestamp from the most recent persisted scope update."
    }
  },
  scheduledTarget: {
    expansion: "workspaces x channels",
    emptyWorkspaces: "workspaceId is null and the OpenClaw runtime may use its current Slack workspace.",
    defaultThreadCollectionMode: "active_threads",
    cursorKey: "agentId + channelId"
  }
} as const;

export type SlackCollectionScopeSchema = typeof slackCollectionScopeSchema;

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

export const slackConfirmationCallbackIds = [
  "atm_task_candidate_confirmation",
  "atm_assignment_confirmation"
] as const;

export type SlackConfirmationCallbackId = (typeof slackConfirmationCallbackIds)[number];

export const slackConfirmationCallbackId = {
  taskCandidateConfirmation: "atm_task_candidate_confirmation",
  assignmentConfirmation: "atm_assignment_confirmation"
} as const satisfies Record<string, SlackConfirmationCallbackId>;

export const slackConfirmationActionIds = [
  "atm_candidate_accept",
  "atm_candidate_decline",
  "atm_candidate_select_assignee",
  "atm_candidate_select_classification",
  "atm_assignment_accept",
  "atm_assignment_decline",
  "atm_assignment_delegate_select"
] as const;

export type SlackConfirmationActionId = (typeof slackConfirmationActionIds)[number];

export const slackConfirmationActionId = {
  candidateAccept: "atm_candidate_accept",
  candidateDecline: "atm_candidate_decline",
  candidateSelectAssignee: "atm_candidate_select_assignee",
  candidateSelectClassification: "atm_candidate_select_classification",
  assignmentAccept: "atm_assignment_accept",
  assignmentDecline: "atm_assignment_decline",
  assignmentDelegateSelect: "atm_assignment_delegate_select"
} as const satisfies Record<string, SlackConfirmationActionId>;

export const slackConfirmationActions = [
  "accept",
  "decline",
  "delegate",
  "select_assignee",
  "select_classification"
] as const;

export type SlackConfirmationAction = (typeof slackConfirmationActions)[number];

export const slackConfirmationResponseStates = [
  "proposed",
  "assigning",
  "confirmed",
  "in_progress",
  "blocked",
  "review_needed"
] as const satisfies readonly TaskState[];

export type SlackConfirmationResponseState = (typeof slackConfirmationResponseStates)[number];

export const slackTaskCandidateSchema = {
  version: "slack_task_candidate.v1",
  requiredSlackDerivedFields: {
    taskTitle: "Human-readable ATM task title proposed from Slack message text.",
    taskDescription: "ATM task description preserving the Slack request context.",
    sourceChannel: "Slack workspace/channel/thread/message identity for the source message.",
    sourceMessageLink: "Permalink to the original Slack message.",
    requester: "Slack user id or display name of the user who requested the work.",
    relevantContext: "Slack text snippets used to justify the proposed task candidate.",
    assigneeResolution: "Whether Slack text yielded one clear assignee, no assignee, or ambiguous ownership.",
    requiresAssigneeConfirmation: "True when the candidate lacks one confident ATM assignee before activation.",
    memberMappingUncertainties: "Unmapped Slack authors or mentioned users that must be resolved before activation."
  },
  stateContract: slackConfirmationResponseStates
} as const;

export type SlackTaskCandidateSchema = typeof slackTaskCandidateSchema;

export interface SlackTaskCandidateSourceChannel {
  workspaceId: string;
  channelId: string;
  channelName: string | null;
  threadTs: string | null;
  messageTs: string;
}

export const slackMemberMappingUncertaintySubjects = ["author", "mentioned_user"] as const;

export type SlackMemberMappingUncertaintySubject = (typeof slackMemberMappingUncertaintySubjects)[number];

export const slackMemberMappingUncertaintyReasons = ["missing_slack_user_id", "unmapped_slack_user"] as const;

export type SlackMemberMappingUncertaintyReason = (typeof slackMemberMappingUncertaintyReasons)[number];

export interface SlackMemberMappingUncertainty {
  subject: SlackMemberMappingUncertaintySubject;
  slackUserId: string | null;
  slackUserName: string | null;
  reason: SlackMemberMappingUncertaintyReason;
}

export const slackTaskCandidateProfileContextRoles = [
  "requester",
  "candidate_assignee",
  "leader_reviewer",
  "confirmation_target"
] as const;

export type SlackTaskCandidateProfileContextRole = (typeof slackTaskCandidateProfileContextRoles)[number];

export const slackTaskCandidateProfileMappingStatuses = ["mapped", "unmapped", "unknown"] as const;

export type SlackTaskCandidateProfileMappingStatus = (typeof slackTaskCandidateProfileMappingStatuses)[number];

export interface SlackTaskCandidateProfileContext {
  role: SlackTaskCandidateProfileContextRole;
  slackUserId: string | null;
  slackUserName: string | null;
  atmOwnerId: string | null;
  atmOwnerName: string | null;
  mappingStatus: SlackTaskCandidateProfileMappingStatus;
  uncertaintyReason: SlackMemberMappingUncertaintyReason | null;
}

export interface SlackTaskCandidateATMIdentityContext {
  candidateId: string;
  taskTitle: string;
  taskClassification: TaskCategory | null;
  confirmationState: SlackConfirmationResponseState;
  assignee: string | null;
  assigneeResolution: SlackTaskAssigneeResolution | null;
  requiresAssigneeConfirmation: boolean;
  dedupeKey: string;
  markdownPath: string | null;
  sourceUrl: string | null;
}

export interface SlackTaskCandidateAssigneeOption {
  ownerId: string;
  ownerName: string;
  slackUserId: string;
}

export interface SlackTaskCandidateMetadata {
  candidateId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string | null;
  messageTs: string;
  messageText: string;
  taskTitle: string;
  taskDescription: string;
  taskClassification?: TaskCategory | null;
  sourceChannel: SlackTaskCandidateSourceChannel;
  sourceMessageLink: string;
  requester: string;
  relevantContext: string[];
  assignee: string | null;
  assigneeCandidates: string[];
  assigneeOptions?: SlackTaskCandidateAssigneeOption[];
  assigneeResolution?: SlackTaskAssigneeResolution;
  requiresAssigneeConfirmation?: boolean;
  memberMappingUncertainties?: SlackMemberMappingUncertainty[];
  slackProfileContext?: SlackTaskCandidateProfileContext[];
  atmIdentityContext?: SlackTaskCandidateATMIdentityContext;
  leaderReviewer: string | null;
  leaderReviewChannelId?: string | null;
  leaderReviewThreadTs?: string | null;
  confirmationTarget: string;
  confirmationState: SlackConfirmationResponseState;
  dedupeKey: string;
  dueAt: string | null;
  nextAction: string | null;
  sourceUrl: string | null;
  markdownPath: string | null;
}

export interface SlackTaskCandidateRecord {
  id: string;
  agentId: string;
  taskId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string | null;
  messageTs: string;
  sourceTs: string;
  assigneeKey: string;
  confirmationTarget: string | null;
  confirmationState: SlackConfirmationResponseState;
  dedupeKey: string;
  payload: SlackTaskCandidateMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface SlackConfirmationPayload {
  callbackId: SlackConfirmationCallbackId;
  actionId: SlackConfirmationActionId;
  confirmationAction: SlackConfirmationAction;
  responseState: SlackConfirmationResponseState;
  candidate: SlackTaskCandidateMetadata;
  requestId: string | null;
  taskId: string | null;
  selectedAssignee: string | null;
  selectedClassification?: TaskCategory | null;
  responseText: string | null;
}

export interface SlackTaskCandidateConfirmationRequest {
  id: string;
  agentId: string;
  taskId: string;
  outboxId: string | null;
  workspaceId: string;
  channelId: string;
  threadTs: string | null;
  messageTs: string;
  assigneeKey: string;
  confirmationTarget: string;
  confirmationState: SlackConfirmationResponseState;
  confirmationAction: SlackConfirmationAction | null;
  selectedAssignee: string | null;
  selectedClassification: TaskCategory | null;
  responseText: string | null;
  respondedAt: string | null;
  dedupeKey: string;
  payload: SlackTaskCandidateMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface SlackThreadMessage {
  userId?: string;
  botId?: string;
  text: string;
  ts?: string;
}

export interface AgentThreadContext {
  workspaceId?: string | null;
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
  workspaceId: string | null;
  channelId: string;
  channelName: string | null;
  ts: string;
  threadTs: string | null;
  userId: string | null;
  userName: string | null;
  text: string;
  taskTitle: string;
  taskDescription: string;
  dueAt: string | null;
  nextAction: string | null;
  relevantContext: string[];
  permalink: string | null;
  sourceChannel: SlackTaskCandidateSourceChannel;
  sourceMessageLink: string;
  requester: string;
  assigneeCandidates: string[];
  assignee: string | null;
  assigneeSlackUserId: string | null;
  assigneeResolution: SlackTaskAssigneeResolution;
  requiresAssigneeConfirmation: boolean;
  memberMappingUncertainties?: SlackMemberMappingUncertainty[];
  reason: string;
  classification: SlackTaskificationClassification;
}

export interface SlackCollectedMessage {
  id: string;
  agentId: string;
  collectionRunId: string | null;
  workspaceId: string | null;
  channelId: string;
  channelName: string | null;
  threadTs: string | null;
  messageTs: string;
  userId: string | null;
  userName: string | null;
  text: string;
  permalink: string | null;
  botId: string | null;
  digestId: string | null;
  collectionScopeSource: "saved" | "manual_override";
  threadCollectionMode: SlackThreadCollectionMode;
  collectionScope: SlackCollectionScopeSettings;
  dedupeKey: string;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlackCollectedMessageWithRun {
  message: SlackCollectedMessage;
  collectionRun: SlackCollectionRun | null;
}

export const slackCollectionTriggers = ["manual", "scheduled"] as const;

export type SlackCollectionTrigger = (typeof slackCollectionTriggers)[number];

export const slackCollectionRunStatuses = ["completed", "failed"] as const;

export type SlackCollectionRunStatus = (typeof slackCollectionRunStatuses)[number];

export interface SlackCollectionRun {
  id: string;
  agentId: string;
  digestId: string | null;
  workspaceId: string | null;
  channelId: string;
  channelName: string | null;
  collectionTrigger: SlackCollectionTrigger;
  collectionScopeSource: "saved" | "manual_override";
  threadCollectionMode: SlackThreadCollectionMode;
  collectionScope: SlackCollectionScopeSettings;
  status: SlackCollectionRunStatus;
  startedAt: string;
  completedAt: string | null;
  receivedMessageCount: number;
  parsedMessageCount: number;
  retainedMessageCount: number;
  insertedMessageCount: number;
  duplicateMessageCount: number;
  candidateCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlackDigest {
  id: string;
  agentId: string;
  channelId: string;
  status: "pending" | "committed";
  payload: {
    workspaceId?: string | null;
    channelName?: string | null;
    messages: Array<Record<string, unknown>>;
    classifications?: SlackTaskificationClassification[];
    candidates: SlackDigestCandidate[];
    nextLastTs?: string | null;
    threadCollectionMode?: SlackThreadCollectionMode;
    collectionRunId?: string | null;
    collectionPersistence?: {
      insertedMessages: number;
      duplicateMessages: number;
      dedupeKeys: string[];
    };
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

export interface SlackCollectionScopeSettings {
  workspace: string | null;
  workspaces: string[];
  channels: string[];
  channelThreadScopes: Record<string, SlackThreadCollectionMode>;
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

export interface SlackWorkspaceConnection {
  workspaceId: string;
  workspaceName: string | null;
  agentId: string | null;
  agentName: string | null;
  channels: SlackWorkspaceChannel[];
  status: "connected" | "configured";
  lastSeenAt: string | null;
}

export interface SlackWorkspaceChannel {
  channelId: string;
  channelName: string | null;
  lastSeenAt: string | null;
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
