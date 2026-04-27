import type { AgentSettings, AgentThreadContext, SlackThreadMessage, Task, TaskPriority } from "../shared/types";
import { asRecord, compactText, stringValue } from "../shared/utils";

export function parseSlackDigestMessage(value: unknown, defaultChannelId: string, defaultChannelName: string | null) {
  const input = asRecord(value);
  const ts = stringValue(input.ts);
  const text = stringValue(input.text);
  if (!ts || !text) return null;
  return {
    channelId: stringValue(input.channelId) ?? defaultChannelId,
    channelName: stringValue(input.channelName) ?? defaultChannelName,
    ts,
    threadTs: stringValue(input.threadTs),
    parentTs: stringValue(input.parentTs),
    userId: stringValue(input.userId),
    userName: stringValue(input.userName),
    text,
    permalink: stringValue(input.permalink),
    botId: stringValue(input.botId)
  };
}

export function inferPriorityFromText(text: string): TaskPriority {
  const normalized = text.toLowerCase();
  if (/\bp0\b|긴급|urgent|blocker|장애/.test(normalized)) return "P0";
  if (/\bp1\b|important|중요|이번주|soon/.test(normalized)) return "P1";
  return "P2";
}

export function filterCardTasks(tasks: Task[], owner: string | null, scope: string): Task[] {
  const normalizedOwner = owner?.trim().toLowerCase() ?? "";
  const active = tasks.filter((task) => !["done", "cancelled"].includes(task.status));
  return active
    .filter((task) => {
      if (scope === "blocked") return task.status === "blocked";
      if (scope === "today") return task.status !== "proposed" && task.status !== "cancelled";
      return true;
    })
    .filter((task) => {
      if (!normalizedOwner) return true;
      return [task.assignee, task.reporter]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase() === normalizedOwner);
    })
    .sort((a, b) => taskSortScore(a) - taskSortScore(b));
}

export function renderTaskCardsText(tasks: Task[], owner: string | null, scope: string): string {
  const label = owner ? `${owner} ${scope}` : scope;
  if (tasks.length === 0) return `No active tasks for ${label}.`;
  return [
    `Tasks for ${label}:`,
    ...tasks.map((task) => {
      const ownerText = task.assignee ? ` @${task.assignee}` : "";
      const next = task.nextAction ? ` - ${task.nextAction}` : "";
      return `- ${task.id} [${task.priority}/${task.status}]${ownerText} ${task.title}${next}`;
    })
  ].join("\n");
}

export function parseThreadContext(value: unknown, agent: AgentSettings): AgentThreadContext {
  const input = asRecord(value);
  const messagesValue = input.messages;
  const messages = Array.isArray(messagesValue)
    ? messagesValue
        .map((message) => {
          const record = asRecord(message);
          const text = stringValue(record.text);
          if (!text) return null;
          const parsed: SlackThreadMessage = { text };
          const userId = stringValue(record.userId);
          const botId = stringValue(record.botId);
          const ts = stringValue(record.ts);
          if (userId) parsed.userId = userId;
          if (botId) parsed.botId = botId;
          if (ts) parsed.ts = ts;
          return parsed;
        })
        .filter((message): message is SlackThreadMessage => Boolean(message))
    : [];

  return {
    channelId: stringValue(input.channelId),
    channelName: stringValue(input.channelName),
    threadTs: stringValue(input.threadTs) ?? stringValue(input.messageTs),
    messageTs: stringValue(input.messageTs),
    authorId: stringValue(input.authorId),
    authorName: stringValue(input.authorName),
    permalink: stringValue(input.permalink),
    agentName: stringValue(input.agentName) ?? agent.name,
    messages
  };
}

export function inferTitle(context: AgentThreadContext): string {
  const firstUserMessage = context.messages?.find((message) => !message.botId && message.text.trim());
  if (firstUserMessage) return compactText(firstUserMessage.text, 96);
  if (context.channelName) return `Task from #${context.channelName}`;
  if (context.channelId) return `Task from ${context.channelId}`;
  return "Task from agent request";
}

export function renderThreadDescription(context: AgentThreadContext): string {
  if (!context.messages?.length) {
    return context.permalink ? `Source Slack thread: ${context.permalink}` : "";
  }

  const transcript = context.messages
    .map((message) => {
      const speaker = message.userId ? `<@${message.userId}>` : message.botId ? `bot:${message.botId}` : "unknown";
      return `- ${speaker}: ${message.text}`;
    })
    .join("\n");

  const source = context.permalink ? `\n\nSource: ${context.permalink}` : "";
  return `Captured Slack thread:\n\n${transcript}${source}`;
}

function taskSortScore(task: Task): number {
  const statusScore = task.status === "blocked" ? 0 : task.status === "in_progress" ? 10 : 20;
  const priorityScore = task.priority === "P0" ? 0 : task.priority === "P1" ? 2 : 4;
  return statusScore + priorityScore;
}
