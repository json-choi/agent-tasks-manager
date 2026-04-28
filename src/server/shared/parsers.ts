import type { AgentType, ChannelMode, TaskCategory, TaskPriority, TaskState } from "./types";
import { agentTypes, channelModes, taskCategories, taskPriorities, taskStates } from "./types";
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

export function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, raw]) => [key, stringValue(raw)])
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}
