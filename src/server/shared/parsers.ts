import type {
  AgentType,
  ChannelMode,
  SlackCollectionScopeSettings,
  SlackCollectionScopeValidation,
  SlackConfirmationAction,
  SlackConfirmationActionId,
  SlackConfirmationCallbackId,
  SlackConfirmationResponseState,
  SlackThreadCollectionMode,
  TaskCategory,
  TaskPriority,
  TaskState
} from "./types";
import {
  agentTypes,
  channelModes,
  slackConfirmationActionIds,
  slackConfirmationActions,
  slackConfirmationCallbackIds,
  slackConfirmationResponseStates,
  slackThreadCollectionModes,
  taskCategories,
  taskPriorities,
  taskStates
} from "./types";
import { stringValue } from "./utils";

export function parseTaskState(value: unknown): TaskState | null {
  if (typeof value !== "string") return null;
  return taskStates.includes(value as TaskState) ? (value as TaskState) : null;
}

export function parseTaskPriority(value: unknown): TaskPriority | null {
  if (typeof value !== "string") return null;
  return taskPriorities.includes(value as TaskPriority) ? (value as TaskPriority) : null;
}

export function parseTaskCategory(value: unknown): TaskCategory | null {
  if (typeof value !== "string") return null;
  return taskCategories.includes(value as TaskCategory) ? (value as TaskCategory) : null;
}

export function parseChannelMode(value: unknown): ChannelMode | null {
  if (typeof value !== "string") return null;
  return channelModes.includes(value as ChannelMode) ? (value as ChannelMode) : null;
}

export function parseAgentType(value: unknown): AgentType | null {
  if (typeof value !== "string") return null;
  return agentTypes.includes(value as AgentType) ? (value as AgentType) : null;
}

export function parseSlackThreadCollectionMode(value: unknown): SlackThreadCollectionMode | null {
  if (typeof value !== "string") return null;
  return slackThreadCollectionModes.includes(value as SlackThreadCollectionMode)
    ? (value as SlackThreadCollectionMode)
    : null;
}

export function parseSlackConfirmationCallbackId(value: unknown): SlackConfirmationCallbackId | null {
  if (typeof value !== "string") return null;
  return slackConfirmationCallbackIds.includes(value as SlackConfirmationCallbackId)
    ? (value as SlackConfirmationCallbackId)
    : null;
}

export function parseSlackConfirmationActionId(value: unknown): SlackConfirmationActionId | null {
  if (typeof value !== "string") return null;
  return slackConfirmationActionIds.includes(value as SlackConfirmationActionId)
    ? (value as SlackConfirmationActionId)
    : null;
}

export function parseSlackConfirmationAction(value: unknown): SlackConfirmationAction | null {
  if (typeof value !== "string") return null;
  return slackConfirmationActions.includes(value as SlackConfirmationAction)
    ? (value as SlackConfirmationAction)
    : null;
}

export function parseSlackConfirmationResponseState(value: unknown): SlackConfirmationResponseState | null {
  if (typeof value !== "string") return null;
  return slackConfirmationResponseStates.includes(value as SlackConfirmationResponseState)
    ? (value as SlackConfirmationResponseState)
    : null;
}

export function signalToStatus(signal: string | null): TaskState | null {
  if (!signal) return null;
  const normalized = signal.toLowerCase().replaceAll("-", "_").trim();
  if (["done", "complete", "completed", "resolved"].includes(normalized)) return "done";
  if (["blocked", "stuck"].includes(normalized)) return "blocked";
  if (["review", "review_needed", "needs_review"].includes(normalized)) return "review_needed";
  if (["start", "started", "in_progress"].includes(normalized)) return "in_progress";
  return null;
}

export function parseGitHubRule(rule: Record<string, unknown>) {
  const parsed: { repo: string; projectLabel?: string; initiativeIncludes?: string[]; codeIndicators?: string[] } = {
    repo: stringValue(rule.repo) ?? ""
  };
  const projectLabel = stringValue(rule.projectLabel);
  if (projectLabel) parsed.projectLabel = projectLabel;
  if (Array.isArray(rule.initiativeIncludes)) {
    parsed.initiativeIncludes = rule.initiativeIncludes
      .map((item) => stringValue(item))
      .filter((item): item is string => Boolean(item));
  }
  if (Array.isArray(rule.codeIndicators)) {
    parsed.codeIndicators = rule.codeIndicators
      .map((item) => stringValue(item))
      .filter((item): item is string => Boolean(item));
  }
  return parsed;
}

