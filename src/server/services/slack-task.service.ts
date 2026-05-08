import type {
  AgentSettings,
  AgentThreadContext,
  SlackAction,
  SlackCollectionScopeSettings,
  SlackCursor,
  SlackMemberMappingUncertainty,
  SlackTaskCandidateATMIdentityContext,
  SlackTaskCandidateMetadata,
  SlackTaskCandidateProfileContext,
  SlackThreadMessage,
  Task,
  TaskCategory,
  TaskPriority
} from "../shared/types";
import { slackConfirmationActionId, slackConfirmationCallbackId, taskCategories } from "../shared/types";
import { asRecord, compactText, stringValue } from "../shared/utils";

type SlackSelectOption = {
  text: { type: "plain_text"; text: string };
  value: string;
};

export const fallbackSlackTaskCandidateClassification: TaskCategory = "general";

const slackTaskCandidateClassificationLabels = {
  general: "General",
  coding: "Coding"
} as const satisfies Record<TaskCategory, string>;

export const slackTaskCandidateClassificationOptions = taskCategories.map(slackClassificationOption);

export type SlackTaskCandidateValidation = {
  ok: boolean;
  missing: string[];
  invalid: string[];
};

export interface SlackTaskCandidateValidationOptions {
  requireConfirmationTarget?: boolean;
  requireConfirmationBackedFields?: boolean;
}

export interface SlackTaskContentDerivationInput {
  messageText: string;
  contextMessages?: SlackThreadMessage[] | undefined;
  channelName?: string | null | undefined;
  channelId?: string | null | undefined;
  requester?: string | null | undefined;
  sourceUrl?: string | null | undefined;
  reason?: string | null | undefined;
}

export interface SlackTaskContentDerivation {
  title: string;
  description: string;
  relevantContext: string[];
  dueAt: string | null;
  nextAction: string | null;
}

export interface SlackMemberMappingUncertaintyInput {
  authorId?: string | null | undefined;
  authorName?: string | null | undefined;
  assigneeCandidates?: string[] | undefined;
}

export function detectSlackMemberMappingUncertainties(
  input: SlackMemberMappingUncertaintyInput,
  resolveOwner: (value: string | null) => unknown
): SlackMemberMappingUncertainty[] {
  const uncertainties: SlackMemberMappingUncertainty[] = [];
  const authorId = stringValue(input.authorId);
  const authorName = stringValue(input.authorName);

  if (authorId) {
    if (!resolveOwner(authorId)) {
      uncertainties.push({
        subject: "author",
        slackUserId: authorId,
        slackUserName: authorName,
        reason: "unmapped_slack_user"
      });
    }
  } else if (authorName && !resolveOwner(authorName)) {
    uncertainties.push({
      subject: "author",
      slackUserId: null,
      slackUserName: authorName,
      reason: "missing_slack_user_id"
    });
  }

  for (const candidate of Array.from(new Set(input.assigneeCandidates ?? []))) {
    const slackUserId = stringValue(candidate);
    if (!slackUserId || resolveOwner(slackUserId)) continue;
    uncertainties.push({
      subject: "mentioned_user",
      slackUserId,
      slackUserName: null,
      reason: "unmapped_slack_user"
    });
  }

  return uncertainties;
}

