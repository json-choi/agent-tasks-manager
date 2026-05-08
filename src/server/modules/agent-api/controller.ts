import { Elysia } from "elysia";
import { adapterFor } from "../../adapters/agent-adapter";
import type { ServerContext } from "../../context";
import { syncTaskToGitHub } from "../../services/github-sync.service";
import { invitationUrl, memberInvitationToken, memberInviteAction } from "../../services/member-invitation.service";
import {
  buildSlackTaskCandidateConfirmationMessage,
  deriveSlackTaskCandidateContent,
  detectSlackMemberMappingUncertainties,
  filterCardTasks,
  filterSlackDigestMessagesForCollectionScope,
  inferPriorityFromText,
  inferTitle,
  parseSlackDigestMessage,
  parseThreadContext,
  renderTaskCardsText,
  renderThreadDescription,
  validateSlackTaskCandidateMetadata
} from "../../services/slack-task.service";
import { inferTaskCategory } from "../../services/task-classification.service";
import {
  parseSlackConfirmationActionId,
  parseSlackConfirmationCallbackId,
  parseSlackConfirmationResponseState,
  parseSlackCollectionScopeSettings,
  parseSlackThreadCollectionMode,
  parseTaskCategory,
  parseTaskPriority,
  parseTaskState,
  signalToStatus,
  validateSlackCollectionScopeForCollection
} from "../../shared/parsers";
import { slackCollectionScopeSchema, slackConfirmationActionId, slackConfirmationCallbackId } from "../../shared/types";
import type {
  AgentSettings,
  AgentThreadContext,
  AssignmentRequest,
  OutboxItem,
  OwnerMapping,
  SlackAction,
  SlackCollectionScopeSettings,
  SlackConfirmationAction,
  SlackConfirmationPayload,
  SlackMemberMappingUncertainty,
  SlackMemberMappingUncertaintyReason,
  SlackTaskCandidateATMIdentityContext,
  SlackTaskCandidateAssigneeOption,
  SlackTaskCandidateConfirmationRequest,
  SlackTaskCandidateMetadata,
  SlackTaskCandidateProfileContext,
  SlackTaskCandidateProfileContextRole,
  Task,
  TaskState
} from "../../shared/types";
import { asRecord, booleanValue, jsonResponse, newId, numberValue, safeJsonParse, stringValue } from "../../shared/utils";

