export type SlackTaskQualificationReason =
  | "explicit-task-language"
  | "mention-assignment"
  | "team-assignment"
  | "priority-work-item"
  | "commitment-with-deadline"
  | "korean-work-intent";

export const slackTaskificationEligibilityRuleIds = [
  "explicit-task-language",
  "mention-assignment",
  "team-assignment",
  "priority-work-item",
  "commitment-with-deadline",
  "korean-work-intent"
] as const satisfies readonly SlackTaskQualificationReason[];

export const slackTaskificationExclusionReasonIds = [
  "bot-origin",
  "empty",
  "casual",
  "no-work-action",
  "no-assignment-signal"
] as const;

export type SlackTaskQualificationExcludedReason = (typeof slackTaskificationExclusionReasonIds)[number];

export interface SlackTaskQualification {
  qualifies: boolean;
  isWorkRelated: boolean;
  reason: SlackTaskQualificationReason | null;
  excludedReason: SlackTaskQualificationExcludedReason | null;
}

export const slackTaskAssigneeResolutionStates = ["assigned", "unassigned", "ambiguous"] as const;

export type SlackTaskAssigneeResolution = (typeof slackTaskAssigneeResolutionStates)[number];

export interface SlackTaskQualificationOptions {
  addressedUserIds?: Iterable<string | null | undefined>;
}

export interface SlackTaskificationClassificationInput extends SlackTaskQualificationOptions {
  workspaceId?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  messageTs?: string | null;
  botId?: string | null;
}

export interface SlackTaskificationClassification extends SlackTaskQualification {
  schemaVersion: typeof slackTaskificationEligibilitySchema.version;
  workspaceId: string | null;
  channelId: string | null;
  threadTs: string | null;
  messageTs: string | null;
  messageText: string;
  assigneeCandidates: string[];
  assigneeResolution: SlackTaskAssigneeResolution;
  requiresAssigneeConfirmation: boolean;
}

export const slackTaskificationEligibilitySchema = {
  version: "slack_taskification_eligibility.v1",
  eligibilityRules: {
    "explicit-task-language": "Explicit task, todo, follow-up, action item, or Korean task language qualifies.",
    "mention-assignment": "A work-action message that mentions a non-bot Slack user and uses assignment language qualifies.",
    "team-assignment": "A work-action message asking the team, someone, or an owner to act qualifies.",
    "priority-work-item": "P0/P1, urgent, or blocker language with due-time language qualifies.",
    "commitment-with-deadline": "A stated work commitment with due-time language qualifies.",
    "korean-work-intent": "Korean conversational work-intent verbs qualify when a work action is present."
  },
  exclusionRules: {
    "bot-origin": "Bot-origin messages are excluded from Slack taskification.",
    empty: "Empty messages are excluded.",
    casual: "Thanks, acknowledgements, and generic task-list queries are excluded as chat.",
    "no-work-action": "Messages without a work action verb are excluded.",
    "no-assignment-signal": "Work-related discussion without assignment, priority, deadline, or taskification signal is not auto-proposed."
  },
  output: {
    fields: {
      schemaVersion: "string",
      workspaceId: "string|null",
      channelId: "string|null",
      threadTs: "string|null",
      messageTs: "string|null",
      messageText: "string",
      qualifies: "boolean",
      isWorkRelated: "boolean",
      reason: "SlackTaskQualificationReason|null",
      excludedReason: "SlackTaskQualificationExcludedReason|null",
      assigneeCandidates: "Slack user ids mentioned in the source message, excluding addressed bot ids",
      assigneeResolution: "assigned when exactly one assignee is detected, ambiguous for multi-target or group-owner wording, otherwise unassigned",
      requiresAssigneeConfirmation: "true when a work-related candidate lacks one clear assignee"
    },
    candidatePolicy: "Only qualifies=true messages become saved task candidates; isWorkRelated=true with qualifies=false requires confirmation instead of silent chat inclusion."
  }
} as const;

