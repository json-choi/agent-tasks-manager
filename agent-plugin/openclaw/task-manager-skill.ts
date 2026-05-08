import {
  type ATMTaskificationRequest,
  clientFromEnv,
  createIntakeTraceId,
  normalizeSlackTaskificationRequest,
  parseSlackTaskificationRequest,
  TaskManagerApiError,
  type SlackMessageContext,
  type SlackCollectionScopeSettings,
  type SlackCollectionScopeSchema,
  type SlackCollectionScopeValidation,
  type SlackCollectionTarget,
  type TaskCommandContext,
  type TaskManagerClient
} from "../shared/task-manager-client";
import { fileURLToPath } from "node:url";

export interface OpenClawMessage {
  text: string;
  eventType?: string;
  workspaceId?: string;
  teamId?: string;
  userId?: string;
  botId?: string;
  botUserId?: string;
  agentUserId?: string;
  addressedUserIds?: string[];
  channelId?: string;
  channelName?: string;
  messageTs?: string;
  threadTs?: string;
  permalink?: string;
}

export interface OpenClawTaskManagerSkillOptions {
  client?: TaskManagerClient;
  agentName?: string;
  agentUserId?: string;
  botUserId?: string;
  logger?: Pick<Console, "error" | "info">;
}

export interface SlackCollectionScopeResponse {
  ok: true;
  collectionScope: SlackCollectionScopeSettings;
  collectionScopeSchema?: SlackCollectionScopeSchema;
  validation?: SlackCollectionScopeValidation;
  collectionReady?: boolean;
  targets: SlackCollectionTarget[];
}

export interface OpenClawSlackCollectionBatch {
  workspaceName?: string | null;
  channelName?: string | null;
  messages: Array<Record<string, unknown>>;
  nextLastTs?: string | null;
}

export type OpenClawSlackCollectionCollector = (
  target: SlackCollectionTarget,
  scope: SlackCollectionScopeResponse
) => Promise<OpenClawSlackCollectionBatch | Array<Record<string, unknown>>> | OpenClawSlackCollectionBatch | Array<Record<string, unknown>>;

export interface ScheduledSlackCollectionOptions {
  commitDigests?: boolean;
  createTasks?: boolean;
}

export interface ScheduledSlackCollectionResult {
  ok: true;
  collectionScope: SlackCollectionScopeSettings;
  targets: SlackCollectionTarget[];
  digests: Array<{
    workspaceId: string | null;
    channelId: string;
    threadCollectionMode: SlackCollectionTarget["threadCollectionMode"];
    messageCount: number;
    digestId: string | null;
    committed: boolean;
  }>;
  failures: Array<{
    workspaceId: string | null;
    channelId: string;
    threadCollectionMode: SlackCollectionTarget["threadCollectionMode"];
    stage: "collect" | "digest_collect" | "digest_commit";
    error: string;
  }>;
}

