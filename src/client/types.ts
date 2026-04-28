export type Task = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority?: "P0" | "P1" | "P2";
  category?: "general" | "coding";
  assignee?: string | null;
  reporter?: string | null;
  initiative?: string | null;
  nextAction?: string | null;
  githubRef?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  sourceAgentName?: string | null;
  markdownPath?: string;
  updatedAt: string;
};

export type Agent = {
  id: string;
  type: "hermes" | "openclaw";
  name: string;
  apiTokenPreview?: string | null;
  cliPath?: string | null;
  configPath?: string | null;
  workspacePath?: string | null;
  status: string;
  lastSeenAt?: string | null;
  updatedAt: string;
};

export type OwnerMapping = {
  id: string;
  ownerName: string;
  slackUserId?: string | null;
  aliases: string[];
  active: boolean;
  updatedAt: string;
};

export type ChannelPolicy = {
  channelId: string;
  mode: string;
  updatedAt: string;
};

export type GitHubRule = {
  repo: string;
  projectLabel?: string;
  initiativeIncludes?: string[];
  codeIndicators?: string[];
};

export type GitHubSettings = {
  enabled: boolean;
  autoCreateIssues: boolean;
  autoUpdateTaskStatusFromGitHub: boolean;
  autoCompleteClosedIssues: boolean;
  tokenConfigured: boolean;
  rules: GitHubRule[];
  labels: string[];
  assigneesByOwner: Record<string, string>;
  updatedAt: string | null;
};

export type PublicAccessSettings = {
  provider: "cloudflare";
  mode: "quick" | "remote";
  publicUrl: string | null;
  localServiceUrl: string;
  tunnelName: string | null;
  tunnelTokenConfigured: boolean;
  tunnelTokenPreview: string | null;
  accessProtected: boolean;
  updatedAt: string | null;
};

export type SetupStatus = {
  setupLocked: boolean;
  storage?: Record<string, unknown>;
  agents?: Agent[];
  channelPolicies?: ChannelPolicy[];
  review?: {
    slackPermissionsReviewedAt?: string | null;
  };
};

export type PublicAccessPayload = {
  publicAccess: PublicAccessSettings;
  diagnostics?: {
    installed?: boolean;
  };
  guide?: {
    quickTunnelCommand?: string;
    remoteRunCommand?: string;
    serviceInstallCommand?: string;
  };
};

export type View = "dashboard" | "tasks" | "agents" | "integrations" | "settings";
export type ResultMessage = { text: string; ok: boolean };
export type ApiClient = <T>(path: string, options?: RequestInit) => Promise<T>;
export type Translator = (value: string) => string;