export function qualifySlackTaskificationMessage(
  text: string,
  options: SlackTaskQualificationOptions = {}
): SlackTaskQualification {
  const trimmed = text.trim();
  if (!trimmed) return excluded("empty", false);

  const normalized = trimmed.toLowerCase();
  if (isCasualSlackMessage(normalized)) return excluded("casual", false);

  if (hasExplicitTaskLanguage(normalized)) {
    return included("explicit-task-language");
  }

  if (hasSocialChatContext(normalized) && !hasWorkDomainContext(normalized)) return excluded("casual", false);

  const hasWorkAction = hasWorkActionLanguage(normalized);
  if (!hasWorkAction) return excluded("no-work-action", false);

  const addressedUserIds = normalizedAddressedUserIds(options.addressedUserIds ?? []);
  const hasUserMention = extractMentions(trimmed, addressedUserIds).length > 0;
  if (hasUserMention && hasAssignmentLanguage(normalized)) return included("mention-assignment");
  if (hasTeamAssignmentLanguage(normalized)) return included("team-assignment");
  if (hasPriorityWorkItemLanguage(normalized)) return included("priority-work-item");
  if (hasExplicitWorkCommitment(normalized)) return included("commitment-with-deadline");
  if (hasKoreanConversationalWorkIntent(normalized)) return included("korean-work-intent");

  return excluded("no-assignment-signal", true);
}

export function classifySlackTaskificationMessage(
  text: string,
  input: SlackTaskificationClassificationInput = {}
): SlackTaskificationClassification {
  const qualification = input.botId ? excluded("bot-origin", false) : qualifySlackTaskificationMessage(text, input);
  const addressedUserIds = normalizedAddressedUserIds(input.addressedUserIds ?? []);
  const assigneeCandidates = extractMentions(text, addressedUserIds);
  const assigneeResolution = resolveAssigneeResolution(text, qualification, assigneeCandidates);
  return {
    schemaVersion: slackTaskificationEligibilitySchema.version,
    workspaceId: input.workspaceId ?? null,
    channelId: input.channelId ?? null,
    threadTs: input.threadTs ?? null,
    messageTs: input.messageTs ?? null,
    messageText: text.trim(),
    ...qualification,
    assigneeCandidates,
    assigneeResolution,
    requiresAssigneeConfirmation: qualification.isWorkRelated && assigneeResolution !== "assigned"
  };
}

export function hasMentionTaskificationIntent(normalized: string): boolean {
  return (
    /\b(make|create|add|turn|convert|log|file|open)\b.{0,40}\b(task|todo|to-do|follow[ -]?up|action item)\b/.test(normalized) ||
    /\b(task|todo|to-do)\b.{0,20}\b(this|it|that)\b/.test(normalized) ||
    /\b(assign|owner)\b.{0,40}\b(this|it|that|to|for)\b/.test(normalized) ||
    /태스크.{0,12}(만들|추가|등록|정리)|할 일.{0,12}(넣|추가|등록)|업무.{0,12}(넣|추가|등록)|담당.{0,12}(해|지정)|액션.{0,12}(아이템|추가|등록)/.test(normalized)
  );
}

function included(reason: SlackTaskQualificationReason): SlackTaskQualification {
  return {
    qualifies: true,
    isWorkRelated: true,
    reason,
    excludedReason: null
  };
}

function excluded(excludedReason: NonNullable<SlackTaskQualification["excludedReason"]>, isWorkRelated: boolean): SlackTaskQualification {
  return {
    qualifies: false,
    isWorkRelated,
    reason: null,
    excludedReason
  };
}

function hasExplicitTaskLanguage(normalized: string): boolean {
  return /\/task|태스크|할 일|todo|to-do|action item|follow[- ]?up/.test(normalized);
}

function isCasualSlackMessage(normalized: string): boolean {
  const compact = normalized.replace(/<@[a-z0-9]+>/gi, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!compact) return true;
  if (/^(thanks|thank you|thx|ty|ok|okay|sounds good|sgtm|lol|haha|nice|great|awesome|고마워|감사|넵|네|오케이|좋아요)\b/.test(compact)) {
    return true;
  }
  if (/\b(what tasks do i have|do i have any tasks|any tasks for me|today my tasks|my tasks today|내 할 일)\b/.test(compact)) {
    return true;
  }
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|gm|안녕|안녕하세요)\b/.test(compact)) return true;
  return false;
}

function hasSocialChatContext(normalized: string): boolean {
  return (
    /\b(lunch|coffee|dinner|breakfast|snack|drink|drinks|happy hour|party|weekend|vacation|pto|holiday|birthday|joke|meme|movie|game|football|baseball|basketball|soccer|weather)\b/.test(normalized) ||
    /점심|커피|저녁|아침|간식|회식|주말|휴가|생일|농담|밈|날씨/.test(normalized)
  );
}