export function createOpenClawTaskManagerSkill(options: OpenClawTaskManagerSkillOptions = {}) {
  const envFilePath = fileURLToPath(new URL("./task-manager.env", import.meta.url));
  const client = options.client ?? clientFromEnv(undefined, envFilePath);
  const agentName = options.agentName ?? "OpenClaw";
  const logger = options.logger ?? console;

  return {
    name: "task-manager",

    async handleMessage(message: OpenClawMessage) {
      if (message.botId) return [];

      const commandContext: TaskCommandContext = {};
      if (message.eventType) commandContext.eventType = message.eventType;
      const agentUserId = message.agentUserId ?? options.agentUserId;
      if (agentUserId) commandContext.agentUserId = agentUserId;
      const botUserId = message.botUserId ?? options.botUserId;
      if (botUserId) commandContext.botUserId = botUserId;
      if (message.addressedUserIds) commandContext.addressedUserIds = message.addressedUserIds;

      const request = parseSlackTaskificationRequest(message, commandContext);
      if (!request) return [];
      const command = request.command;
      const context: SlackMessageContext = { ...request.context, agentName };

      if (command.type === "propose") {
        const actions = [];
        for (const normalized of normalizeSlackTaskificationRequest(request)) {
          const intakeTraceId = normalized.intakeTraceId ?? createIntakeTraceId(normalized.dedupeKey);
          try {
            const result = await client.proposeTask({ ...normalized, context, intakeTraceId });
            logger.info?.("atm.slack_taskification.routed", {
              intakeTraceId: result.intakeTraceId ?? intakeTraceId,
              dedupeKey: normalized.dedupeKey,
              workspaceId: normalized.workspaceId,
              channelId: normalized.channelId,
              messageTs: normalized.messageTs,
              taskId: result.task?.id ?? null,
              duplicate: result.duplicate === true
            });
            actions.push(...(result.actions ?? []));
          } catch (error) {
            const failedTraceId = error instanceof TaskManagerApiError ? (error.traceId ?? intakeTraceId) : intakeTraceId;
            const failureFeedback = slackRouteFailureFeedback({
              error,
              intakeTraceId: failedTraceId,
              dedupeKey: normalized.dedupeKey,
              channelId: normalized.channelId,
              threadTs: normalized.threadTs ?? normalized.messageTs
            });
            logger.error(
              "atm.slack_taskification.route_failed",
              routeFailureLogPayload({
                error,
                intakeTraceId: failedTraceId,
                fallbackTraceId: intakeTraceId,
                request,
                normalized,
                agentName
              })
            );
            if (failureFeedback) actions.push(failureFeedback);
          }
        }
        return actions;
      }

      if (command.type === "ask_assignee" && command.taskId) {
        const result = await client.askAssignee(command.taskId, command.assigneeId);
        return result.actions ?? [];
      }

      if (command.type === "status" && command.taskId) {
        const result = await client.statusSignal(command.taskId, command.signal, 0.85, false);
        return result.actions ?? [];
      }

      if (command.type === "today") {
        const result = await client.today(
          command.assigneeId ?? message.userId ?? null,
          message.channelId,
          message.threadTs ?? message.messageTs
        );
        return result.actions ?? [];
      }

      return [
        {
          kind: "thread_reply",
          channelId: message.channelId ?? null,
          threadTs: message.threadTs ?? message.messageTs ?? null,
          text: "I need a task id for that command."
        }
      ];
    },

    async handleInteraction(payload: unknown) {
      const result = await client.slackInteraction(payload);
      return result.actions ?? [];
    },

    async getSlackCollectionScope() {
      return client.slackCollectionScope();
    },

    async getScheduledSlackCollectionScope() {
      const scope = await client.slackCollectionScope();
      assertSlackCollectionScopeReady(scope);
      logger.info?.("atm.slack_collection.scope_loaded", {
        workspaces: scope.collectionScope.workspaces,
        channels: scope.collectionScope.channels,
        targets: scope.targets.map((target) => ({
          workspaceId: target.workspaceId,
          channelId: target.channelId,
          threadCollectionMode: target.threadCollectionMode
        }))
      });
      return scope;
    },

    async runScheduledSlackCollection(
      collectMessages: OpenClawSlackCollectionCollector,
      collectionOptions: ScheduledSlackCollectionOptions = {}
    ): Promise<ScheduledSlackCollectionResult> {
      const scope = await client.slackCollectionScope();
      assertSlackCollectionScopeReady(scope);
      const digests: ScheduledSlackCollectionResult["digests"] = [];
      const failures: ScheduledSlackCollectionResult["failures"] = [];
      const commitDigests = collectionOptions.commitDigests !== false;
      const createTasks = collectionOptions.createTasks !== false;

      logger.info?.("atm.slack_collection.scheduled_run_started", {
        targetCount: scope.targets.length,
        workspaces: scope.collectionScope.workspaces,
        channels: scope.collectionScope.channels
      });

      for (const target of scope.targets) {
        logger.info?.("atm.slack_collection.target_started", scheduledSlackCollectionTargetLogPayload(target));

        let batch: OpenClawSlackCollectionBatch;
        try {
          batch = normalizeSlackCollectionBatch(await collectMessages(target, scope));
        } catch (error) {
          recordScheduledSlackCollectionFailure(logger, failures, target, "collect", error);
          continue;
        }
        logger.info?.("atm.slack_collection.target_collected", {
          ...scheduledSlackCollectionTargetLogPayload(target),
          messageCount: batch.messages.length,
          nextLastTs: batch.nextLastTs ?? null
        });

        let digestId: string | null = null;
        try {
          const collectResult = await client.collectSlackDigest({
            workspaceId: target.workspaceId,
            workspaceName: batch.workspaceName ?? null,
            channelId: target.channelId,
            channelName: batch.channelName ?? null,
            messages: batch.messages,
            nextLastTs: batch.nextLastTs ?? null,
            threadCollectionMode: target.threadCollectionMode,
            includeThreads: target.threadCollectionMode !== "parent_messages",
            collectionScope: scope.collectionScope
          });
          digestId = digestIdFromCollectResult(collectResult);
        } catch (error) {
          recordScheduledSlackCollectionFailure(logger, failures, target, "digest_collect", error);
          continue;
        }

        let committed = false;
        if (commitDigests && digestId) {
          try {
            await client.commitSlackDigest({ digestId, createTasks });
            committed = true;
          } catch (error) {
            recordScheduledSlackCollectionFailure(logger, failures, target, "digest_commit", error);
          }
        }

        digests.push({
          workspaceId: target.workspaceId,
          channelId: target.channelId,
          threadCollectionMode: target.threadCollectionMode,
          messageCount: batch.messages.length,
          digestId,
          committed
        });
        logger.info?.("atm.slack_collection.target_completed", {
          ...scheduledSlackCollectionTargetLogPayload(target),
          messageCount: batch.messages.length,
          digestId,
          committed
        });
      }

      logger.info?.("atm.slack_collection.scheduled_run", {
        targetCount: scope.targets.length,
        digestCount: digests.length,
        committedCount: digests.filter((digest) => digest.committed).length,
        failureCount: failures.length
      });

      return {
        ok: true,
        collectionScope: scope.collectionScope,
        targets: scope.targets,
        digests,
        failures
      };
    },

    async pollOutbox(postActions: (actions: unknown[]) => Promise<void>) {
      const result = await client.getOutbox();
      for (const item of result.outbox ?? []) {
        if (Array.isArray(item.payload?.actions)) {
          await postActions(item.payload.actions);
        }
        await client.ackOutbox(item.id);
      }
    }
  };
}