export function validateSlackTaskCandidateMetadata(
  candidate: SlackTaskCandidateMetadata,
  options: SlackTaskCandidateValidationOptions = {}
): SlackTaskCandidateValidation {
  const missing: string[] = [];
  const invalid: string[] = [];

  if (!candidate.candidateId.trim()) missing.push("candidateId");
  if (!candidate.workspaceId.trim()) missing.push("workspaceId");
  if (!candidate.channelId.trim()) missing.push("channelId");
  if (!candidate.messageTs.trim()) missing.push("messageTs");
  if (!candidate.messageText.trim()) missing.push("messageText");
  if (!candidate.taskTitle.trim()) missing.push("taskTitle");
  if (!candidate.taskDescription.trim()) missing.push("taskDescription");
  if (!candidate.sourceChannel) {
    missing.push("sourceChannel");
  } else {
    if (!candidate.sourceChannel.workspaceId.trim()) missing.push("sourceChannel.workspaceId");
    if (!candidate.sourceChannel.channelId.trim()) missing.push("sourceChannel.channelId");
    if (!candidate.sourceChannel.messageTs.trim()) missing.push("sourceChannel.messageTs");
    if (candidate.sourceChannel.workspaceId && candidate.workspaceId && candidate.sourceChannel.workspaceId !== candidate.workspaceId) {
      invalid.push("sourceChannel.workspaceId");
    }
    if (candidate.sourceChannel.channelId && candidate.channelId && candidate.sourceChannel.channelId !== candidate.channelId) {
      invalid.push("sourceChannel.channelId");
    }
  }
  if (!candidate.sourceMessageLink.trim()) {
    missing.push("sourceMessageLink");
  } else if (!/^https:\/\/.+/i.test(candidate.sourceMessageLink)) {
    invalid.push("sourceMessageLink");
  }
  if (candidate.sourceUrl && !/^https:\/\/.+/i.test(candidate.sourceUrl)) invalid.push("sourceUrl");
  if (!candidate.requester.trim()) missing.push("requester");
  if (candidate.relevantContext.length === 0 || candidate.relevantContext.every((item) => !item.trim())) {
    missing.push("relevantContext");
  }
  if (options.requireConfirmationBackedFields) {
    if (!candidate.assigneeResolution) missing.push("assigneeResolution");
    if (candidate.requiresAssigneeConfirmation === undefined) missing.push("requiresAssigneeConfirmation");
    if (!Array.isArray(candidate.memberMappingUncertainties)) missing.push("memberMappingUncertainties");
  }
  if (!candidate.confirmationState) missing.push("confirmationState");
  if (!candidate.dedupeKey.trim()) missing.push("dedupeKey");
  if (options.requireConfirmationTarget && !candidate.confirmationTarget.trim()) missing.push("confirmationTarget");
  if (candidate.assigneeResolution === "assigned" && !candidate.assignee) invalid.push("assignee");

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

export function parseSlackDigestMessage(value: unknown, defaultChannelId: string, defaultChannelName: string | null) {
  const input = asRecord(value);
  const type = stringValue(input.type);
  const subtype = stringValue(input.subtype);
  if ((type && type !== "message") || subtype) return null;
  const ts = stringValue(input.ts);
  const text = stringValue(input.text);
  if (!ts || !text) return null;
  return {
    workspaceId: stringValue(input.workspaceId) ?? stringValue(input.teamId),
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

type ParsedSlackDigestMessage = NonNullable<ReturnType<typeof parseSlackDigestMessage>>;

export function filterSlackDigestMessagesForCollectionScope(
  messages: ParsedSlackDigestMessage[],
  input: {
    workspaceId?: string | null;
    channelId: string;
    collectionScope: SlackCollectionScopeSettings;
    cursor?: SlackCursor | null;
    oldestTs?: string | null;
    latestTs?: string | null;
  }
): ParsedSlackDigestMessage[] {
  if (!matchesConfiguredChannel(input.collectionScope, input.channelId)) return [];

  return messages.filter((message) => {
    if (!matchesConfiguredWorkspace(input.collectionScope, message.workspaceId ?? input.workspaceId)) return false;
    return (
      matchesTimeWindow(message, input.cursor, input.oldestTs, input.latestTs) &&
      matchesConfiguredMessageFilters(message, input.collectionScope)
    );
  });
}

export function inferPriorityFromText(text: string): TaskPriority {
  const normalized = text.toLowerCase();
  if (/\bp0\b|긴급|urgent|blocker|장애/.test(normalized)) return "P0";
  if (/\bp1\b|important|중요|이번주|soon/.test(normalized)) return "P1";
  return "P2";
}

export function deriveSlackTaskCandidateContent(input: SlackTaskContentDerivationInput): SlackTaskContentDerivation {
  const messageText = input.messageText.trim();
  const title = inferSlackCandidateTitle(messageText, input.channelName ?? input.channelId ?? null);
  const dueAt = inferDueAtFromSlackText(messageText);
  const nextAction = inferNextActionFromSlackText(messageText, title);
  const contextMessages = (input.contextMessages ?? [])
    .filter((message) => message.text.trim())
    .filter((message) => message.text.trim() !== messageText)
    .slice(-4);
  const contextLines = contextMessages.map((message) => {
    const speaker = message.userId ? `<@${message.userId}>` : message.botId ? `bot:${message.botId}` : "unknown";
    return `- ${speaker}: ${message.text.trim()}`;
  });
  const descriptionLines = [
    "Slack task candidate:",
    "",
    `- Proposed title: ${title}`,
    input.requester ? `- Requester: ${input.requester}` : null,
    input.channelName ? `- Channel: #${input.channelName}` : input.channelId ? `- Channel: ${input.channelId}` : null,
    input.reason ? `- Reason: ${input.reason}` : null,
    dueAt ? `- Due: ${dueAt}` : null,
    nextAction ? `- Next action: ${nextAction}` : null,
    input.sourceUrl ? `- Source: ${input.sourceUrl}` : null,
    "",
    "Original message:",
    messageText
  ].filter((line): line is string => line !== null);

  if (contextLines.length) {
    descriptionLines.push("", "Relevant Slack context:", ...contextLines);
  }

  const relevantContext = Array.from(new Set([messageText, ...contextMessages.map((message) => message.text.trim()), input.sourceUrl ?? ""]))
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    title,
    description: descriptionLines.join("\n"),
    relevantContext,
    dueAt,
    nextAction
  };
}

function matchesConfiguredWorkspace(scope: SlackCollectionScopeSettings, workspaceId?: string | null): boolean {
  if (scope.workspaces.length === 0) return true;
  return Boolean(workspaceId && scope.workspaces.includes(workspaceId));
}

function matchesConfiguredChannel(scope: SlackCollectionScopeSettings, channelId: string): boolean {
  if (scope.channels.length === 0) return true;
  return scope.channels.includes(channelId);
}

function matchesTimeWindow(
  message: ParsedSlackDigestMessage,
  cursor?: SlackCursor | null,
  oldestTs?: string | null,
  latestTs?: string | null
): boolean {
  const lowerBound = latestSlackTs(cursor?.lastTs, oldestTs);
  if (lowerBound && compareSlackTs(message.ts, lowerBound) <= 0) return false;
  if (latestTs && compareSlackTs(message.ts, latestTs) > 0) return false;
  return true;
}

function matchesConfiguredMessageFilters(
  message: ParsedSlackDigestMessage,
  scope: SlackCollectionScopeSettings
): boolean {
  const hasThreadFilters = scope.threads.length > 0;
  const hasMentionFilters = scope.mentions.length > 0;
  const hasKeywordFilters = scope.keywords.length > 0;
  if (!hasThreadFilters && !hasMentionFilters && !hasKeywordFilters) return true;

  return (
    (hasThreadFilters && matchesThreadFilter(message, scope.threads)) ||
    (hasMentionFilters && matchesMentionFilter(message, scope.mentions)) ||
    (hasKeywordFilters && matchesKeywordFilter(message, scope.keywords))
  );
}

function matchesThreadFilter(message: ParsedSlackDigestMessage, threads: string[]): boolean {
  const candidates = [message.ts, message.threadTs, message.parentTs].filter((value): value is string => Boolean(value));
  return candidates.some((value) => threads.includes(value));
}

function matchesMentionFilter(message: ParsedSlackDigestMessage, mentions: string[]): boolean {
  const text = message.text.toLowerCase();
  const author = message.userId?.toLowerCase() ?? "";
  return mentions.some((mention) => {
    const normalized = mention.toLowerCase().replace(/^<@([a-z0-9]+)>$/i, "$1");
    if (/^[uw][a-z0-9]{2,}$/i.test(mention)) {
      return author === normalized || text.includes(`<@${normalized}>`);
    }
    return text.includes(normalized);
  });
}

function matchesKeywordFilter(message: ParsedSlackDigestMessage, keywords: string[]): boolean {
  const text = message.text.toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function latestSlackTs(...values: Array<string | null | undefined>): string | null {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => compareSlackTs(b, a))[0] ?? null;
}

function compareSlackTs(a: string, b: string): number {
  const aNumber = Number(a);
  const bNumber = Number(b);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return a.localeCompare(b);
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

export function buildSlackTaskCandidateConfirmationMessage(candidate: SlackTaskCandidateMetadata): SlackAction {
  const dueText = candidate.dueAt ? `Due: ${candidate.dueAt}` : "No due date inferred";
  const assigneeText = candidate.assignee ? `Assignee: ${candidate.assignee}` : "Assignee needs confirmation";
  const nextText = candidate.nextAction ? `Next: ${candidate.nextAction}` : "Review the proposed task before activation.";
  const sourceText = candidate.sourceUrl ? `<${candidate.sourceUrl}|Open source message>` : "Source Slack message unavailable";
  const channelText = candidate.sourceChannel.channelName
    ? `#${candidate.sourceChannel.channelName}`
    : candidate.sourceChannel.channelId;
  const requiredAction =
    candidate.confirmationState === "review_needed"
      ? "Required action: no response was received, so the leader must review and approve or reject this candidate."
      : candidate.confirmationState === "assigning"
        ? "Required action: choose the assignee, then approve or reject this candidate."
        : "Required action: approve or reject this candidate before it can become an active ATM task.";
  const description = compactText(candidate.taskDescription || candidate.messageText, 520);
  const defaultClassification = resolveSlackTaskCandidateClassification(candidate.taskClassification);
  const leaderContextElements = buildSlackTaskCandidateLeaderContextElements(candidate);
  const leaderReviewChannelId = isLeaderFacingSlackTaskCandidate(candidate)
    ? stringValue(candidate.leaderReviewChannelId)
    : null;
  const assigneeSelect = buildSlackTaskCandidateAssigneeSelect(candidate);

  return {
    kind: leaderReviewChannelId ? "thread_reply" : "dm",
    channelId: leaderReviewChannelId,
    threadTs: leaderReviewChannelId ? stringValue(candidate.leaderReviewThreadTs) ?? null : null,
    userId: candidate.confirmationTarget,
    text: `Approve task candidate: ${candidate.taskTitle}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Approve task candidate?*\n*${compactText(candidate.taskTitle, 150)}*\n${requiredAction}\n${description}`
        }
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `${candidate.candidateId} · ${candidate.confirmationState}` },
          { type: "mrkdwn", text: `Requester: ${candidate.requester}` },
          { type: "mrkdwn", text: `Channel: ${channelText}` },
          { type: "mrkdwn", text: assigneeText },
          { type: "mrkdwn", text: dueText },
          { type: "mrkdwn", text: nextText },
          { type: "mrkdwn", text: sourceText }
        ]
      },
      ...(leaderContextElements.length
        ? [
            {
              type: "context",
              elements: leaderContextElements
            }
          ]
        : []),
      {
        type: "actions",
        block_id: `atm_candidate_${candidate.candidateId}`,
        elements: [
          {
            type: "static_select",
            action_id: slackConfirmationActionId.candidateSelectClassification,
            placeholder: { type: "plain_text", text: "Classification" },
            initial_option: slackClassificationOption(defaultClassification),
            options: slackTaskCandidateClassificationOptions
          },
          ...(assigneeSelect ? [assigneeSelect] : []),
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            action_id: slackConfirmationActionId.candidateAccept,
            value: candidate.candidateId
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Reject" },
            style: "danger",
            action_id: slackConfirmationActionId.candidateDecline,
            value: candidate.candidateId
          }
        ]
      }
    ],
    metadata: {
      type: slackConfirmationCallbackId.taskCandidateConfirmation,
      callbackId: slackConfirmationCallbackId.taskCandidateConfirmation,
      candidateId: candidate.candidateId,
      dedupeKey: candidate.dedupeKey,
      defaultClassification,
      fallbackClassification: fallbackSlackTaskCandidateClassification,
      classificationOptions: slackTaskCandidateClassificationOptions,
      candidate
    }
  };
}