function hasWorkDomainContext(normalized: string): boolean {
  return (
    /\b(deploy|deployment|release|runbook|incident|outage|blocker|bug|regression|checkout|customer|client|ticket|issue|pr|pull request|merge|build|ci|test|spec|doc|docs|roadmap|deadline|launch|prod|production|staging|api|database|db|migration|invoice|contract|proposal|report|metric|dashboard|handoff|oncall|reviewer|owner)\b/.test(normalized) ||
    /배포|릴리스|장애|긴급|버그|회귀|고객|티켓|이슈|테스트|문서|런북|마감|출시|운영|스테이징|데이터베이스|계약|보고서|대시보드|담당/.test(normalized)
  );
}

function hasAssignmentLanguage(normalized: string): boolean {
  return (
    /\b(can|could|would|please|pls|need|needs|should|must|let'?s|assign|owner|take|handle|own|lead|drive|follow up|follow-up)\b/.test(normalized) ||
    /부탁|해주세요|해줘|맡아|담당|확인해|처리해|진행해/.test(normalized)
  );
}

function hasTeamAssignmentLanguage(normalized: string): boolean {
  return (
    /\b(someone|somebody|anyone|team|we|let'?s)\b.{0,80}\b(ship|fix|implement|update|review|check|confirm|prepare|send|follow up|follow-up|investigate|debug|deploy|write|draft|schedule|call|email|close|resolve|triage)\b/.test(normalized) ||
    /\b(who can|who will|need an owner|needs an owner|owner needed)\b/.test(normalized) ||
    /누가.{0,30}(해|맡|담당|확인|처리)|담당자.{0,20}(필요|정해|지정)/.test(normalized)
  );
}

function resolveAssigneeResolution(
  text: string,
  qualification: SlackTaskQualification,
  assigneeCandidates: string[]
): SlackTaskAssigneeResolution {
  if (assigneeCandidates.length === 1) return "assigned";
  if (assigneeCandidates.length > 1) return "ambiguous";
  if (!qualification.isWorkRelated) return "unassigned";
  return hasAmbiguousOwnerLanguage(text.toLowerCase()) ? "ambiguous" : "unassigned";
}

function hasAmbiguousOwnerLanguage(normalized: string): boolean {
  return (
    /\b(someone|somebody|anyone|team|we|let'?s|who can|who will|need an owner|needs an owner|owner needed)\b/.test(normalized) ||
    /누가|담당자|담당\s*(필요|정해|지정)/.test(normalized)
  );
}

function hasExplicitWorkCommitment(normalized: string): boolean {
  return (
    /\b(i'?ll|i will|we'?ll|we will)\b.{0,80}\b(ship|fix|implement|update|review|check|confirm|prepare|send|follow up|follow-up|investigate|debug|deploy|write|draft|schedule|call|email|close|resolve)\b/.test(normalized) &&
    /\b(by|before|due|eod|today|tomorrow|this week|next week|soon|p0|p1|urgent|blocker)\b/.test(normalized)
  );
}

function hasPriorityWorkItemLanguage(normalized: string): boolean {
  return (
    /\b(p0|p1|urgent|blocker)\b/.test(normalized) &&
    /\b(by|before|due|eod|today|tomorrow|this week|next week|soon)\b/.test(normalized)
  );
}

function hasKoreanConversationalWorkIntent(normalized: string): boolean {
  return /해야|해줘|해주세요|필요|수정|구현|확인|검토|처리|진행|배포|작성|공유|담당|장애|긴급/.test(normalized);
}

function hasWorkActionLanguage(normalized: string): boolean {
  return (
    /\b(ship|fix|implement|update|review|check|confirm|prepare|send|follow up|follow-up|investigate|debug|deploy|write|draft|schedule|call|email|close|resolve|unblock|triage|merge|release|document|add|create)\b/.test(normalized) ||
    /해야|해줘|해주세요|필요|수정|구현|확인|검토|처리|진행|배포|작성|공유|담당|장애|긴급/.test(normalized)
  );
}

function extractMentions(text: string, ignoredUserIds: Set<string>): string[] {
  const seen = new Set<string>();
  const userIds: string[] = [];
  const matches = text.matchAll(/<@([A-Z0-9_]+)>/gi);
  for (const match of matches) {
    const userId = match[1];
    const normalized = userId?.toUpperCase();
    if (userId && normalized && !ignoredUserIds.has(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      userIds.push(userId);
    }
  }
  return userIds;
}

function normalizedAddressedUserIds(userIds: Iterable<string | null | undefined>): Set<string> {
  return new Set(
    [...userIds]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toUpperCase())
  );
}