function normalizeSlackCollectionBatch(
  input: OpenClawSlackCollectionBatch | Array<Record<string, unknown>>
): OpenClawSlackCollectionBatch {
  if (Array.isArray(input)) return { messages: input };
  return {
    workspaceName: input.workspaceName ?? null,
    channelName: input.channelName ?? null,
    messages: Array.isArray(input.messages) ? input.messages : [],
    nextLastTs: input.nextLastTs ?? null
  };
}

function digestIdFromCollectResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const digest = (result as { digest?: unknown }).digest;
  if (!digest || typeof digest !== "object") return null;
  const id = (digest as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

function scheduledSlackCollectionTargetLogPayload(target: SlackCollectionTarget) {
  return {
    workspaceId: target.workspaceId,
    channelId: target.channelId,
    threadCollectionMode: target.threadCollectionMode,
    cursorLastTs: target.cursor?.lastTs ?? null,
    includeThreads: target.threadCollectionMode !== "parent_messages"
  };
}

function recordScheduledSlackCollectionFailure(
  logger: Pick<Console, "error" | "info">,
  failures: ScheduledSlackCollectionResult["failures"],
  target: SlackCollectionTarget,
  stage: ScheduledSlackCollectionResult["failures"][number]["stage"],
  error: unknown
): void {
  const failure = {
    workspaceId: target.workspaceId,
    channelId: target.channelId,
    threadCollectionMode: target.threadCollectionMode,
    stage,
    error: error instanceof Error ? error.message : String(error)
  };
  failures.push(failure);
  logger.error?.("atm.slack_collection.target_failed", failure);
}

function assertSlackCollectionScopeReady(scope: SlackCollectionScopeResponse): void {
  const errors = slackCollectionScopeErrors(scope);
  if (errors.length > 0) {
    throw new Error(`Slack collection scope is not ready for scheduled collection: ${errors.join("; ")}`);
  }
}

function slackCollectionScopeErrors(scope: SlackCollectionScopeResponse): string[] {
  const errors: string[] = [];
  const invalid = scope.validation?.invalid ?? {};
  const duplicate = scope.validation?.duplicates ?? {};

  for (const [field, items] of Object.entries(invalid)) {
    for (const item of items) errors.push(`invalid ${field}: ${item}`);
  }
  for (const [field, items] of Object.entries(duplicate)) {
    for (const item of items) errors.push(`duplicate ${field}: ${item}`);
  }
  if (scope.collectionReady === false) errors.push("server marked collection scope as not ready");
  if (scope.collectionScope.channels.length === 0) errors.push("at least one channel must be configured");
  if (scope.targets.length === 0) errors.push("no collection targets were returned");
  return Array.from(new Set(errors));
}

function routeFailureLogPayload(input: {
  error: unknown;
  intakeTraceId: string | null;
  fallbackTraceId: string;
  request: NonNullable<ReturnType<typeof parseSlackTaskificationRequest>>;
  normalized: ATMTaskificationRequest;
  agentName: string;
}) {
  const apiError = input.error instanceof TaskManagerApiError ? input.error : null;
  const failureCause = {
    type: apiError ? "atm_api_error" : "unexpected_error",
    message: input.error instanceof Error ? input.error.message : String(input.error),
    status: apiError?.status ?? null,
    path: apiError?.path ?? null,
    traceId: apiError?.traceId ?? input.intakeTraceId,
    responseBody: apiError?.responseBody ?? null
  };

  return {
    intakeTraceId: input.intakeTraceId,
    fallbackTraceId: input.fallbackTraceId,
    dedupeKey: input.normalized.dedupeKey,
    route: {
      agentName: input.agentName,
      source: input.normalized.source,
      confirmationState: input.normalized.confirmationState,
      automatic: input.normalized.automatic,
      confirmed: input.normalized.confirmed
    },
    slack: {
      workspaceId: input.normalized.workspaceId,
      channelId: input.normalized.channelId,
      threadTs: input.normalized.threadTs,
      messageTs: input.normalized.messageTs,
      sourceUrl: input.normalized.sourceUrl ?? null,
      reporterId: input.request.reporterId,
      reporterName: input.request.reporterName,
      messageText: input.normalized.messageText
    },
    taskCandidate: {
      title: input.normalized.title,
      assignee: input.normalized.assignee ?? null,
      assigneeCandidates: input.normalized.assigneeCandidates,
      dueAt: input.normalized.dueAt ?? null,
      nextAction: input.normalized.nextAction ?? null,
      isWorkRelated: input.normalized.taskification?.isWorkRelated ?? true
    },
    failureCause,
    workspaceId: input.normalized.workspaceId,
    channelId: input.normalized.channelId,
    threadTs: input.normalized.threadTs,
    messageTs: input.normalized.messageTs,
    assignee: input.normalized.assignee ?? null,
    error: failureCause.message
  };
}

function slackRouteFailureFeedback(input: {
  error: unknown;
  intakeTraceId: string | null;
  dedupeKey: string | null;
  channelId: string | null;
  threadTs: string | null;
}) {
  if (!input.channelId || !input.threadTs) return null;

  const trace = input.intakeTraceId ?? input.dedupeKey ?? "unavailable";
  const reason = routeFailureSlackReason(input.error);
  return {
    kind: "thread_reply",
    channelId: input.channelId,
    threadTs: input.threadTs,
    text: `${reason} Trace: ${trace}.`,
    metadata: {
      type: "atm_slack_taskification_route_failure",
      traceId: input.intakeTraceId,
      dedupeKey: input.dedupeKey,
      actionable: isActionableRouteFailure(input.error)
    }
  };
}

function routeFailureSlackReason(error: unknown): string {
  if (!(error instanceof TaskManagerApiError)) {
    return "ATM could not intake this task candidate before the request reached the API. Ask an ATM admin to check the OpenClaw integration.";
  }

  if (error.status === 400 || error.status === 422) {
    return "ATM rejected this task candidate because required Slack taskification data is missing or invalid. Check the workspace, channel, and assignee mapping in ATM settings.";
  }
  if (error.status === 401 || error.status === 403) {
    return "ATM rejected this task candidate because OpenClaw is not authorized. Ask an ATM admin to refresh the OpenClaw agent token.";
  }
  if (error.status === 404) {
    return "ATM could not find the task intake endpoint. Ask an ATM admin to check TASK_MANAGER_API_URL and TASK_MANAGER_SLACK_TASKIFICATION_PATH.";
  }
  if (error.status === 409) {
    return "ATM could not intake this task candidate because it conflicts with an existing candidate.";
  }
  if (error.status === 429 || error.status === 408 || error.status >= 500) {
    return "ATM could not intake this task candidate because the service is temporarily unavailable. It is safe to retry later.";
  }

  return "ATM could not intake this task candidate. Ask an ATM admin to check the integration.";
}

function isActionableRouteFailure(error: unknown): boolean {
  if (!(error instanceof TaskManagerApiError)) return true;
  return error.status < 500 && error.status !== 408 && error.status !== 429;
}