function buildSlackTaskCandidateLeaderContextElements(candidate: SlackTaskCandidateMetadata) {
  if (!isLeaderFacingSlackTaskCandidate(candidate)) return [];
  const profileText = summarizeSlackProfileContext(candidate.slackProfileContext ?? []);
  const identityText = summarizeSlackCandidateATMIdentityContext(candidate.atmIdentityContext);
  return [profileText, identityText]
    .filter((text): text is string => Boolean(text))
    .map((text) => ({ type: "mrkdwn", text }));
}

function buildSlackTaskCandidateAssigneeSelect(candidate: SlackTaskCandidateMetadata) {
  if (!isLeaderFacingSlackTaskCandidate(candidate) || !candidate.requiresAssigneeConfirmation) return null;
  const options = (candidate.assigneeOptions ?? [])
    .filter((option) => option.ownerId && option.ownerName && option.slackUserId)
    .slice(0, 100)
    .map((option) => ({
      text: { type: "plain_text" as const, text: compactText(option.ownerName, 75) },
      value: option.ownerId
    }));
  if (!options.length) return null;
  const initialOption = candidate.assignee
    ? options.find((option) => option.text.text === candidate.assignee || option.value === candidate.assignee)
    : null;
  return {
    type: "static_select",
    action_id: slackConfirmationActionId.candidateSelectAssignee,
    placeholder: { type: "plain_text", text: "Assignee" },
    ...(initialOption ? { initial_option: initialOption } : {}),
    options
  };
}