export function parseSlackCollectionScopeSettings(input: Record<string, unknown>): Partial<SlackCollectionScopeSettings> {
  const parsed: Partial<SlackCollectionScopeSettings> = {};
  if ("workspaces" in input || "workspace" in input) {
    parsed.workspaces = normalizeScopeList(input.workspaces ?? input.workspace, isSlackWorkspaceId);
    parsed.workspace = parsed.workspaces[0] ?? null;
  }
  if ("channels" in input) parsed.channels = normalizeScopeList(input.channels, isSlackChannelId);
  if ("channelThreadScopes" in input || "channel_thread_scopes" in input) {
    parsed.channelThreadScopes = normalizeChannelThreadScopes(input.channelThreadScopes ?? input.channel_thread_scopes);
  }
  if ("threads" in input) parsed.threads = normalizeScopeList(input.threads, isSlackThreadTs);
  if ("mentions" in input) parsed.mentions = normalizeScopeList(input.mentions, isSlackMentionFilter);
  if ("keywords" in input) parsed.keywords = normalizeScopeList(input.keywords, isSlackKeyword);
  return parsed;
}

export function validateSlackCollectionScopeSettingsInput(input: Record<string, unknown>): SlackCollectionScopeValidation {
  const validation: SlackCollectionScopeValidation = {
    invalid: {},
    duplicates: {},
    saved: {},
    hasInvalid: false,
    hasDuplicates: false
  };
  const parsed = parseSlackCollectionScopeSettings(input);

  if ("workspaces" in input || "workspace" in input) {
    validateScopeList(validation, "workspaces", input.workspaces ?? input.workspace, isSlackWorkspaceId);
    validation.saved.workspaces = parsed.workspaces ?? [];
  }
  if ("channels" in input) {
    validateScopeList(validation, "channels", input.channels, isSlackChannelId);
    validation.saved.channels = parsed.channels ?? [];
  }
  if ("threads" in input) {
    validateScopeList(validation, "threads", input.threads, isSlackThreadTs);
    validation.saved.threads = parsed.threads ?? [];
  }
  if ("mentions" in input) {
    validateScopeList(validation, "mentions", input.mentions, isSlackMentionFilter);
    validation.saved.mentions = parsed.mentions ?? [];
  }
  if ("keywords" in input) {
    validateScopeList(validation, "keywords", input.keywords, isSlackKeyword);
    validation.saved.keywords = parsed.keywords ?? [];
  }
  if ("channelThreadScopes" in input || "channel_thread_scopes" in input) {
    const allowedChannels = parsed.channels ? new Set(parsed.channels) : null;
    validateChannelThreadScopes(validation, input.channelThreadScopes ?? input.channel_thread_scopes, allowedChannels);
    validation.saved.channelThreadScopes = Object.entries(parsed.channelThreadScopes ?? {})
      .filter(([channelId]) => !allowedChannels || allowedChannels.has(channelId))
      .map(([channelId, mode]) => `${channelId}=${mode}`);
  }

  validation.hasInvalid = Object.values(validation.invalid).some((items) => items.length > 0);
  validation.hasDuplicates = Object.values(validation.duplicates).some((items) => items.length > 0);
  return validation;
}

export function validateSlackCollectionScopeForCollection(
  scope: SlackCollectionScopeSettings
): SlackCollectionScopeValidation {
  const validation = validateSlackCollectionScopeSettingsInput({
    workspaces: scope.workspaces,
    channels: scope.channels,
    channelThreadScopes: scope.channelThreadScopes,
    threads: scope.threads,
    mentions: scope.mentions,
    keywords: scope.keywords
  });

  validation.saved = {
    workspaces: scope.workspaces,
    channels: scope.channels,
    threads: scope.threads,
    mentions: scope.mentions,
    keywords: scope.keywords,
    channelThreadScopes: Object.entries(scope.channelThreadScopes).map(([channelId, mode]) => `${channelId}=${mode}`)
  };

  if (scope.channels.length === 0) {
    validation.invalid.channels = [
      ...(validation.invalid.channels ?? []),
      "At least one Slack channel must be configured before collection."
    ];
  }

  validation.hasInvalid = Object.values(validation.invalid).some((items) => items.length > 0);
  validation.hasDuplicates = Object.values(validation.duplicates).some((items) => items.length > 0);
  return validation;
}

export function defaultSlackCollectionScopeSettings(updatedAt: string | null = null): SlackCollectionScopeSettings {
  return {
    workspace: null,
    workspaces: [],
    channels: [],
    channelThreadScopes: {},
    threads: [],
    mentions: [],
    keywords: [],
    updatedAt
  };
}