export function agentApiController({ config, store, requireAgent }: ServerContext) {
  return new Elysia({ name: "agent-api.controller" })
    .post("/api/agent/connect/test", ({ request, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      store.markAgentSeen(auth.agent.id);
      store.recordSlackWorkspaceConnection(auth.agent, input);
      store.recordEvent(auth.agent.id, "agent.connect.test", input);
      return {
        ok: true,
        agent: store.getAgent(auth.agent.id),
        serverTime: new Date().toISOString()
      };
    })
    .post("/api/agent/slack/digest/collect", ({ request, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const channelId = stringValue(input.channelId);
      if (!channelId) return jsonResponse({ error: "channelId is required" }, 400);
      const savedCollectionScope = store.getSlackCollectionScopeSettings();
      const manualScopeOverride = parseManualSlackCollectionScopeOverride(input);
      const collectionScope = manualScopeOverride
        ? mergeSlackCollectionScopeForManualCollection(savedCollectionScope, manualScopeOverride.parsed)
        : savedCollectionScope;
      const cursor = store.getSlackCursor(auth.agent.id, channelId);
      const threadCollectionMode =
        parseSlackThreadCollectionMode(input.threadCollectionMode) ??
        collectionScope.channelThreadScopes[channelId] ??
        (booleanValue(input.includeThreads) === false ? "parent_messages" : "active_threads");
      const rawMessages = Array.isArray(input.messages) ? input.messages : [];
      const parsedMessages = rawMessages
        .map((message) => parseSlackDigestMessage(message, channelId, stringValue(input.channelName)))
        .filter((message): message is NonNullable<ReturnType<typeof parseSlackDigestMessage>> => Boolean(message));
      const messages = filterSlackDigestMessagesForCollectionScope(parsedMessages, {
        workspaceId: stringValue(input.workspaceId) ?? stringValue(input.teamId),
        channelId,
        collectionScope,
        cursor,
        oldestTs: stringValue(input.oldestTs) ?? stringValue(input.oldest),
        latestTs: stringValue(input.latestTs) ?? stringValue(input.latest)
      });

      const digest = store.createSlackDigest(auth.agent.id, {
        workspaceId: stringValue(input.workspaceId) ?? stringValue(input.teamId),
        channelId,
        channelName: stringValue(input.channelName),
        messages,
        nextLastTs: stringValue(input.nextLastTs),
        includeThreads: threadCollectionMode !== "parent_messages",
        threadCollectionMode,
        collectionScope,
        collectionScopeSource: manualScopeOverride ? "manual_override" : "saved",
        collectionTrigger: parseSlackCollectionTrigger(input.collectionTrigger) ?? (manualScopeOverride ? "manual" : "scheduled"),
        receivedMessageCount: rawMessages.length,
        parsedMessageCount: parsedMessages.length
      });
      store.markAgentSeen(auth.agent.id);
      store.recordSlackWorkspaceConnection(auth.agent, input);

      return {
        ok: true,
        digest,
        threadCollectionMode,
        cursor,
        collectionFilter: {
          receivedMessages: rawMessages.length,
          parsedMessages: parsedMessages.length,
          retainedMessages: messages.length
        },
        collectionScope,
        collectionScopeSource: manualScopeOverride ? "manual_override" : "saved",
        collectionScopeOverride: manualScopeOverride?.parsed ?? null
      };
    })
    .get("/api/agent/slack/collection-scope", ({ request }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const collectionScope = store.getSlackCollectionScopeSettings();
      const validation = validateSlackCollectionScopeForCollection(collectionScope);
      const workspaceIds = collectionScope.workspaces.length ? collectionScope.workspaces : [null];
      const targets = collectionScope.channels.flatMap((channelId) =>
        workspaceIds.map((workspaceId) => ({
          workspaceId,
          channelId,
          threadCollectionMode: collectionScope.channelThreadScopes[channelId] ?? "active_threads",
          cursor: store.getSlackCursor(auth.agent.id, channelId)
        }))
      );
      store.markAgentSeen(auth.agent.id);

      return {
        ok: true,
        collectionScope,
        collectionScopeSchema: slackCollectionScopeSchema,
        validation,
        collectionReady: !validation.hasInvalid && !validation.hasDuplicates && targets.length > 0,
        targets
      };
    })
    .get("/api/agent/slack/messages/unprocessed", ({ request, query }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const filters: {
        agentId: string;
        workspaceId?: string;
        channelId?: string;
        collectionRunId?: string;
        digestId?: string;
        limit?: number;
      } = { agentId: auth.agent.id };
      const workspaceId = stringValue(query.workspaceId) ?? stringValue(query.teamId);
      const channelId = stringValue(query.channelId);
      const collectionRunId = stringValue(query.collectionRunId);
      const digestId = stringValue(query.digestId);
      const limit = numberValue(query.limit);
      if (workspaceId) filters.workspaceId = workspaceId;
      if (channelId) filters.channelId = channelId;
      if (collectionRunId) filters.collectionRunId = collectionRunId;
      if (digestId) filters.digestId = digestId;
      if (limit !== null) filters.limit = limit;

      const messages = store.listUnprocessedSlackCollectedMessages(filters);
      store.markAgentSeen(auth.agent.id);

      return {
        ok: true,
        count: messages.length,
        messages
      };
    })
    .get("/api/agent/slack/task-candidate-confirmations/no-response-timeouts", ({ request }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const timeoutMinutes = config.slackConfirmationNoResponseTimeoutMinutes;
      const detectedAt = new Date();
      const thresholdAt = new Date(detectedAt.getTime() - timeoutMinutes * 60 * 1000).toISOString();
      const confirmations = store.transitionSlackTaskCandidateConfirmationsPastNoResponseTimeoutToReviewNeeded(
        auth.agent.id,
        timeoutMinutes,
        detectedAt
      );
      const reviewNeededOutbox = confirmations
        .map((confirmation) => enqueueSlackTaskCandidateReviewNeededNotification(store, auth.agent, confirmation))
        .filter((outbox): outbox is OutboxItem => Boolean(outbox));
      store.markAgentSeen(auth.agent.id);
      store.recordEvent(auth.agent.id, "agent.slack.task_candidate_confirmation.no_response_timeouts.detected", {
        timeoutMinutes,
        thresholdAt,
        count: confirmations.length,
        transitionedCount: confirmations.length,
        notifiedLeaderCount: reviewNeededOutbox.length,
        confirmationIds: confirmations.map((confirmation) => confirmation.id),
        notificationOutboxIds: reviewNeededOutbox.map((outbox) => outbox.id),
        dedupeKeys: confirmations.map((confirmation) => confirmation.dedupeKey)
      });

      return {
        ok: true,
        timeoutMinutes,
        thresholdAt,
        count: confirmations.length,
        transitionedCount: confirmations.length,
        notifiedLeaderCount: reviewNeededOutbox.length,
        reviewNeededOutbox,
        confirmations
      };
    })
    .post("/api/agent/slack/digest/commit", async ({ request, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const digestId = stringValue(input.digestId);
      if (!digestId) return jsonResponse({ error: "digestId is required" }, 400);
      try {
        const selectedCandidateIds = Array.isArray(input.selectedCandidateIds)
          ? input.selectedCandidateIds
              .map((candidateId) => stringValue(candidateId))
              .filter((candidateId): candidateId is string => Boolean(candidateId))
          : undefined;
        const commitInput = {
          digestId,
          createTasks: booleanValue(input.createTasks) ?? true
        };
        const result = store.commitSlackDigest(
          auth.agent,
          selectedCandidateIds ? { ...commitInput, selectedCandidateIds } : commitInput
        );
        const githubSettings = store.getGitHubSettings();
        const categorizedTasks = result.tasks.map((task) => {
          const category = inferTaskCategory(task, githubSettings);
          return task.category === category ? task : store.updateTask(task.id, { category }) ?? task;
        });
        const githubSync = await Promise.all(categorizedTasks.map((task) => syncTaskToGitHub(store, task, githubSettings)));
        const tasks = categorizedTasks.map((task) => store.getTask(task.id) ?? task);
        const digestCandidateByDedupeKey = new Map(
          result.digest.payload.candidates.map((candidate) => [
            `slack:${candidate.workspaceId ?? "unknown"}:${candidate.channelId}:${candidate.threadTs ?? candidate.ts}:${candidate.assigneeSlackUserId ?? "unassigned"}`,
            candidate
          ])
        );
        const confirmationOutbox = tasks
          .map((task) => {
            const digestCandidate = task.dedupeKey ? digestCandidateByDedupeKey.get(task.dedupeKey) : undefined;
            const assigneeOwner = digestCandidate?.assigneeSlackUserId
              ? resolveAssignmentOwner(store, digestCandidate.assigneeSlackUserId)
              : null;
            return enqueueSlackTaskCandidateConfirmation(
              store,
              auth.agent,
              task,
              digestCandidate
                ? {
                    context: {
                      workspaceId: digestCandidate.sourceChannel.workspaceId,
                      channelId: digestCandidate.channelId,
                      channelName: digestCandidate.channelName,
                      threadTs: digestCandidate.threadTs ?? digestCandidate.ts,
                      messageTs: digestCandidate.ts,
                      authorId: digestCandidate.userId,
                      authorName: digestCandidate.userName,
                      permalink: digestCandidate.permalink,
                      agentName: auth.agent.name,
                      messages: digestCandidate.userId
                        ? [{ userId: digestCandidate.userId, text: digestCandidate.text, ts: digestCandidate.ts }]
                        : [{ text: digestCandidate.text, ts: digestCandidate.ts }]
                    },
                    messageText: digestCandidate.text,
                    assigneeOwner,
                    assigneeCandidates: digestCandidate.classification.assigneeCandidates,
                    assigneeResolution: digestCandidate.assigneeResolution,
                    requiresAssigneeConfirmation: digestCandidate.requiresAssigneeConfirmation || !assigneeOwner,
                    ...(digestCandidate.memberMappingUncertainties
                      ? { memberMappingUncertainties: digestCandidate.memberMappingUncertainties }
                      : {}),
                    leaderReviewer: digestCandidate.userId ?? null,
                    relevantContext: digestCandidate.relevantContext
                  }
                : {}
            );
          })
          .filter((result) => result.outbox)
          .map((result) => result.outbox);
        return {
          ok: true,
          ...result,
          tasks,
          githubSync,
          confirmationOutbox,
          actions: tasks.map((task) => adapterFor(auth.agent.type).createTask(task, false)).flat()
        };
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : "Digest commit failed" }, 404);
      }
    })
    .post("/api/agent/thread/capture", ({ request, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const context = parseThreadContext(input, auth.agent);
      const adapter = adapterFor(auth.agent.type);
      store.markAgentSeen(auth.agent.id);
      store.recordSlackWorkspaceConnection(auth.agent, input);
      store.recordEvent(auth.agent.id, "agent.thread.capture", context);

      return {
        ok: true,
        context,
        channelMode: store.getChannelMode(context.channelId ?? null),
        actions: adapter.captureThread(context)
      };
    })
    .post("/api/agent/task/propose", async ({ request, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const taskification = asRecord(input.taskification ?? input.taskificationMetadata);
      const context = parseThreadContext(input.context ?? body, auth.agent);
      const automatic = booleanValue(input.automatic) === true;
      const channelMode = store.getChannelMode(context.channelId ?? null);
      const intakeTraceId =
        stringValue(input.intakeTraceId) ??
        stringValue(taskification.intakeTraceId) ??
        request.headers.get("x-atm-intake-trace-id")?.trim() ??
        newId("intake");

      store.markAgentSeen(auth.agent.id);
      store.recordSlackWorkspaceConnection(auth.agent, asRecord(input.context ?? input));
      store.recordEvent(auth.agent.id, "agent.task.propose.request", { intakeTraceId, context, body: input });

      if (automatic && channelMode === "manual_only") {
        store.recordEvent(auth.agent.id, "agent.task.propose.ignored", {
          intakeTraceId,
          channelMode,
          reason: "Channel is manual_only",
          workspaceId: context.workspaceId ?? null,
          channelId: context.channelId ?? null,
          threadTs: context.threadTs ?? null,
          messageTs: context.messageTs ?? null
        });
        return {
          ok: true,
          intakeTraceId,
          ignored: true,
          reason: "Channel is manual_only",
          channelMode,
          actions: []
        };
      }

      try {
        const explicitTitle = stringValue(input.title) ?? stringValue(taskification.taskTitle);
        const explicitDescription = stringValue(input.description) ?? stringValue(taskification.taskDescription);
        const messageText =
          stringValue(input.messageText) ??
          stringValue(taskification.messageText) ??
          context.messages?.find((message) => !message.botId && message.text.trim())?.text ??
          "";
        const derivedContent = messageText
          ? deriveSlackTaskCandidateContent({
              messageText,
              contextMessages: context.messages,
              channelName: context.channelName,
              channelId: context.channelId,
              requester: context.authorId ?? context.authorName,
              sourceUrl: context.permalink ?? stringValue(input.sourceUrl) ?? stringValue(taskification.sourceUrl),
              reason: stringValue(taskification.reason)
            })
          : null;
        const title = explicitTitle ?? derivedContent?.title ?? inferTitle(context);
        const description =
          explicitDescription ?? derivedContent?.description ?? renderThreadDescription(context);
        const shouldUseDerivedTaskHints = !explicitTitle && !explicitDescription;
        const confirmed = booleanValue(input.confirmed) === true;
        const githubRef = stringValue(input.githubRef);
        const initiative = stringValue(input.initiative);
        const requestedAssignee = stringValue(input.assignee) ?? stringValue(taskification.assignee);
        const suggestedOwner = requestedAssignee ? resolveAssignmentOwner(store, requestedAssignee) : null;
        const inputAssigneeCandidates = stringArray(input.assigneeCandidates);
        const assigneeCandidates = inputAssigneeCandidates.length
          ? inputAssigneeCandidates
          : stringArray(taskification.assigneeCandidates);
        if (requestedAssignee && !assigneeCandidates.includes(requestedAssignee)) assigneeCandidates.push(requestedAssignee);
        const parsedAssigneeResolution =
          parseSlackTaskAssigneeResolution(input.assigneeResolution) ??
          parseSlackTaskAssigneeResolution(taskification.assigneeResolution);
        const assigneeResolution =
          parsedAssigneeResolution ?? (suggestedOwner ? "assigned" : requestedAssignee ? "unassigned" : undefined);
        const parsedRequiresAssigneeConfirmation =
          booleanValue(input.requiresAssigneeConfirmation) ??
          booleanValue(taskification.requiresAssigneeConfirmation);
        const requiresAssigneeConfirmation = parsedRequiresAssigneeConfirmation ?? !suggestedOwner;
        const memberMappingUncertainties = detectSlackMemberMappingUncertainties(
          {
            authorId: context.authorId,
            authorName: context.authorName,
            assigneeCandidates
          },
          (value) => store.resolveOwner(value)
        );
        const category = inferTaskCategory(
          { category: input.category, title, description, initiative, githubRef },
          store.getGitHubSettings()
        );
        const dedupeKey =
          stringValue(input.dedupeKey) ??
          stringValue(taskification.dedupeKey) ??
          buildSlackTaskCandidateDedupeKey(context, suggestedOwner?.slackUserId ?? requestedAssignee ?? "unassigned");
        const assigneeKey = suggestedOwner?.slackUserId ?? requestedAssignee ?? "unassigned";
        const sourceDuplicate = findSlackTaskCandidateTaskBySourceIdentity(store, auth.agent.id, context, assigneeKey);
        const result = sourceDuplicate
          ? { task: sourceDuplicate, duplicate: true }
          : store.createTask({
              title,
              description,
              status: confirmed ? "confirmed" : "proposed",
              priority: parseTaskPriority(input.priority) ?? inferPriorityFromText(`${title} ${description}`),
              category,
              assignee: suggestedOwner?.ownerName ?? null,
              reporter: stringValue(input.reporter) ?? context.authorName ?? context.authorId ?? null,
              notify: booleanValue(input.notify) ?? true,
              initiative,
              nextAction:
                stringValue(input.nextAction) ??
                stringValue(taskification.nextAction) ??
                (shouldUseDerivedTaskHints ? derivedContent?.nextAction ?? null : null),
              result: stringValue(input.result),
              githubRef,
              channelId: context.channelId ?? null,
              threadTs: context.threadTs ?? null,
              sourceAgentId: auth.agent.id,
              sourceAgentName: context.agentName ?? auth.agent.name,
              sourceAuthor: context.authorId ?? context.authorName ?? null,
              sourceUrl: context.permalink ?? stringValue(input.sourceUrl) ?? stringValue(taskification.sourceUrl) ?? null,
              dueAt:
                stringValue(input.dueAt) ??
                stringValue(taskification.dueAt) ??
                (shouldUseDerivedTaskHints ? derivedContent?.dueAt ?? null : null),
              dedupeKey
            });
        const githubSync = await syncTaskToGitHub(store, result.task);
        let task = store.getTask(result.task.id) ?? result.task;
        const confirmation = enqueueSlackTaskCandidateConfirmation(store, auth.agent, task, {
          context,
          messageText: messageText || `${title}\n${description}`,
          assigneeOwner: suggestedOwner,
          assigneeCandidates,
          memberMappingUncertainties,
          leaderReviewer: stringValue(taskification.leaderReviewer),
          leaderReviewChannelId: stringValue(input.leaderReviewChannelId) ?? stringValue(taskification.leaderReviewChannelId),
          leaderReviewThreadTs: stringValue(input.leaderReviewThreadTs) ?? stringValue(taskification.leaderReviewThreadTs),
          confirmationTarget: stringValue(taskification.confirmationTarget),
          ...(derivedContent?.relevantContext ? { relevantContext: derivedContent.relevantContext } : {}),
          ...(assigneeResolution ? { assigneeResolution } : {}),
          ...(requiresAssigneeConfirmation !== null ? { requiresAssigneeConfirmation } : {}),
          confirmationState:
            parseCandidateConfirmationState(input.confirmationState) ??
            parseCandidateConfirmationState(taskification.confirmationState) ??
            (suggestedOwner ? "proposed" : "assigning")
        });

        const adapter = adapterFor(auth.agent.type);
        const assignment = suggestedOwner && !result.duplicate
          ? createAssignmentRequestForOwner(store, auth.agent, task, suggestedOwner, {
              requestedBy: context.authorId ?? context.authorName ?? null
            })
          : null;
        if (assignment) task = assignment.task;
        const actions = [...adapter.createTask(task, result.duplicate), ...(assignment?.actions ?? [])];
        store.recordEvent(auth.agent.id, "agent.task.propose.routed", {
          intakeTraceId,
          dedupeKey,
          duplicate: result.duplicate,
          taskId: task.id,
          confirmationOutboxId: confirmation.outbox?.id ?? null,
          assignmentRequestId: assignment?.assignmentRequest.id ?? null,
          actionCount: actions.length,
          memberMappingUncertainties,
          workspaceId: context.workspaceId ?? null,
          channelId: context.channelId ?? null,
          threadTs: context.threadTs ?? null,
          messageTs: context.messageTs ?? null
        });
        return {
          ok: true,
          intakeTraceId,
          duplicate: result.duplicate,
          channelMode,
          task,
          githubSync,
          assignmentRequest: assignment?.assignmentRequest,
          confirmationOutbox: confirmation.outbox,
          actions
        };
      } catch (error) {
        store.recordEvent(auth.agent.id, "agent.task.propose.failed", {
          intakeTraceId,
          workspaceId: context.workspaceId ?? null,
          channelId: context.channelId ?? null,
          threadTs: context.threadTs ?? null,
          messageTs: context.messageTs ?? null,
          error: error instanceof Error ? error.message : String(error)
        });
        return jsonResponse(
          {
            ok: false,
            intakeTraceId,
            error: error instanceof Error ? error.message : "Task proposal failed"
          },
          500
        );
      }
    })
    .post("/api/agent/task/:id/assignment-response", ({ request, params, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const accepted = booleanValue(input.accepted);
      const delegateOwnerId = stringValue(input.delegateOwnerId) ?? stringValue(input.delegateToOwnerId);
      const delegateAssignee =
        stringValue(input.delegateAssigneeId) ??
        stringValue(input.delegateTo) ??
        stringValue(input.assigneeId) ??
        stringValue(input.assignee);
      const current = store.getTask(params.id);
      if (!current) return jsonResponse({ error: "Task not found" }, 404);

      const pendingRequest = stringValue(input.requestId)
        ? store.getAssignmentRequest(stringValue(input.requestId)!)
        : null;
      if (pendingRequest && pendingRequest.status !== "pending") {
        return jsonResponse({ error: "Assignment request is no longer pending." }, 409);
      }
      let task: Task | null = null;
      let actions: SlackAction[] = [];

      if (accepted === true) {
        task = store.updateTask(params.id, {
          status: "in_progress",
          assignee: pendingRequest?.ownerName ?? current.assignee ?? delegateAssignee ?? null
        });
        if (pendingRequest) {
          store.updateAssignmentRequest(pendingRequest.id, {
            status: "accepted",
            responseText: stringValue(input.text)
          });
        }
      } else if (accepted === false && (delegateOwnerId || delegateAssignee)) {
        const owner = resolveAssignmentOwner(store, delegateOwnerId ?? delegateAssignee);
        if (!owner) return jsonResponse({ error: "Delegate owner must be an active owner with a Slack user ID." }, 400);
        if (pendingRequest) {
          store.updateAssignmentRequest(pendingRequest.id, {
            status: "delegated",
            responseText: stringValue(input.text)
          });
        }
        const result = createAssignmentRequestForOwner(store, auth.agent, current, owner, {
          previousRequestId: pendingRequest?.id ?? null,
          requestedBy: pendingRequest?.ownerName ?? stringValue(input.requestedBy)
        });
        task = result.task;
        actions = result.actions;
      } else {
        task = store.updateTask(params.id, { status: accepted === false ? "blocked" : "assigning" });
        if (pendingRequest) store.updateAssignmentRequest(pendingRequest.id, {
          status: accepted === false ? "declined" : "pending",
          responseText: stringValue(input.text)
        });
      }
      if (!task) return jsonResponse({ error: "Task not found" }, 404);

      store.markAgentSeen(auth.agent.id);
      store.recordEvent(auth.agent.id, "agent.task.assignment_response", {
        taskId: task.id,
        accepted,
        requestId: pendingRequest?.id ?? null,
        delegateOwnerId,
        delegateAssignee,
        text: stringValue(input.text)
      });

      const adapter = adapterFor(auth.agent.type);
      return {
        ok: true,
        task,
        actions: actions.length
          ? actions
          : adapter.postTaskUpdate(
              task,
              accepted === true
                ? `${task.id} assigned to ${task.assignee ?? "the requested owner"} and moved to in_progress.`
                : `${task.id} assignment needs attention.`
            )
      };
    })
    .post("/api/agent/task/:id/ask-assignee", ({ request, params, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const task = store.getTask(params.id);
      if (!task) return jsonResponse({ error: "Task not found" }, 404);

      const assignee = stringValue(input.assigneeId) ?? stringValue(input.assignee);
      const owner = resolveAssignmentOwner(store, assignee);
      if (!owner) return jsonResponse({ error: "Assignee must be an active owner with a Slack user ID." }, 400);
      const result = createAssignmentRequestForOwner(store, auth.agent, task, owner, {
        requestedBy: stringValue(input.requestedBy)
      });

      store.markAgentSeen(auth.agent.id);
      store.recordEvent(auth.agent.id, "agent.task.ask_assignee", {
        taskId: task.id,
        assignee,
        ownerId: owner.id,
        requestId: result.assignmentRequest.id
      });

      return {
        ok: true,
        task: result.task,
        assignmentRequest: result.assignmentRequest,
        actions: result.actions
      };
    })
    .post("/api/agent/task/:id/assignment-request", ({ request, params, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const task = store.getTask(params.id);
      if (!task) return jsonResponse({ error: "Task not found" }, 404);
      const owner = resolveAssignmentOwner(
        store,
        stringValue(input.ownerId) ?? stringValue(input.assigneeId) ?? stringValue(input.assignee)
      );
      if (!owner) return jsonResponse({ error: "Assignee must be an active owner with a Slack user ID." }, 400);
      const result = createAssignmentRequestForOwner(store, auth.agent, task, owner, {
        previousRequestId: stringValue(input.previousRequestId),
        requestedBy: stringValue(input.requestedBy)
      });
      store.markAgentSeen(auth.agent.id);
      store.recordEvent(auth.agent.id, "agent.task.assignment_request", {
        taskId: result.task.id,
        ownerId: owner.id,
        requestId: result.assignmentRequest.id
      });
      return { ok: true, ...result };
    })
    .post("/api/agent/slack/interaction", async ({ request, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const validation = validateSlackInteractionCallback(body, { store, agentId: auth.agent.id });
      if (!validation.ok) return jsonResponse({ error: validation.error }, 400);

      const confirmationPayload = parseSlackInteractionCallback(body);
      if (confirmationPayload?.callbackId === slackConfirmationCallbackId.taskCandidateConfirmation) {
        return handleSlackTaskCandidateInteraction(store, auth.agent, confirmationPayload);
      }

      const interaction = parseAssignmentInteraction(body);
      if (!interaction.requestId) return jsonResponse({ error: "assignment request id is required" }, 400);
      const assignmentRequest = store.getAssignmentRequest(interaction.requestId);
      if (!assignmentRequest) return jsonResponse({ error: "Assignment request not found" }, 404);
      if (assignmentRequest.status !== "pending") {
        return jsonResponse({ error: "Assignment request is no longer pending." }, 409);
      }
      const task = store.getTask(assignmentRequest.taskId);
      if (!task) return jsonResponse({ error: "Task not found" }, 404);

      const adapter = adapterFor(auth.agent.type);
      store.markAgentSeen(auth.agent.id);
      store.recordEvent(auth.agent.id, "agent.slack.interaction", {
        taskId: task.id,
        requestId: assignmentRequest.id,
        action: interaction.action,
        delegateOwnerId: interaction.delegateOwnerId
      });
      if (interaction.action === "accept") {
        const updated = store.updateTask(task.id, {
          status: "in_progress",
          assignee: assignmentRequest.ownerName ?? task.assignee
        });
        const updatedRequest = store.updateAssignmentRequest(assignmentRequest.id, {
          status: "accepted",
          responseText: interaction.responseText
        });
        if (!updated) return jsonResponse({ error: "Task not found" }, 404);
        return {
          ok: true,
          task: updated,
          assignmentRequest: updatedRequest,
          actions: adapter.postTaskUpdate(updated, `${updated.id} accepted by ${updated.assignee ?? "the assignee"}.`)
        };
      }

      if (interaction.action === "delegate") {
        const owner = resolveAssignmentOwner(store, interaction.delegateOwnerId);
        if (!owner) return jsonResponse({ error: "Delegate owner must be an active owner with a Slack user ID." }, 400);
        if (owner.id === assignmentRequest.ownerId) {
          return jsonResponse({ error: "Delegate owner must be different from the current requested owner." }, 400);
        }
        store.updateAssignmentRequest(assignmentRequest.id, {
          status: "delegated",
          responseText: interaction.responseText
        });
        const result = createAssignmentRequestForOwner(store, auth.agent, task, owner, {
          previousRequestId: assignmentRequest.id,
          requestedBy: assignmentRequest.ownerName
        });
        return { ok: true, ...result };
      }

      const updated = store.updateTask(task.id, { status: "blocked" });
      const updatedRequest = store.updateAssignmentRequest(assignmentRequest.id, {
        status: "declined",
        responseText: interaction.responseText
      });
      if (!updated) return jsonResponse({ error: "Task not found" }, 404);
      return {
        ok: true,
        task: updated,
        assignmentRequest: updatedRequest,
        actions: adapter.postTaskUpdate(updated, `${updated.id} was declined by ${assignmentRequest.ownerName ?? "the assignee"}.`)
      };
    })
    .post("/api/agent/task/:id/status-signal", ({ request, params, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const task = store.getTask(params.id);
      if (!task) return jsonResponse({ error: "Task not found" }, 404);

      const requestedStatus = parseTaskState(input.status) ?? signalToStatus(stringValue(input.signal));
      if (!requestedStatus) return jsonResponse({ error: "A valid status or signal is required" }, 400);

      const confidence = numberValue(input.confidence) ?? 1;
      const requireConfirmation = booleanValue(input.requireConfirmation) === true || confidence < 0.75;
      const adapter = adapterFor(auth.agent.type);
      store.markAgentSeen(auth.agent.id);
      store.recordEvent(auth.agent.id, "agent.task.status_signal", {
        taskId: task.id,
        requestedStatus,
        confidence,
        requireConfirmation
      });

      if (requireConfirmation) {
        const outbox = store.enqueueOutbox(auth.agent.id, "slack.actions", {
          taskId: task.id,
          proposedStatus: requestedStatus,
          actions: adapter.postTaskUpdate(
            task,
            `${task.id} may be ${requestedStatus}. Please confirm before I update it.`
          )
        });
        return {
          ok: true,
          proposedStatus: requestedStatus,
          outbox
        };
      }

      const updated = store.updateTask(task.id, { status: requestedStatus });
      if (!updated) return jsonResponse({ error: "Task not found" }, 404);
      return {
        ok: true,
        task: updated,
        actions: adapter.postTaskUpdate(updated)
      };
    })
    .get("/api/agent/owners", ({ request }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      store.markAgentSeen(auth.agent.id);
      return {
        ok: true,
        owners: store.listOwners().filter((owner) => owner.active && owner.slackUserId)
      };
    })
    .get("/api/agent/tasks/today", ({ request, query }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      store.markAgentSeen(auth.agent.id);
      const assignee = stringValue(query.assignee) ?? stringValue(query.userId);
      const tasks = store
        .listTasks(assignee ? { assignee } : {})
        .filter((task) => !["done", "cancelled"].includes(task.status));
      const visibleTasks = tasks.slice(0, 10);
      const text = visibleTasks.length
        ? visibleTasks.map((task) => `- ${task.id} [${task.status}] ${task.title}`).join("\n")
        : "No active tasks found.";

      return {
        ok: true,
        tasks: visibleTasks,
        actions: [
          {
            kind: "thread_reply",
            channelId: stringValue(query.channelId),
            threadTs: stringValue(query.threadTs),
            text
          }
        ]
      };
    })
    .get("/api/agent/tasks/cards", ({ request, query }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const ownerQuery = stringValue(query.assignee) ?? stringValue(query.owner) ?? stringValue(query.userId);
      const resolvedOwner = store.resolveOwner(ownerQuery);
      const ownerName = resolvedOwner?.ownerName ?? ownerQuery;
      const scope = stringValue(query.scope) ?? "all";
      const channelId = stringValue(query.channelId);
      const threadTs = stringValue(query.threadTs);
      const tasks = filterCardTasks(store.listTasks(), ownerName, scope).slice(0, 10);
      const text = renderTaskCardsText(tasks, ownerName, scope);

      return {
        ok: true,
        owner: resolvedOwner ?? null,
        tasks,
        actions: [{ kind: "thread_reply", channelId, threadTs, text }]
      };
    })
    .post("/api/agent/tasks/daily-digest", ({ request, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const ownerQuery = stringValue(input.owner) ?? stringValue(input.assignee) ?? stringValue(input.userId);
      const owners = ownerQuery ? [store.resolveOwner(ownerQuery)].filter(Boolean) : store.listOwners().filter((owner) => owner.active);
      const actions = owners.flatMap((owner) => {
        const tasks = filterCardTasks(store.listTasks(), owner?.ownerName ?? null, "today").slice(0, 10);
        if (!owner?.slackUserId || tasks.length === 0) return [];
        return [
          {
            kind: "dm" as const,
            userId: owner.slackUserId,
            text: renderTaskCardsText(tasks, owner.ownerName, "today")
          }
        ];
      });
      const enqueue = booleanValue(input.enqueue) !== false;
      const outbox = enqueue
        ? actions.map((action) => store.enqueueOutbox(auth.agent.id, "slack.actions", { actions: [action] }))
        : [];

      return { ok: true, actions, outbox };
    })
    .get("/api/agent/outbox", ({ request, query }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      store.markAgentSeen(auth.agent.id);
      const limit = Math.min(Math.max(Number(query.limit ?? "25"), 1), 100);
      return { outbox: store.listOutbox(auth.agent.id, limit).map((item) => hydrateMemberInviteOutbox(item, store, config)) };
    })
    .post("/api/agent/outbox/:id/ack", ({ request, params }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const item = store.ackOutbox(auth.agent.id, params.id);
      if (!item) return jsonResponse({ error: "Outbox item not found" }, 404);
      return { ok: true, outbox: item };
    });
}

type SlackInteractionValidationResult =
  | { ok: true }
  | { ok: false; error: string };

type SlackInteractionValidationOptions = {
  store?: ServerContext["store"];
  agentId?: string;
};

function validateSlackInteractionCallback(
  value: unknown,
  options: SlackInteractionValidationOptions = {}
): SlackInteractionValidationResult {
  const input = typeof value === "string" ? parseInteractionJson(value) : asRecord(value);
  if (!input) return invalidSlackInteraction("Slack interaction body must be an object.");

  if (!("payload" in input)) return { ok: true };

  const payload = parseInteractionPayload(input.payload);
  if (!payload) return invalidSlackInteraction("Slack interaction payload must be a valid JSON object.");
  const payloadType = stringValue(payload.type);
  if (payloadType && payloadType !== "block_actions") {
    return invalidSlackInteraction("Slack interaction payload type must be block_actions.");
  }

  const actions = Array.isArray(payload.actions) ? payload.actions.map(asRecord) : [];
  if (actions.length === 0 || Object.keys(actions[0] ?? {}).length === 0) {
    return invalidSlackInteraction("Slack interaction payload must include at least one action.");
  }

  const firstAction = actions[0] ?? {};
  const actionId = parseSlackConfirmationActionId(stringValue(firstAction.action_id) ?? stringValue(input.actionId));
  if (!actionId) return invalidSlackInteraction("Slack interaction action_id is not supported.");

  const metadata = slackInteractionMetadata(input, payload);
  const callbackId = parseSlackConfirmationCallbackId(
    stringValue(input.callbackId) ??
    stringValue(payload.callback_id) ??
    stringValue(metadata.callbackId) ??
    stringValue(metadata.type) ??
    callbackIdForActionId(actionId)
  );
  if (!callbackId) return invalidSlackInteraction("Slack interaction callback id is not supported.");
  if (callbackIdForActionId(actionId) !== callbackId) {
    return invalidSlackInteraction("Slack interaction callback id does not match the action_id.");
  }

  const userId = stringValue(asRecord(payload.user).id) ?? stringValue(input.userId);
  const workspaceId = stringValue(asRecord(payload.team).id) ?? stringValue(payload.team_id) ?? stringValue(input.workspaceId);
  if (!userId) return invalidSlackInteraction("Slack interaction user.id is required.");
  if (!workspaceId) return invalidSlackInteraction("Slack interaction team.id is required.");

  if (callbackId === slackConfirmationCallbackId.taskCandidateConfirmation) {
    const candidate = asRecord(input.candidate ?? payload.candidate ?? metadata.candidate);
    const candidateId =
      stringValue(candidate.candidateId) ??
      stringValue(metadata.candidateId) ??
      stringValue(input.taskId) ??
      stringValue(payload.taskId);
    const dedupeKey = stringValue(candidate.dedupeKey) ?? stringValue(metadata.dedupeKey);
    const persistedCandidate = options.store && options.agentId && dedupeKey
      ? persistedSlackTaskCandidateMetadata(options.store, options.agentId, dedupeKey)
      : null;
    const candidateWorkspaceId = stringValue(candidate.workspaceId) ?? persistedCandidate?.workspaceId;
    const candidateChannelId = stringValue(candidate.channelId) ?? persistedCandidate?.channelId;
    const payloadChannelId = stringValue(asRecord(payload.channel).id);
    const confirmationTarget = stringValue(candidate.confirmationTarget) ?? persistedCandidate?.confirmationTarget;
    const parsedCandidate = parseSlackTaskCandidateFromInteraction(input, payload, metadata);

    if (!candidateId || !dedupeKey) {
      return invalidSlackInteraction("Slack task candidate metadata must include candidateId and dedupeKey.");
    }
    if (!parsedCandidate) {
      return invalidSlackInteraction("Slack task candidate metadata must include required Slack-derived fields.");
    }
    if (!candidateWorkspaceId || candidateWorkspaceId !== workspaceId) {
      return invalidSlackInteraction("Slack task candidate workspaceId must match team.id.");
    }
    if (!candidateChannelId || (payloadChannelId && candidateChannelId !== payloadChannelId)) {
      return invalidSlackInteraction("Slack task candidate channelId must match channel.id.");
    }
    if (!stringValue(candidate.messageTs) && !persistedCandidate?.messageTs) {
      return invalidSlackInteraction("Slack task candidate metadata must include messageTs.");
    }
    if (!confirmationTarget || confirmationTarget !== userId) {
      return invalidSlackInteraction("Slack task candidate confirmationTarget must match user.id.");
    }
    const candidateFieldValidation = validateSlackTaskCandidateMetadata(parsedCandidate);
    if (!candidateFieldValidation.ok) {
      const persistedCandidateFieldValidation = persistedCandidate
        ? validateSlackTaskCandidateMetadata(persistedCandidate)
        : null;
      if (persistedCandidateFieldValidation?.ok) return { ok: true };
      return invalidSlackInteraction(
        `Slack task candidate metadata is missing or invalid: ${[
          ...candidateFieldValidation.missing,
          ...candidateFieldValidation.invalid
        ].join(", ")}.`
      );
    }
    if (
      (actionId === slackConfirmationActionId.candidateAccept || actionId === slackConfirmationActionId.candidateDecline) &&
      stringValue(firstAction.value) !== candidateId
    ) {
      return invalidSlackInteraction("Slack task candidate button value must match candidateId.");
    }
  }

  if (actionId === slackConfirmationActionId.candidateSelectClassification) {
    const selected = selectedOptionValue(firstAction) ?? selectedValueFromState(payload, actionId);
    if (!parseTaskCategory(selected)) {
      return invalidSlackInteraction("Slack task candidate classification selection is not supported.");
    }
  }
  if (actionId === slackConfirmationActionId.candidateSelectAssignee) {
    const selected = selectedOptionValue(firstAction) ?? selectedValueFromState(payload, actionId);
    if (!selected) return invalidSlackInteraction("Slack task candidate assignee selection is required.");
  }
  if (actionId === slackConfirmationActionId.assignmentDelegateSelect) {
    const selected = selectedOptionValue(firstAction) ?? selectedDelegateFromState(payload);
    if (!selected) return invalidSlackInteraction("Slack assignment delegate selection is required.");
  }
  if (callbackId === slackConfirmationCallbackId.assignmentConfirmation) {
    const requestId =
      stringValue(input.requestId) ??
      stringValue(payload.requestId) ??
      stringValue(metadata.requestId) ??
      assignmentRequestIdFromBlockId(stringValue(firstAction.block_id)) ??
      stringValue(firstAction.value);
    if (!requestId) return invalidSlackInteraction("Slack assignment request id is required.");
  }

  return { ok: true };
}

function invalidSlackInteraction(error: string): SlackInteractionValidationResult {
  return { ok: false, error };
}

function parseInteractionJson(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseInteractionPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") return parseInteractionJson(value);
  const payload = asRecord(value);
  return Object.keys(payload).length > 0 ? payload : null;
}

function hydrateMemberInviteOutbox(
  item: OutboxItem,
  store: ServerContext["store"],
  config: ServerContext["config"]
): OutboxItem {
  const payload = asRecord(item.payload);
  if (Array.isArray(payload.actions)) return item;

  const invitationId = stringValue(payload.memberInvitationId);
  const ownerId = stringValue(payload.ownerId);
  if (!invitationId || !ownerId) return item;

  const invitation = store.getMemberInvitation(invitationId);
  const owner = store.getOwner(ownerId);
  if (!invitation || invitation.status !== "pending" || !owner?.slackUserId) return item;

  return {
    ...item,
    payload: {
      ...payload,
      actions: [
        memberInviteAction(
          owner,
          invitationUrl(config, memberInvitationToken(config, invitation.id))
        )
      ]
    }
  };
}

function resolveAssignmentOwner(store: ServerContext["store"], value: string | null | undefined): OwnerMapping | null {
  if (!value) return null;
  const ownerById = store.listOwners().find((owner) => owner.id === value && owner.active && owner.slackUserId);
  const resolved = ownerById ?? store.resolveOwner(value);
  return resolved?.active && resolved.slackUserId ? resolved : null;
}

function createAssignmentRequestForOwner(
  store: ServerContext["store"],
  agent: AgentSettings,
  task: Task,
  owner: OwnerMapping,
  input: { previousRequestId?: string | null; requestedBy?: string | null } = {}
): { task: Task; assignmentRequest: AssignmentRequest; actions: SlackAction[] } {
  if (!owner.slackUserId) throw new Error("Assignment owner must have a Slack user ID.");
  const updated = store.updateTask(task.id, {
    status: "assigning",
    assignee: owner.ownerName
  });
  if (!updated) throw new Error("Task not found");
  const requestInput = {
    taskId: updated.id,
    agentId: agent.id,
    owner,
    ...(input.previousRequestId !== undefined ? { previousRequestId: input.previousRequestId } : {}),
    ...(input.requestedBy !== undefined ? { requestedBy: input.requestedBy } : {})
  };
  const assignmentRequest = store.createAssignmentRequest(requestInput);
  const actions = adapterFor(agent.type).requestAssignment(
    updated,
    owner,
    assignmentRequest.id,
    store.listOwners()
  );
  return { task: updated, assignmentRequest, actions };
}

async function handleSlackTaskCandidateInteraction(
  store: ServerContext["store"],
  agent: AgentSettings,
  interaction: SlackConfirmationPayload
) {
  const confirmationRequest = store.getSlackTaskCandidateConfirmationByDedupeKey(
    agent.id,
    interaction.candidate.dedupeKey
  );
  if (!confirmationRequest) return jsonResponse({ error: "Slack task candidate confirmation not found" }, 404);
  if (interaction.taskId && interaction.taskId !== confirmationRequest.taskId) {
    return jsonResponse({ error: "Slack task candidate does not match the pending confirmation request." }, 400);
  }

  const candidateRecord = store.getSlackTaskCandidateByDedupeKey(agent.id, confirmationRequest.dedupeKey);
  const persistedCandidate: SlackTaskCandidateMetadata = {
    ...confirmationRequest.payload,
    ...(candidateRecord?.payload ?? {})
  };
  const hydratedInteraction: SlackConfirmationPayload = {
    ...interaction,
    taskId: interaction.taskId ?? confirmationRequest.taskId,
    candidate: mergeSlackTaskCandidateInteractionMetadata(persistedCandidate, interaction.candidate)
  };

  const selectedOwner = interaction.selectedAssignee
    ? resolveAssignmentOwner(store, interaction.selectedAssignee)
    : null;
  if (
    (interaction.confirmationAction === "select_assignee" || interaction.confirmationAction === "accept") &&
    interaction.selectedAssignee &&
    !selectedOwner
  ) {
    return jsonResponse({ error: "Selected assignee must be an active owner with a Slack user ID." }, 400);
  }

  const candidateAssigneeOwner = resolveSlackTaskCandidateAssigneeOwner(
    store,
    selectedOwner,
    hydratedInteraction.candidate.assignee ?? confirmationRequest.payload.assignee
  );
  let activationMatch = resolveSlackTaskCandidateActivationTask(
    store,
    confirmationRequest,
    hydratedInteraction,
    candidateRecord?.taskId ?? null,
    candidateAssigneeOwner?.ownerName ?? null
  );
  let task = activationMatch.task;
  if (!task && hydratedInteraction.confirmationAction === "accept") {
    const eligibilityError = slackTaskCandidateMissingTaskAcceptEligibilityError(candidateRecord, confirmationRequest);
    if (eligibilityError) return jsonResponse({ error: eligibilityError }, 409);
    task = createTaskFromAcceptedSlackTaskCandidate(store, agent, confirmationRequest, hydratedInteraction, selectedOwner);
    activationMatch = { task, matchKind: "created" };
  }
  if (!task) return jsonResponse({ error: "Task not found" }, 404);

  if (hydratedInteraction.confirmationAction === "accept") {
    const eligibilityError = slackTaskCandidateAcceptEligibilityError(
      candidateRecord,
      confirmationRequest,
      task,
      activationMatch.matchKind
    );
    if (eligibilityError) return jsonResponse({ error: eligibilityError }, 409);
  }

  const selectedClassification = hydratedInteraction.selectedClassification ?? hydratedInteraction.candidate.taskClassification ?? task.category;
  const needsExplicitAssigneeConfirmation =
    hydratedInteraction.candidate.requiresAssigneeConfirmation === true ||
    confirmationRequest.payload.requiresAssigneeConfirmation === true ||
    (hydratedInteraction.candidate.assigneeResolution !== undefined &&
      hydratedInteraction.candidate.assigneeResolution !== "assigned") ||
    (confirmationRequest.payload.assigneeResolution !== undefined &&
      confirmationRequest.payload.assigneeResolution !== "assigned");
  const acceptedWithoutConfirmedAssignee =
    hydratedInteraction.confirmationAction === "accept" &&
    !selectedOwner &&
    ((!task.assignee && !confirmationRequest.payload.assignee) || needsExplicitAssigneeConfirmation);
  const acceptedTaskStatus = acceptedWithoutConfirmedAssignee
    ? "review_needed"
    : slackTaskCandidateAcceptedTaskStatus(store, confirmationRequest, hydratedInteraction, task, selectedOwner);
  const confirmationState = acceptedWithoutConfirmedAssignee
    ? "review_needed"
    : taskCandidateConfirmationStateForAction(hydratedInteraction, acceptedTaskStatus);
  const resolvedAssignee =
    selectedOwner?.ownerName ?? hydratedInteraction.candidate.assignee ?? confirmationRequest.payload.assignee;
  const resolvedAssigneeResolution = acceptedWithoutConfirmedAssignee
    ? hydratedInteraction.candidate.assigneeResolution ?? confirmationRequest.payload.assigneeResolution
    : resolvedAssignee
      ? "assigned"
      : hydratedInteraction.candidate.assigneeResolution ?? confirmationRequest.payload.assigneeResolution;
  const requiresAssigneeConfirmation = acceptedWithoutConfirmedAssignee
    ? true
    : resolvedAssignee
      ? false
      : hydratedInteraction.candidate.requiresAssigneeConfirmation ?? confirmationRequest.payload.requiresAssigneeConfirmation;
  const nextCandidate: SlackTaskCandidateMetadata = {
    ...confirmationRequest.payload,
    ...hydratedInteraction.candidate,
    taskClassification: selectedClassification,
    assignee: resolvedAssignee,
    ...(resolvedAssigneeResolution ? { assigneeResolution: resolvedAssigneeResolution } : {}),
    ...(requiresAssigneeConfirmation !== undefined ? { requiresAssigneeConfirmation } : {}),
    confirmationTarget: confirmationRequest.confirmationTarget,
    confirmationState,
    markdownPath: task.markdownPath
  };

  const update: Partial<Task> = {
    category: selectedClassification
  };
  if (selectedOwner) update.assignee = selectedOwner.ownerName;
  if (hydratedInteraction.confirmationAction === "accept") {
    update.status = acceptedTaskStatus;
    update.title = nextCandidate.taskTitle || task.title;
    update.description = nextCandidate.taskDescription || task.description;
    update.nextAction = nextCandidate.nextAction;
    update.dueAt = nextCandidate.dueAt;
    update.channelId = nextCandidate.sourceChannel.channelId || task.channelId;
    update.threadTs = nextCandidate.sourceChannel.threadTs ?? task.threadTs;
    update.sourceAgentId = task.sourceAgentId ?? agent.id;
    update.sourceAgentName = task.sourceAgentName ?? agent.name;
    update.sourceAuthor = nextCandidate.requester || task.sourceAuthor;
    update.sourceUrl = nextCandidate.sourceUrl ?? nextCandidate.sourceMessageLink ?? task.sourceUrl;
    update.dedupeKey = task.dedupeKey ?? confirmationRequest.dedupeKey;
  }
  if (hydratedInteraction.confirmationAction === "decline") update.status = "blocked";
  if (hydratedInteraction.confirmationAction === "select_assignee") update.status = "assigning";

  let updatedTask = store.updateTask(task.id, update);
  if (!updatedTask) return jsonResponse({ error: "Task not found" }, 404);

  const assignment = hydratedInteraction.confirmationAction === "select_assignee" && selectedOwner
    ? createAssignmentRequestForOwner(store, agent, updatedTask, selectedOwner, {
        requestedBy: confirmationRequest.confirmationTarget
      })
    : null;
  if (assignment) updatedTask = assignment.task;

  const githubSync = hydratedInteraction.confirmationAction === "accept" && !acceptedWithoutConfirmedAssignee
    ? await syncTaskToGitHub(store, updatedTask)
    : null;

  const updatedCandidate: SlackTaskCandidateMetadata = {
    ...nextCandidate,
    candidateId: updatedTask.id,
    taskTitle: updatedTask.title,
    taskDescription: updatedTask.description,
    taskClassification: updatedTask.category,
    sourceChannel: {
      ...nextCandidate.sourceChannel,
      channelId: updatedTask.channelId ?? nextCandidate.sourceChannel.channelId,
      threadTs: updatedTask.threadTs,
      messageTs: nextCandidate.sourceChannel.messageTs || hydratedInteraction.candidate.messageTs
    },
    sourceMessageLink: updatedTask.sourceUrl ?? nextCandidate.sourceMessageLink,
    requester: nextCandidate.requester,
    relevantContext: nextCandidate.relevantContext.length
      ? nextCandidate.relevantContext
      : [updatedTask.description].filter(Boolean),
    assignee: updatedTask.assignee,
    dueAt: updatedTask.dueAt,
    nextAction: updatedTask.nextAction,
    sourceUrl: updatedTask.sourceUrl,
    markdownPath: updatedTask.markdownPath
  };
  updatedCandidate.atmIdentityContext = buildSlackTaskCandidateATMIdentityContext(updatedCandidate);
  const updatedConfirmationRequest = store.upsertSlackTaskCandidateConfirmationRequest({
    agentId: agent.id,
    taskId: updatedTask.id,
    outboxId: confirmationRequest.outboxId,
    candidate: updatedCandidate,
    decision: {
      confirmationAction: hydratedInteraction.confirmationAction,
      selectedAssignee: hydratedInteraction.selectedAssignee,
      selectedClassification,
      responseText: hydratedInteraction.responseText
    }
  });
  const updatedCandidateRecord = store.upsertSlackTaskCandidate({
    agentId: agent.id,
    taskId: updatedTask.id,
    candidate: updatedCandidate
  });

  store.markAgentSeen(agent.id);
  store.recordEvent(agent.id, "agent.slack.task_candidate_interaction", {
    taskId: updatedTask.id,
    requestId: updatedConfirmationRequest.id,
    actionId: hydratedInteraction.actionId,
    confirmationAction: hydratedInteraction.confirmationAction,
    responseState: hydratedInteraction.responseState,
    selectedAssignee: hydratedInteraction.selectedAssignee,
    selectedClassification,
    dedupeKey: updatedCandidateRecord.dedupeKey,
    candidateRecordId: updatedCandidateRecord.id,
    candidateTaskId: updatedCandidateRecord.taskId,
    source: {
      workspaceId: updatedCandidateRecord.workspaceId,
      channelId: updatedCandidateRecord.channelId,
      threadTs: updatedCandidateRecord.threadTs,
      messageTs: updatedCandidateRecord.messageTs,
      sourceTs: updatedCandidateRecord.sourceTs,
      sourceUrl: updatedCandidate.sourceUrl,
      markdownPath: updatedCandidate.markdownPath,
      assigneeKey: updatedCandidateRecord.assigneeKey
    }
  });

  const adapter = adapterFor(agent.type);
  return {
    ok: true,
    interaction,
    task: updatedTask,
    candidateRecord: updatedCandidateRecord,
    githubSync,
    assignmentRequest: assignment?.assignmentRequest,
    confirmationRequest: updatedConfirmationRequest,
    actions: [
      ...slackTaskCandidateInteractionActions(adapter, updatedTask, hydratedInteraction, acceptedTaskStatus),
      ...(assignment?.actions ?? [])
    ]
  };
}

function persistedSlackTaskCandidateMetadata(
  store: ServerContext["store"],
  agentId: string,
  dedupeKey: string
): SlackTaskCandidateMetadata | null {
  const confirmation = store.getSlackTaskCandidateConfirmationByDedupeKey(agentId, dedupeKey);
  const candidate = store.getSlackTaskCandidateByDedupeKey(agentId, dedupeKey);
  if (!confirmation && !candidate) return null;
  return {
    ...(confirmation?.payload ?? candidate!.payload),
    ...(candidate?.payload ?? {})
  };
}

function mergeSlackTaskCandidateInteractionMetadata(
  persisted: SlackTaskCandidateMetadata,
  interactionCandidate: SlackTaskCandidateMetadata
): SlackTaskCandidateMetadata {
  const merged: SlackTaskCandidateMetadata = {
    ...persisted,
    ...interactionCandidate,
    workspaceId: interactionCandidate.workspaceId === "unknown" ? persisted.workspaceId : interactionCandidate.workspaceId,
    channelId: interactionCandidate.channelId || persisted.channelId,
    threadTs: interactionCandidate.threadTs ?? persisted.threadTs,
    messageTs: interactionCandidate.messageTs || persisted.messageTs,
    messageText: interactionCandidate.messageText || persisted.messageText,
    taskTitle: interactionCandidate.taskTitle || persisted.taskTitle,
    taskDescription: interactionCandidate.taskDescription || persisted.taskDescription,
    sourceChannel: {
      ...persisted.sourceChannel,
      ...interactionCandidate.sourceChannel,
      workspaceId:
        interactionCandidate.sourceChannel.workspaceId === "unknown"
          ? persisted.sourceChannel.workspaceId
          : interactionCandidate.sourceChannel.workspaceId,
      channelId: interactionCandidate.sourceChannel.channelId || persisted.sourceChannel.channelId,
      threadTs: interactionCandidate.sourceChannel.threadTs ?? persisted.sourceChannel.threadTs,
      messageTs: interactionCandidate.sourceChannel.messageTs || persisted.sourceChannel.messageTs
    },
    sourceMessageLink: interactionCandidate.sourceMessageLink || persisted.sourceMessageLink,
    requester: interactionCandidate.requester || persisted.requester,
    relevantContext: interactionCandidate.relevantContext.length ? interactionCandidate.relevantContext : persisted.relevantContext,
    assigneeCandidates: interactionCandidate.assigneeCandidates.length
      ? interactionCandidate.assigneeCandidates
      : persisted.assigneeCandidates,
    assigneeOptions: interactionCandidate.assigneeOptions?.length
      ? interactionCandidate.assigneeOptions
      : persisted.assigneeOptions ?? [],
    memberMappingUncertainties: interactionCandidate.memberMappingUncertainties?.length
      ? interactionCandidate.memberMappingUncertainties
      : persisted.memberMappingUncertainties ?? [],
    slackProfileContext: interactionCandidate.slackProfileContext?.length
      ? interactionCandidate.slackProfileContext
      : persisted.slackProfileContext ?? [],
    leaderReviewer: interactionCandidate.leaderReviewer ?? persisted.leaderReviewer,
    leaderReviewChannelId: interactionCandidate.leaderReviewChannelId ?? persisted.leaderReviewChannelId ?? null,
    leaderReviewThreadTs: interactionCandidate.leaderReviewThreadTs ?? persisted.leaderReviewThreadTs ?? null,
    confirmationTarget: interactionCandidate.confirmationTarget || persisted.confirmationTarget,
    dueAt: interactionCandidate.dueAt ?? persisted.dueAt,
    nextAction: interactionCandidate.nextAction ?? persisted.nextAction,
    sourceUrl: interactionCandidate.sourceUrl ?? persisted.sourceUrl,
    markdownPath: interactionCandidate.markdownPath ?? persisted.markdownPath
  };
  if (!interactionCandidate.atmIdentityContext && persisted.atmIdentityContext) {
    merged.atmIdentityContext = persisted.atmIdentityContext;
  }
  if (interactionCandidate.assigneeResolution === undefined && persisted.assigneeResolution !== undefined) {
    merged.assigneeResolution = persisted.assigneeResolution;
  }
  if (
    interactionCandidate.requiresAssigneeConfirmation === undefined &&
    persisted.requiresAssigneeConfirmation !== undefined
  ) {
    merged.requiresAssigneeConfirmation = persisted.requiresAssigneeConfirmation;
  }
  return merged;
}

function slackTaskCandidateAcceptEligibilityError(
  candidateRecord: ReturnType<ServerContext["store"]["getSlackTaskCandidateByDedupeKey"]>,
  confirmationRequest: SlackTaskCandidateConfirmationRequest,
  task: Task,
  matchKind: SlackTaskCandidateActivationMatchKind
): string | null {
  if (confirmationRequest.confirmationAction === "accept" || confirmationRequest.confirmationAction === "decline") {
    return "Slack task candidate confirmation is no longer pending.";
  }
  if (confirmationRequest.confirmationState !== "proposed" && confirmationRequest.confirmationState !== "assigning") {
    return "Slack task candidate is not eligible for acceptance.";
  }
  if (task.status !== "proposed" && task.status !== "assigning") {
    return "Only pending Slack task candidates can be accepted.";
  }
  if (task.dedupeKey && task.dedupeKey !== confirmationRequest.dedupeKey) {
    return "Slack task candidate does not match the pending task.";
  }
  if (!candidateRecord) {
    return "Slack task candidate must be saved before activation.";
  }
  const candidateTaskIds = new Set([
    confirmationRequest.taskId,
    confirmationRequest.payload.candidateId,
    candidateRecord.taskId,
    candidateRecord.payload.candidateId
  ]);
  if (
    !candidateTaskIds.has(task.id) &&
    matchKind !== "dedupe" &&
    matchKind !== "source" &&
    matchKind !== "created" &&
    task.dedupeKey !== confirmationRequest.dedupeKey
  ) {
    return "Slack task candidate does not match the pending confirmation request.";
  }
  if (candidateRecord.confirmationState !== "proposed" && candidateRecord.confirmationState !== "assigning") {
    return "Slack task candidate is not eligible for acceptance.";
  }
  return null;
}

function slackTaskCandidateMissingTaskAcceptEligibilityError(
  candidateRecord: ReturnType<ServerContext["store"]["getSlackTaskCandidateByDedupeKey"]>,
  confirmationRequest: SlackTaskCandidateConfirmationRequest
): string | null {
  if (confirmationRequest.confirmationAction === "accept" || confirmationRequest.confirmationAction === "decline") {
    return "Slack task candidate confirmation is no longer pending.";
  }
  if (confirmationRequest.confirmationState !== "proposed" && confirmationRequest.confirmationState !== "assigning") {
    return "Slack task candidate is not eligible for acceptance.";
  }
  if (!candidateRecord) {
    return "Slack task candidate must be saved before activation.";
  }
  if (candidateRecord.dedupeKey !== confirmationRequest.dedupeKey) {
    return "Slack task candidate does not match the pending confirmation request.";
  }
  if (candidateRecord.confirmationState !== "proposed" && candidateRecord.confirmationState !== "assigning") {
    return "Slack task candidate is not eligible for acceptance.";
  }
  return null;
}

type SlackTaskCandidateActivationMatchKind = "confirmation_task" | "candidate_record_task" | "dedupe" | "source" | "created" | "none";

function resolveSlackTaskCandidateActivationTask(
  store: ServerContext["store"],
  confirmationRequest: SlackTaskCandidateConfirmationRequest,
  interaction: SlackConfirmationPayload,
  candidateRecordTaskId: string | null,
  assignee: string | null
): { task: Task | null; matchKind: SlackTaskCandidateActivationMatchKind } {
  const confirmationTask = store.getTask(confirmationRequest.taskId);
  if (confirmationTask) return { task: confirmationTask, matchKind: "confirmation_task" };

  if (candidateRecordTaskId && candidateRecordTaskId !== confirmationRequest.taskId) {
    const candidateRecordTask = store.getTask(candidateRecordTaskId);
    if (candidateRecordTask) return { task: candidateRecordTask, matchKind: "candidate_record_task" };
  }

  const dedupeTask = store.findTaskByDedupeKey(confirmationRequest.dedupeKey);
  if (dedupeTask) return { task: dedupeTask, matchKind: "dedupe" };

  const candidate = {
    ...confirmationRequest.payload,
    ...interaction.candidate
  };
  const sourceTask = store.findTaskBySlackSource({
    channelId: candidate.sourceChannel.channelId || candidate.channelId,
    threadTs: candidate.sourceChannel.threadTs ?? candidate.threadTs,
    sourceUrl: candidate.sourceUrl ?? candidate.sourceMessageLink,
    assignee
  });
  if (sourceTask) return { task: sourceTask, matchKind: "source" };

  return { task: null, matchKind: "none" };
}

function resolveSlackTaskCandidateAssigneeOwner(
  store: ServerContext["store"],
  selectedOwner: OwnerMapping | null,
  candidateAssignee: string | null | undefined
): OwnerMapping | null {
  if (selectedOwner) return selectedOwner;
  const owner = candidateAssignee ? store.resolveOwner(candidateAssignee) : null;
  return owner?.active ? owner : null;
}

function createTaskFromAcceptedSlackTaskCandidate(
  store: ServerContext["store"],
  agent: AgentSettings,
  confirmationRequest: SlackTaskCandidateConfirmationRequest,
  interaction: SlackConfirmationPayload,
  selectedOwner: OwnerMapping | null
): Task {
  const candidate: SlackTaskCandidateMetadata = {
    ...confirmationRequest.payload,
    ...interaction.candidate
  };
  const candidateOwner = candidate.assignee ? store.resolveOwner(candidate.assignee) : null;
  const assignee = selectedOwner?.ownerName ?? candidateOwner?.ownerName ?? (candidate.assignee && !isSlackUserId(candidate.assignee) ? candidate.assignee : null);
  const result = store.createTask({
    title: candidate.taskTitle || "Slack task candidate",
    description: candidate.taskDescription || candidate.messageText,
    status: assignee ? "proposed" : "assigning",
    priority: inferPriorityFromText(`${candidate.taskTitle} ${candidate.taskDescription} ${candidate.messageText}`),
    category: interaction.selectedClassification ?? candidate.taskClassification ?? "general",
    assignee,
    reporter: candidate.requester || null,
    notify: true,
    nextAction: candidate.nextAction,
    channelId: candidate.sourceChannel.channelId || candidate.channelId || null,
    threadTs: candidate.sourceChannel.threadTs ?? candidate.threadTs,
    sourceAgentId: agent.id,
    sourceAgentName: agent.name,
    sourceAuthor: candidate.requester || null,
    sourceUrl: candidate.sourceUrl ?? candidate.sourceMessageLink ?? null,
    dueAt: candidate.dueAt,
    dedupeKey: confirmationRequest.dedupeKey
  });
  store.recordEvent(agent.id, "agent.slack.task_candidate_task_created", {
    previousTaskId: confirmationRequest.taskId,
    taskId: result.task.id,
    dedupeKey: confirmationRequest.dedupeKey,
    duplicate: result.duplicate
  });
  return result.task;
}

function slackTaskCandidateInteractionActions(
  adapter: ReturnType<typeof adapterFor>,
  task: Task,
  interaction: SlackConfirmationPayload,
  acceptedTaskStatus?: SlackTaskCandidateMetadata["confirmationState"]
): SlackAction[] {
  if (interaction.confirmationAction === "accept") {
    if (acceptedTaskStatus === "review_needed") {
      return adapter.postTaskUpdate(task, `${task.id} needs an assignee before activation.`);
    }
    return adapter.postTaskUpdate(task, `${task.id} approved and moved to ${acceptedTaskStatus ?? task.status}.`);
  }
  if (interaction.confirmationAction === "decline") {
    return adapter.postTaskUpdate(task, `${task.id} task candidate was declined.`);
  }
  if (interaction.confirmationAction === "select_assignee") {
    return adapter.postTaskUpdate(task, `${task.id} assignee set to ${task.assignee ?? "unassigned"}.`);
  }
  if (interaction.confirmationAction === "select_classification") {
    return adapter.postTaskUpdate(task, `${task.id} classification set to ${task.category}.`);
  }
  return [];
}

function taskCandidateConfirmationStateForAction(
  interaction: SlackConfirmationPayload,
  acceptedTaskStatus?: SlackTaskCandidateMetadata["confirmationState"]
): SlackTaskCandidateMetadata["confirmationState"] {
  if (interaction.confirmationAction === "accept") return acceptedTaskStatus ?? "confirmed";
  if (interaction.confirmationAction === "decline") return "blocked";
  if (interaction.confirmationAction === "select_assignee") return "assigning";
  return interaction.responseState;
}

function slackTaskCandidateAcceptedTaskStatus(
  store: ServerContext["store"],
  confirmationRequest: SlackTaskCandidateConfirmationRequest,
  interaction: SlackConfirmationPayload,
  task: Task,
  selectedOwner: OwnerMapping | null
): Extract<TaskState, "confirmed" | "in_progress" | "review_needed"> {
  if (interaction.responseState === "in_progress") return "in_progress";
  if (selectedOwner) return "confirmed";
  const assigneeSlackUserId =
    (task.assignee ? store.resolveOwner(task.assignee)?.slackUserId : null) ??
    (interaction.candidate.assignee ? store.resolveOwner(interaction.candidate.assignee)?.slackUserId : null);
  if (assigneeSlackUserId && assigneeSlackUserId === confirmationRequest.confirmationTarget) return "in_progress";
  return "confirmed";
}

function parseAssignmentInteraction(value: unknown): {
  requestId: string | null;
  action: Extract<SlackConfirmationAction, "accept" | "decline" | "delegate">;
  delegateOwnerId: string | null;
  responseText: string | null;
} {
  const input = typeof value === "string" ? safeJsonParse<Record<string, unknown>>(value, {}) : asRecord(value);
  const payloadSource = input.payload ?? input;
  const payload = typeof payloadSource === "string"
    ? safeJsonParse<Record<string, unknown>>(payloadSource, {})
    : asRecord(payloadSource);
  const explicitAction = stringValue(input.action) ?? stringValue(payload.action);
  const actions = Array.isArray(payload.actions) ? payload.actions.map(asRecord) : [];
  const firstAction = actions[0] ?? {};
  const actionId = stringValue(firstAction.action_id) ?? explicitAction;
  const requestId =
    stringValue(input.requestId) ??
    stringValue(payload.requestId) ??
    stringValue(firstAction.value) ??
    assignmentRequestIdFromBlockId(stringValue(firstAction.block_id));
  const delegateOwnerId =
    stringValue(input.delegateOwnerId) ??
    stringValue(input.delegateToOwnerId) ??
    stringValue(asRecord(firstAction.selected_option).value) ??
    selectedDelegateFromState(payload);
  const responseText = stringValue(input.text) ?? stringValue(input.responseText);

  if (explicitAction === "accept" || actionId === slackConfirmationActionId.assignmentAccept) {
    return { requestId, action: "accept", delegateOwnerId: null, responseText };
  }
  if (explicitAction === "delegate" || actionId === slackConfirmationActionId.assignmentDelegateSelect) {
    return { requestId, action: "delegate", delegateOwnerId, responseText };
  }
  return { requestId, action: "decline", delegateOwnerId: null, responseText };
}

function parseSlackInteractionCallback(value: unknown): SlackConfirmationPayload | null {
  const input = typeof value === "string" ? safeJsonParse<Record<string, unknown>>(value, {}) : asRecord(value);
  const payload = slackInteractionPayload(input);
  const actions = Array.isArray(payload.actions) ? payload.actions.map(asRecord) : [];
  const firstAction = actions[0] ?? {};
  const actionId = parseSlackConfirmationActionId(stringValue(firstAction.action_id) ?? stringValue(input.actionId));
  if (!actionId) return null;

  const metadata = slackInteractionMetadata(input, payload);
  const callbackId = parseSlackConfirmationCallbackId(
    stringValue(input.callbackId) ??
    stringValue(payload.callback_id) ??
    stringValue(metadata.callbackId) ??
    stringValue(metadata.type) ??
    callbackIdForActionId(actionId)
  );
  if (!callbackId) return null;

  const candidate = parseSlackTaskCandidateFromInteraction(input, payload, metadata);
  if (callbackId === slackConfirmationCallbackId.taskCandidateConfirmation && !candidate) return null;

  const requestId =
    stringValue(input.requestId) ??
    stringValue(payload.requestId) ??
    stringValue(metadata.requestId) ??
    assignmentRequestIdFromBlockId(stringValue(firstAction.block_id)) ??
    (callbackId === slackConfirmationCallbackId.assignmentConfirmation ? stringValue(firstAction.value) : null);
  const selectedAssignee =
    stringValue(input.selectedAssignee) ??
    stringValue(input.assignee) ??
    selectedOptionValue(firstAction) ??
    selectedValueFromState(payload, slackConfirmationActionId.candidateSelectAssignee);
  const selectedClassification =
    parseTaskCategory(stringValue(input.selectedClassification)) ??
    parseTaskCategory(selectedOptionValue(firstAction)) ??
    parseTaskCategory(selectedValueFromState(payload, slackConfirmationActionId.candidateSelectClassification)) ??
    parseTaskCategory(metadata.defaultClassification);
  const responseState =
    parseSlackConfirmationResponseState(input.responseState) ??
    parseSlackConfirmationResponseState(metadata.responseState) ??
    responseStateForActionId(actionId);

  return {
    callbackId,
    actionId,
    confirmationAction: confirmationActionForActionId(actionId),
    responseState,
    candidate: candidate ?? emptySlackTaskCandidateMetadata(),
    requestId,
    taskId: stringValue(input.taskId) ?? stringValue(payload.taskId) ?? stringValue(metadata.taskId) ?? candidate?.candidateId ?? null,
    selectedAssignee: selectedAssignee ?? null,
    selectedClassification: selectedClassification ?? null,
    responseText: stringValue(input.text) ?? stringValue(input.responseText)
  };
}

function slackInteractionPayload(input: Record<string, unknown>): Record<string, unknown> {
  const payloadSource = input.payload ?? input;
  return typeof payloadSource === "string"
    ? safeJsonParse<Record<string, unknown>>(payloadSource, {})
    : asRecord(payloadSource);
}

function slackInteractionMetadata(
  input: Record<string, unknown>,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const messageMetadata = asRecord(asRecord(payload.message).metadata);
  const eventPayload = asRecord(messageMetadata.event_payload);
  const payloadMetadata = asRecord(payload.metadata);
  const inputMetadata = asRecord(input.metadata);
  return {
    ...payloadMetadata,
    ...eventPayload,
    ...messageMetadata,
    ...inputMetadata
  };
}

function parseSlackTaskCandidateFromInteraction(
  input: Record<string, unknown>,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>
): SlackTaskCandidateMetadata | null {
  const candidate = asRecord(input.candidate ?? payload.candidate ?? metadata.candidate);
  const candidateId =
    stringValue(candidate.candidateId) ??
    stringValue(metadata.candidateId) ??
    stringValue(input.taskId) ??
    stringValue(payload.taskId);
  const dedupeKey = stringValue(candidate.dedupeKey) ?? stringValue(metadata.dedupeKey);
  if (!candidateId || !dedupeKey) return null;

  const parsed: SlackTaskCandidateMetadata = {
    candidateId,
    workspaceId: stringValue(candidate.workspaceId) ?? stringValue(payload.team_id) ?? "unknown",
    channelId: stringValue(candidate.channelId) ?? stringValue(asRecord(payload.channel).id) ?? "",
    threadTs: stringValue(candidate.threadTs),
    messageTs: stringValue(candidate.messageTs) ?? candidateId,
    messageText: stringValue(candidate.messageText) ?? "",
    taskTitle: stringValue(candidate.taskTitle) ?? "",
    taskDescription: stringValue(candidate.taskDescription) ?? "",
    taskClassification: parseTaskCategory(candidate.taskClassification),
    sourceChannel: {
      workspaceId: stringValue(asRecord(candidate.sourceChannel).workspaceId) ?? stringValue(candidate.workspaceId) ?? "unknown",
      channelId: stringValue(asRecord(candidate.sourceChannel).channelId) ?? stringValue(candidate.channelId) ?? "",
      channelName: stringValue(asRecord(candidate.sourceChannel).channelName),
      threadTs: stringValue(asRecord(candidate.sourceChannel).threadTs) ?? stringValue(candidate.threadTs),
      messageTs: stringValue(asRecord(candidate.sourceChannel).messageTs) ?? stringValue(candidate.messageTs) ?? candidateId
    },
    sourceMessageLink: stringValue(candidate.sourceMessageLink) ?? stringValue(candidate.sourceUrl) ?? "",
    requester:
      stringValue(candidate.requester) ??
      stringValue(candidate.leaderReviewer) ??
      stringValue(metadata.requester) ??
      stringValue(asRecord(payload.user).id) ??
      "",
    relevantContext: stringArray(candidate.relevantContext).length
      ? stringArray(candidate.relevantContext)
      : [stringValue(candidate.messageText) ?? stringValue(candidate.taskDescription) ?? ""].filter(Boolean),
    assignee: stringValue(candidate.assignee),
    assigneeCandidates: stringArray(candidate.assigneeCandidates),
    assigneeOptions: parseSlackTaskCandidateAssigneeOptions(candidate.assigneeOptions),
    memberMappingUncertainties: parseSlackMemberMappingUncertainties(candidate.memberMappingUncertainties),
    slackProfileContext: parseSlackTaskCandidateProfileContext(candidate.slackProfileContext),
    leaderReviewer: stringValue(candidate.leaderReviewer),
    leaderReviewChannelId: stringValue(candidate.leaderReviewChannelId),
    leaderReviewThreadTs: stringValue(candidate.leaderReviewThreadTs),
    confirmationTarget: stringValue(candidate.confirmationTarget) ?? stringValue(asRecord(payload.user).id) ?? "",
    confirmationState: parseSlackConfirmationResponseState(candidate.confirmationState) ?? "proposed",
    dedupeKey,
    dueAt: stringValue(candidate.dueAt),
    nextAction: stringValue(candidate.nextAction),
    sourceUrl: stringValue(candidate.sourceUrl),
    markdownPath: stringValue(candidate.markdownPath)
  };
  const assigneeResolution = parseSlackTaskAssigneeResolution(candidate.assigneeResolution);
  if (assigneeResolution) parsed.assigneeResolution = assigneeResolution;
  const requiresAssigneeConfirmation = booleanValue(candidate.requiresAssigneeConfirmation);
  if (requiresAssigneeConfirmation !== null) parsed.requiresAssigneeConfirmation = requiresAssigneeConfirmation;
  const atmIdentityContext = parseSlackTaskCandidateATMIdentityContext(candidate.atmIdentityContext);
  if (atmIdentityContext) parsed.atmIdentityContext = atmIdentityContext;
  return parsed;
}

function emptySlackTaskCandidateMetadata(): SlackTaskCandidateMetadata {
  return {
    candidateId: "",
    workspaceId: "unknown",
    channelId: "",
    threadTs: null,
    messageTs: "",
    messageText: "",
    taskTitle: "",
    taskDescription: "",
    sourceChannel: {
      workspaceId: "unknown",
      channelId: "",
      channelName: null,
      threadTs: null,
      messageTs: ""
    },
    sourceMessageLink: "",
    requester: "",
    relevantContext: [],
    assignee: null,
    assigneeCandidates: [],
    assigneeOptions: [],
    memberMappingUncertainties: [],
    leaderReviewer: null,
    confirmationTarget: "",
    confirmationState: "proposed",
    dedupeKey: "",
    dueAt: null,
    nextAction: null,
    sourceUrl: null,
    markdownPath: null
  };
}

function parseSlackMemberMappingUncertainties(value: unknown): SlackMemberMappingUncertainty[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const input = asRecord(item);
    const subject = stringValue(input.subject);
    const reason = stringValue(input.reason);
    if ((subject !== "author" && subject !== "mentioned_user") || (reason !== "missing_slack_user_id" && reason !== "unmapped_slack_user")) {
      return [];
    }
    return [
      {
        subject,
        slackUserId: stringValue(input.slackUserId),
        slackUserName: stringValue(input.slackUserName),
        reason
      }
    ];
  });
}

function parseSlackTaskCandidateProfileContext(value: unknown): SlackTaskCandidateProfileContext[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const input = asRecord(item);
    const role = parseSlackTaskCandidateProfileContextRole(input.role);
    const mappingStatus = parseSlackTaskCandidateProfileMappingStatus(input.mappingStatus);
    if (!role || !mappingStatus) return [];
    const uncertaintyReason = parseSlackMemberMappingUncertaintyReason(input.uncertaintyReason);
    return [
      {
        role,
        slackUserId: stringValue(input.slackUserId),
        slackUserName: stringValue(input.slackUserName),
        atmOwnerId: stringValue(input.atmOwnerId),
        atmOwnerName: stringValue(input.atmOwnerName),
        mappingStatus,
        uncertaintyReason
      }
    ];
  });
}

function parseSlackTaskCandidateAssigneeOptions(value: unknown): SlackTaskCandidateAssigneeOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const input = asRecord(item);
    const ownerId = stringValue(input.ownerId);
    const ownerName = stringValue(input.ownerName);
    const slackUserId = stringValue(input.slackUserId);
    if (!ownerId || !ownerName || !slackUserId || seen.has(ownerId)) return [];
    seen.add(ownerId);
    return [{ ownerId, ownerName, slackUserId }];
  });
}

function parseSlackTaskCandidateATMIdentityContext(value: unknown): SlackTaskCandidateATMIdentityContext | undefined {
  const input = asRecord(value);
  const candidateId = stringValue(input.candidateId);
  const dedupeKey = stringValue(input.dedupeKey);
  const confirmationState = parseSlackConfirmationResponseState(input.confirmationState);
  if (!candidateId || !dedupeKey || !confirmationState) return undefined;
  return {
    candidateId,
    taskTitle: stringValue(input.taskTitle) ?? "",
    taskClassification: parseTaskCategory(stringValue(input.taskClassification)),
    confirmationState,
    assignee: stringValue(input.assignee),
    assigneeResolution: parseSlackTaskAssigneeResolution(input.assigneeResolution),
    requiresAssigneeConfirmation: booleanValue(input.requiresAssigneeConfirmation) ?? false,
    dedupeKey,
    markdownPath: stringValue(input.markdownPath),
    sourceUrl: stringValue(input.sourceUrl)
  };
}

function parseSlackTaskCandidateProfileContextRole(value: unknown): SlackTaskCandidateProfileContextRole | null {
  const role = stringValue(value);
  return role === "requester" ||
    role === "candidate_assignee" ||
    role === "leader_reviewer" ||
    role === "confirmation_target"
    ? role
    : null;
}

function parseSlackTaskCandidateProfileMappingStatus(
  value: unknown
): SlackTaskCandidateProfileContext["mappingStatus"] | null {
  const status = stringValue(value);
  return status === "mapped" || status === "unmapped" || status === "unknown" ? status : null;
}

function parseSlackMemberMappingUncertaintyReason(value: unknown): SlackMemberMappingUncertaintyReason | null {
  const reason = stringValue(value);
  return reason === "missing_slack_user_id" || reason === "unmapped_slack_user" ? reason : null;
}

function selectedOptionValue(action: Record<string, unknown>): string | null {
  return stringValue(asRecord(action.selected_option).value);
}

function selectedValueFromState(payload: Record<string, unknown>, actionId: string): string | null {
  const values = asRecord(asRecord(payload.state).values);
  for (const block of Object.values(values)) {
    const actions = asRecord(block);
    const actionValue = asRecord(actions[actionId]);
    const selected = selectedOptionValue(actionValue);
    if (selected) return selected;
  }
  return null;
}

function callbackIdForActionId(actionId: string): string | null {
  if (actionId.startsWith("atm_candidate_")) return slackConfirmationCallbackId.taskCandidateConfirmation;
  if (actionId.startsWith("atm_assignment_")) return slackConfirmationCallbackId.assignmentConfirmation;
  return null;
}

function confirmationActionForActionId(actionId: string): SlackConfirmationAction {
  if (actionId === slackConfirmationActionId.candidateAccept || actionId === slackConfirmationActionId.assignmentAccept) return "accept";
  if (actionId === slackConfirmationActionId.assignmentDelegateSelect) return "delegate";
  if (actionId === slackConfirmationActionId.candidateSelectAssignee) return "select_assignee";
  if (actionId === slackConfirmationActionId.candidateSelectClassification) return "select_classification";
  return "decline";
}

function responseStateForActionId(actionId: string): SlackConfirmationPayload["responseState"] {
  if (actionId === slackConfirmationActionId.candidateAccept) return "confirmed";
  if (actionId === slackConfirmationActionId.assignmentAccept) return "in_progress";
  if (actionId === slackConfirmationActionId.candidateDecline || actionId === slackConfirmationActionId.assignmentDecline) {
    return "blocked";
  }
  if (actionId === slackConfirmationActionId.assignmentDelegateSelect || actionId === slackConfirmationActionId.candidateSelectAssignee) {
    return "assigning";
  }
  return "proposed";
}

function assignmentRequestIdFromBlockId(blockId: string | null): string | null {
  if (!blockId) return null;
  return /^atm_assignment(?:_delegate)?_(asn_[a-z0-9_]+)$/i.exec(blockId)?.[1] ?? null;
}

function selectedDelegateFromState(payload: Record<string, unknown>): string | null {
  const values = asRecord(asRecord(payload.state).values);
  for (const block of Object.values(values)) {
    const actions = asRecord(block);
    for (const actionValue of Object.values(actions)) {
      const selected = stringValue(asRecord(asRecord(actionValue).selected_option).value);
      if (selected) return selected;
    }
  }
  return null;
}

function parseCandidateConfirmationState(value: unknown): Extract<TaskState, "proposed" | "assigning"> | null {
  const state = stringValue(value);
  return state === "proposed" || state === "assigning" ? state : null;
}

function parseSlackTaskAssigneeResolution(
  value: unknown
): NonNullable<SlackTaskCandidateMetadata["assigneeResolution"]> | null {
  return value === "assigned" || value === "unassigned" || value === "ambiguous" ? value : null;
}

function parseManualSlackCollectionScopeOverride(input: Record<string, unknown>): {
  parsed: Partial<SlackCollectionScopeSettings>;
} | null {
  const rawOverride = asRecord(input.collectionScope ?? input.collectionScopeOverrides ?? input.manualScopeOverrides);
  const hasOverride = [
    "workspace",
    "workspaces",
    "channels",
    "channelThreadScopes",
    "channel_thread_scopes",
    "threads",
    "mentions",
    "keywords"
  ].some((key) => key in rawOverride);
  if (!hasOverride) return null;

  return {
    parsed: parseSlackCollectionScopeSettings(rawOverride)
  };
}

function parseSlackCollectionTrigger(value: unknown): "manual" | "scheduled" | null {
  const trigger = stringValue(value);
  return trigger === "manual" || trigger === "scheduled" ? trigger : null;
}

function mergeSlackCollectionScopeForManualCollection(
  saved: SlackCollectionScopeSettings,
  override: Partial<SlackCollectionScopeSettings>
): SlackCollectionScopeSettings {
  const merged: SlackCollectionScopeSettings = {
    ...saved,
    ...override,
    workspace: saved.workspace,
    workspaces: saved.workspaces,
    channelThreadScopes: saved.channelThreadScopes,
    updatedAt: saved.updatedAt
  };

  if (override.workspace !== undefined || override.workspaces !== undefined) {
    merged.workspace = override.workspace ?? override.workspaces?.[0] ?? null;
    merged.workspaces = override.workspaces ?? (override.workspace ? [override.workspace] : []);
  }
  if (override.channelThreadScopes !== undefined) {
    merged.channelThreadScopes = override.channelThreadScopes;
  }

  return merged;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of value) {
    const stringItem = stringValue(item);
    if (!stringItem || seen.has(stringItem)) continue;
    seen.add(stringItem);
    values.push(stringItem);
  }
  return values;
}

function buildSlackTaskCandidateDedupeKey(
  context: { workspaceId?: string | null; channelId?: string | null; threadTs?: string | null; messageTs?: string | null },
  assigneeKey: string
): string | null {
  const sourceTs = context.threadTs ?? context.messageTs;
  if (!context.channelId || !sourceTs) return null;
  return `slack:${context.workspaceId ?? "unknown"}:${context.channelId}:${sourceTs}:${assigneeKey}`;
}

function findSlackTaskCandidateTaskBySourceIdentity(
  store: ServerContext["store"],
  agentId: string,
  context: AgentThreadContext,
  assigneeKey: string
): Task | null {
  const channelId = stringValue(context.channelId);
  const sourceTs = stringValue(context.threadTs) ?? stringValue(context.messageTs);
  if (!channelId || !sourceTs) return null;

  const candidate = store.getSlackTaskCandidateBySourceIdentity(agentId, {
    workspaceId: context.workspaceId ?? "unknown",
    channelId,
    sourceTs,
    assigneeKey
  });
  if (!candidate) return null;

  return store.getTask(candidate.taskId) ?? store.findTaskByDedupeKey(candidate.dedupeKey);
}

function enqueueSlackTaskCandidateConfirmation(
  store: ServerContext["store"],
  agent: AgentSettings,
  task: Task,
  input: {
    context?: AgentThreadContext;
    messageText?: string | null;
    assigneeOwner?: OwnerMapping | null;
    assigneeCandidates?: string[];
    assigneeResolution?: SlackTaskCandidateMetadata["assigneeResolution"];
    requiresAssigneeConfirmation?: boolean;
    memberMappingUncertainties?: SlackMemberMappingUncertainty[];
    relevantContext?: string[];
    leaderReviewer?: string | null;
    leaderReviewChannelId?: string | null;
    leaderReviewThreadTs?: string | null;
    confirmationTarget?: string | null;
    confirmationState?: SlackTaskCandidateMetadata["confirmationState"];
  } = {}
): { candidate: SlackTaskCandidateMetadata | null; outbox: OutboxItem | null } {
  if (task.status !== "proposed" || !task.dedupeKey) return { candidate: null, outbox: null };

  const explicitLeaderReviewer = stringValue(input.leaderReviewer);
  const explicitConfirmationTarget = stringValue(input.confirmationTarget);
  const leaderReviewer = explicitLeaderReviewer ?? resolveSlackLeaderReviewer(store, task, input.context);
  const resolvedAssigneeSlackUserId = stringValue(input.assigneeOwner?.slackUserId);
  const memberMappingUncertainties = input.memberMappingUncertainties ?? [];
  const hasUnresolvedAssigneeMapping = memberMappingUncertainties.some(
    (uncertainty) => uncertainty.subject === "mentioned_user"
  );
  const confirmationTarget = hasUnresolvedAssigneeMapping
    ? leaderReviewer ?? explicitConfirmationTarget ?? resolvedAssigneeSlackUserId ?? ""
    : explicitConfirmationTarget ?? resolvedAssigneeSlackUserId ?? leaderReviewer ?? "";
  const assigneeResolution = input.assigneeResolution ?? slackTaskCandidateAssigneeResolution(task, input.assigneeCandidates ?? []);
  const requiresAssigneeConfirmation =
    input.requiresAssigneeConfirmation ?? (assigneeResolution !== "assigned" || !task.assignee);

  const messageText =
    input.messageText ??
    input.context?.messages?.find((message) => message.text.trim())?.text ??
    task.description ??
    task.title;
  const candidate: SlackTaskCandidateMetadata = {
    candidateId: task.id,
    workspaceId: input.context?.workspaceId ?? "unknown",
    channelId: task.channelId ?? "",
    threadTs: task.threadTs,
    messageTs: input.context?.messageTs ?? task.threadTs ?? task.createdAt,
    messageText,
    taskTitle: task.title,
    taskDescription: task.description,
    taskClassification: task.category,
    sourceChannel: {
      workspaceId: input.context?.workspaceId ?? "unknown",
      channelId: task.channelId ?? "",
      channelName: input.context?.channelName ?? null,
      threadTs: task.threadTs,
      messageTs: input.context?.messageTs ?? task.threadTs ?? task.createdAt
    },
    sourceMessageLink: task.sourceUrl ?? input.context?.permalink ?? "",
    requester: task.sourceAuthor ?? input.context?.authorId ?? input.context?.authorName ?? "unknown",
    relevantContext: Array.from(
      new Set([...(input.relevantContext ?? []), messageText, task.description, input.context?.permalink ?? task.sourceUrl ?? ""])
    )
      .map((item) => item.trim())
      .filter(Boolean),
    assignee: task.assignee,
    assigneeCandidates: input.assigneeCandidates ?? [],
    assigneeOptions: buildSlackTaskCandidateAssigneeOptions(store),
    assigneeResolution,
    requiresAssigneeConfirmation,
    memberMappingUncertainties,
    leaderReviewer,
    leaderReviewChannelId: stringValue(input.leaderReviewChannelId),
    leaderReviewThreadTs: stringValue(input.leaderReviewThreadTs),
    confirmationTarget,
    confirmationState: input.confirmationState ?? (task.assignee ? "proposed" : "assigning"),
    dedupeKey: task.dedupeKey,
    dueAt: task.dueAt,
    nextAction: task.nextAction,
    sourceUrl: task.sourceUrl,
    markdownPath: task.markdownPath
  };
  candidate.slackProfileContext = buildSlackTaskCandidateProfileContext(store, candidate);
  candidate.atmIdentityContext = buildSlackTaskCandidateATMIdentityContext(candidate);

  const existingConfirmation = store.getSlackTaskCandidateConfirmationByDedupeKey(agent.id, task.dedupeKey);
  const existingCandidate = store.getSlackTaskCandidateByDedupeKey(agent.id, task.dedupeKey);
  if (existingConfirmation && existingCandidate) return { candidate: existingCandidate.payload, outbox: null };

  store.upsertSlackTaskCandidate({
    agentId: agent.id,
    taskId: task.id,
    candidate
  });
  if (!confirmationTarget) return { candidate, outbox: null };
  if (existingConfirmation) return { candidate, outbox: null };
  if (store.hasOutboxPayloadDedupeKey(agent.id, task.dedupeKey)) return { candidate, outbox: null };

  const action = buildSlackTaskCandidateConfirmationMessage(candidate);
  let outbox: OutboxItem | null = null;
  store.db.transaction(() => {
    outbox = store.enqueueOutbox(agent.id, "slack.actions", {
      taskCandidateConfirmation: true,
      taskId: task.id,
      dedupeKey: task.dedupeKey,
      actions: [action]
    });
    store.upsertSlackTaskCandidateConfirmationRequest({
      agentId: agent.id,
      taskId: task.id,
      outboxId: outbox.id,
      candidate
    });
  })();
  return { candidate, outbox };
}

function enqueueSlackTaskCandidateReviewNeededNotification(
  store: ServerContext["store"],
  agent: AgentSettings,
  confirmation: SlackTaskCandidateConfirmationRequest
): OutboxItem | null {
  const confirmationTarget = stringValue(confirmation.payload.leaderReviewer) ?? confirmation.confirmationTarget;
  if (!confirmationTarget) return null;

  const candidate: SlackTaskCandidateMetadata = {
    ...confirmation.payload,
    confirmationTarget,
    confirmationState: "review_needed"
  };
  const action = buildSlackTaskCandidateConfirmationMessage(candidate);
  return store.enqueueOutbox(agent.id, "slack.actions", {
    taskCandidateReviewNeeded: true,
    reason: "no_response_timeout",
    taskId: confirmation.taskId,
    confirmationId: confirmation.id,
    sourceDedupeKey: confirmation.dedupeKey,
    dedupeKey: `${confirmation.dedupeKey}:review_needed`,
    actions: [action]
  });
}

function slackTaskCandidateAssigneeResolution(
  task: Task,
  assigneeCandidates: string[]
): NonNullable<SlackTaskCandidateMetadata["assigneeResolution"]> {
  if (task.assignee) return "assigned";
  if (assigneeCandidates.length > 1) return "ambiguous";
  return "unassigned";
}

function buildSlackTaskCandidateAssigneeOptions(store: ServerContext["store"]): SlackTaskCandidateAssigneeOption[] {
  return store
    .listOwners()
    .filter((owner) => owner.active && owner.slackUserId)
    .map((owner) => ({
      ownerId: owner.id,
      ownerName: owner.ownerName,
      slackUserId: owner.slackUserId!
    }));
}

function buildSlackTaskCandidateProfileContext(
  store: ServerContext["store"],
  candidate: SlackTaskCandidateMetadata
): SlackTaskCandidateProfileContext[] {
  const profiles: SlackTaskCandidateProfileContext[] = [];
  const pushProfile = (
    role: SlackTaskCandidateProfileContextRole,
    value: string | null | undefined,
    uncertaintySubject?: SlackMemberMappingUncertainty["subject"]
  ) => {
    const rawValue = stringValue(value);
    if (!rawValue) return;
    const owner = store.resolveOwner(rawValue);
    const slackUserId = isSlackUserId(rawValue) ? rawValue : owner?.slackUserId ?? null;
    const slackUserName = isSlackUserId(rawValue) ? null : rawValue;
    const uncertaintyReason = uncertaintySubject
      ? slackCandidateUncertaintyReason(candidate.memberMappingUncertainties ?? [], uncertaintySubject, slackUserId, slackUserName)
      : null;
    profiles.push({
      role,
      slackUserId,
      slackUserName,
      atmOwnerId: owner?.id ?? null,
      atmOwnerName: owner?.ownerName ?? null,
      mappingStatus: owner ? "mapped" : slackUserId ? "unmapped" : "unknown",
      uncertaintyReason
    });
  };

  pushProfile("requester", candidate.requester, "author");
  for (const assigneeCandidate of Array.from(new Set(candidate.assigneeCandidates))) {
    pushProfile("candidate_assignee", assigneeCandidate, "mentioned_user");
  }
  pushProfile("leader_reviewer", candidate.leaderReviewer);
  pushProfile("confirmation_target", candidate.confirmationTarget);
  return profiles;
}

function slackCandidateUncertaintyReason(
  uncertainties: SlackMemberMappingUncertainty[],
  subject: SlackMemberMappingUncertainty["subject"],
  slackUserId: string | null,
  slackUserName: string | null
): SlackMemberMappingUncertaintyReason | null {
  return (
    uncertainties.find((uncertainty) => {
      if (uncertainty.subject !== subject) return false;
      if (slackUserId && uncertainty.slackUserId === slackUserId) return true;
      if (slackUserName && uncertainty.slackUserName === slackUserName) return true;
      return !slackUserId && !slackUserName;
    })?.reason ?? null
  );
}

function buildSlackTaskCandidateATMIdentityContext(
  candidate: SlackTaskCandidateMetadata
): SlackTaskCandidateATMIdentityContext {
  return {
    candidateId: candidate.candidateId,
    taskTitle: candidate.taskTitle,
    taskClassification: candidate.taskClassification ?? null,
    confirmationState: candidate.confirmationState,
    assignee: candidate.assignee,
    assigneeResolution: candidate.assigneeResolution ?? null,
    requiresAssigneeConfirmation: candidate.requiresAssigneeConfirmation ?? false,
    dedupeKey: candidate.dedupeKey,
    markdownPath: candidate.markdownPath,
    sourceUrl: candidate.sourceUrl
  };
}

function resolveSlackLeaderReviewer(
  store: ServerContext["store"],
  task: Task,
  context?: AgentThreadContext
): string | null {
  const directSlackUserId = [context?.authorId, task.sourceAuthor]
    .map((value) => stringValue(value))
    .find((value): value is string => Boolean(value && isSlackUserId(value)));
  if (directSlackUserId) return directSlackUserId;

  const mappedLeader = [context?.authorName, task.sourceAuthor]
    .map((value) => store.resolveOwner(stringValue(value) ?? null))
    .find((owner): owner is OwnerMapping => Boolean(owner?.active && owner.slackUserId));
  if (mappedLeader?.slackUserId) return mappedLeader.slackUserId;

  return store.listOwners().find((owner) => owner.active && owner.slackUserId)?.slackUserId ?? null;
}

function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9_]{2,}$/.test(value);
}