function isLeaderFacingSlackTaskCandidate(candidate: SlackTaskCandidateMetadata): boolean {
  return (
    Boolean(candidate.leaderReviewer && candidate.confirmationTarget === candidate.leaderReviewer) ||
    candidate.confirmationState === "assigning" ||
    candidate.confirmationState === "review_needed" ||
    Boolean(candidate.memberMappingUncertainties?.length)
  );
}

function summarizeSlackProfileContext(profiles: SlackTaskCandidateProfileContext[]): string | null {
  if (!profiles.length) return null;
  const summary = profiles
    .map((profile) => {
      const slackName = profile.slackUserId ?? profile.slackUserName ?? "unknown";
      const atmName = profile.atmOwnerName ?? profile.mappingStatus;
      const reason = profile.uncertaintyReason ? `/${profile.uncertaintyReason}` : "";
      return `${profile.role}:${slackName}->${atmName}${reason}`;
    })
    .join("; ");
  return compactText(`Slack profiles: ${summary}`, 300);
}

function summarizeSlackCandidateATMIdentityContext(identity?: SlackTaskCandidateATMIdentityContext): string | null {
  if (!identity) return null;
  const assignee = identity.assignee ?? "unassigned";
  const classification = identity.taskClassification ?? "general";
  return compactText(
    `ATM candidate: ${identity.candidateId} · ${identity.confirmationState} · ${classification} · ${assignee} · ${identity.dedupeKey}`,
    300
  );
}