export function normalizeSlackCollectionScopeSettings(
  input: Partial<SlackCollectionScopeSettings>,
  updatedAt: string | null = null
): SlackCollectionScopeSettings {
  const workspaces = normalizeScopeList(input.workspaces ?? input.workspace, isSlackWorkspaceId);
  const workspace = workspaces[0] ?? null;
  const channels = normalizeScopeList(input.channels, isSlackChannelId);
  const channelThreadScopes = normalizeChannelThreadScopes(input.channelThreadScopes);
  const allowedChannels = new Set(channels);
  return {
    workspace,
    workspaces,
    channels,
    channelThreadScopes: Object.fromEntries(
      Object.entries(channelThreadScopes).filter(([channelId]) => allowedChannels.has(channelId))
    ),
    threads: normalizeScopeList(input.threads, isSlackThreadTs),
    mentions: normalizeScopeList(input.mentions, isSlackMentionFilter),
    keywords: normalizeScopeList(input.keywords, isSlackKeyword),
    updatedAt: stringValue(input.updatedAt) ?? updatedAt
  };
}

export function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, raw]) => [key, stringValue(raw)])
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

function stringListValue(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return Array.from(new Set(
    rawItems
      .map((item) => stringValue(item))
      .filter((item): item is string => Boolean(item))
  ));
}

function rawStringListValue(value: unknown): { values: string[]; invalid: string[] } {
  if (typeof value === "string") {
    return {
      values: value.split(",").map((item) => item.trim()).filter(Boolean),
      invalid: []
    };
  }
  if (Array.isArray(value)) {
    const values: string[] = [];
    const invalid: string[] = [];
    for (const item of value) {
      const text = stringValue(item);
      if (text) {
        values.push(text);
      } else if (item !== "" && item !== null && item !== undefined) {
        invalid.push(String(item));
      }
    }
    return { values, invalid };
  }
  if (value === undefined) return { values: [], invalid: [] };
  return { values: [], invalid: ["Expected a comma-separated string or array."] };
}

function validateScopeList(
  validation: SlackCollectionScopeValidation,
  field: keyof SlackCollectionScopeSettings,
  value: unknown,
  isValid: (value: string) => boolean
) {
  const { values, invalid } = rawStringListValue(value);
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const item of values) {
    if (!isValid(item)) {
      invalid.push(item);
      continue;
    }
    if (seen.has(item)) duplicates.push(item);
    seen.add(item);
  }
  if (invalid.length) validation.invalid[field] = Array.from(new Set(invalid));
  if (duplicates.length) validation.duplicates[field] = Array.from(new Set(duplicates));
}

function validateChannelThreadScopes(
  validation: SlackCollectionScopeValidation,
  value: unknown,
  allowedChannels: Set<string> | null
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (value !== undefined) validation.invalid.channelThreadScopes = ["Expected a channel-to-thread-mode object."];
    return;
  }
  const invalid: string[] = [];
  for (const [channelId, mode] of Object.entries(value as Record<string, unknown>)) {
    const normalizedChannelId = channelId.trim();
    if (!isSlackChannelId(normalizedChannelId)) {
      invalid.push(channelId);
      continue;
    }
    if (allowedChannels && !allowedChannels.has(normalizedChannelId)) {
      invalid.push(`${channelId}=${String(mode)}`);
      continue;
    }
    if (!parseSlackThreadCollectionMode(mode)) invalid.push(`${channelId}=${String(mode)}`);
  }
  if (invalid.length) validation.invalid.channelThreadScopes = Array.from(new Set(invalid));
}

function normalizeScopeList(value: unknown, isValid: (value: string) => boolean): string[] {
  return stringListValue(value).filter(isValid);
}

function normalizeChannelThreadScopes(value: unknown): Record<string, SlackThreadCollectionMode> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([channelId, mode]) => [channelId.trim(), parseSlackThreadCollectionMode(mode)] as const)
      .filter((entry): entry is [string, SlackThreadCollectionMode] => isSlackChannelId(entry[0]) && Boolean(entry[1]))
  );
}

function isSlackWorkspaceId(value: string): boolean {
  return /^[TE][A-Z0-9]{2,}$/.test(value);
}

function isSlackChannelId(value: string): boolean {
  return /^[CGD][A-Z0-9]{2,}$/.test(value);
}

function isSlackThreadTs(value: string): boolean {
  return /^\d{10,}\.\d{1,6}$/.test(value);
}

function isSlackMentionFilter(value: string): boolean {
  return /^[UW][A-Z0-9]{2,}$/.test(value) || /^@[A-Za-z0-9._-]{1,80}$/.test(value);
}

function isSlackKeyword(value: string): boolean {
  return value.length <= 120;
}