export function resolveSlackTaskCandidateClassification(value: unknown): TaskCategory {
  return taskCategories.includes(value as TaskCategory)
    ? (value as TaskCategory)
    : fallbackSlackTaskCandidateClassification;
}

function slackClassificationOption(category: TaskCategory): SlackSelectOption {
  return {
    text: { type: "plain_text", text: slackTaskCandidateClassificationLabels[category] },
    value: category
  };
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
    workspaceId: stringValue(input.workspaceId) ?? stringValue(input.teamId),
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
  if (firstUserMessage) {
    return deriveSlackTaskCandidateContent({
      messageText: firstUserMessage.text,
      contextMessages: context.messages,
      channelName: context.channelName,
      channelId: context.channelId,
      requester: context.authorId ?? context.authorName,
      sourceUrl: context.permalink
    }).title;
  }
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

function inferSlackCandidateTitle(text: string, fallbackSource: string | null): string {
  const normalized = text
    .replace(/<@([A-Z0-9_]+)>/gi, "")
    .replace(/^\/task\b/i, "")
    .replace(/\b(taskify|please|pls|can you|could you|would you|can)\b/gi, "")
    .replace(/\b(make|create|add|turn|convert|log|file|open)\b.{0,24}\b(task|todo|to-do|action item)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,.:;\-\s]+/, "")
    .replace(/[,.:;\-\s]+$/, "");
  if (normalized) return compactText(capitalizeFirst(normalized), 96);
  return fallbackSource ? `Task from ${fallbackSource.startsWith("#") ? fallbackSource : `#${fallbackSource}`}` : "Slack task candidate";
}

function inferDueAtFromSlackText(text: string): string | null {
  const normalized = text.toLowerCase();
  const explicit = normalized.match(/\b(?:by|before|due(?: by)?)\s+([a-z0-9: ]{1,32})(?:[.,;!?]|$)/i)?.[1]?.trim();
  if (explicit) return explicit;
  if (/\beod\b|오늘\s*(중|까지)|퇴근\s*전/.test(normalized)) return "EOD";
  if (/\btoday\b|오늘/.test(normalized)) return "today";
  if (/\btomorrow\b|내일/.test(normalized)) return "tomorrow";
  if (/\bthis week\b|이번주/.test(normalized)) return "this week";
  if (/\bnext week\b|다음주/.test(normalized)) return "next week";
  return null;
}

function inferNextActionFromSlackText(text: string, title: string): string | null {
  const normalized = text.trim();
  const actionMatch = normalized.match(
    /\b(ship|fix|implement|update|review|check|confirm|prepare|send|follow up|follow-up|investigate|debug|deploy|write|draft|schedule|call|email|close|resolve|unblock|triage|merge|release|document|add|create)\b.{0,100}/i
  )?.[0];
  if (actionMatch) return compactText(capitalizeFirst(actionMatch.trim()), 120);
  const koreanMatch = normalized.match(/.{0,12}(수정|구현|확인|검토|처리|진행|배포|작성|공유|담당|정리).{0,60}/)?.[0];
  if (koreanMatch) return compactText(koreanMatch.trim(), 120);
  return title;
}

function capitalizeFirst(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function taskSortScore(task: Task): number {
  const statusScore = task.status === "blocked" ? 0 : task.status === "in_progress" ? 10 : 20;
  const priorityScore = task.priority === "P0" ? 0 : task.priority === "P1" ? 2 : 4;
  return statusScore + priorityScore;
}
