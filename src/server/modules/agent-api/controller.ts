import { Elysia } from "elysia";
import { adapterFor } from "../../adapters/agent-adapter";
import type { ServerContext } from "../../context";
import { syncTaskToGitHub } from "../../services/github-sync.service";
import { invitationUrl, memberInvitationToken, memberInviteAction } from "../../services/member-invitation.service";
import {
  filterCardTasks,
  inferPriorityFromText,
  inferTitle,
  parseSlackDigestMessage,
  parseThreadContext,
  renderTaskCardsText,
  renderThreadDescription
} from "../../services/slack-task.service";
import { inferTaskCategory } from "../../services/task-classification.service";
import { parseTaskPriority, parseTaskState, signalToStatus } from "../../shared/parsers";
import type { AgentSettings, AssignmentRequest, OutboxItem, OwnerMapping, SlackAction, Task, TaskState } from "../../shared/types";
import { asRecord, booleanValue, jsonResponse, numberValue, safeJsonParse, stringValue } from "../../shared/utils";

export function agentApiController({ config, store, requireAgent }: ServerContext) {
  return new Elysia({ name: "agent-api.controller" })
    .post("/api/agent/connect/test", ({ request, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      store.markAgentSeen(auth.agent.id);
      store.recordEvent(auth.agent.id, "agent.connect.test", asRecord(body));
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
      const rawMessages = Array.isArray(input.messages) ? input.messages : [];
      const messages = rawMessages
        .map((message) => parseSlackDigestMessage(message, channelId, stringValue(input.channelName)))
        .filter((message): message is NonNullable<ReturnType<typeof parseSlackDigestMessage>> => Boolean(message));

      const digest = store.createSlackDigest(auth.agent.id, {
        channelId,
        channelName: stringValue(input.channelName),
        messages,
        nextLastTs: stringValue(input.nextLastTs),
        includeThreads: booleanValue(input.includeThreads) ?? true
      });
      store.markAgentSeen(auth.agent.id);

      return {
        ok: true,
        digest,
        cursor: store.getSlackCursor(auth.agent.id, channelId)
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
        return {
          ok: true,
          ...result,
          tasks,
          githubSync,
          actions: tasks.map((task) => adapterFor(auth.agent.type).createTask(task, false)).flat()
        };
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : "Digest commit failed" }, 404);
      }
    })
    .post("/api/agent/thread/capture", ({ request, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const context = parseThreadContext(body, auth.agent);
      const adapter = adapterFor(auth.agent.type);
      store.markAgentSeen(auth.agent.id);
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
      const context = parseThreadContext(input.context ?? body, auth.agent);
      const automatic = booleanValue(input.automatic) === true;
      const channelMode = store.getChannelMode(context.channelId ?? null);

      store.markAgentSeen(auth.agent.id);
      store.recordEvent(auth.agent.id, "agent.task.propose.request", { context, body: input });

      if (automatic && channelMode === "manual_only") {
        return {
          ok: true,
          ignored: true,
          reason: "Channel is manual_only",
          channelMode,
          actions: []
        };
      }

      const explicitTitle = stringValue(input.title);
      const title = explicitTitle ?? inferTitle(context);
      const description = stringValue(input.description) ?? renderThreadDescription(context);
      const confirmed = booleanValue(input.confirmed) === true;
      const githubRef = stringValue(input.githubRef);
      const initiative = stringValue(input.initiative);
      const requestedAssignee = stringValue(input.assignee);
      const suggestedOwner = requestedAssignee ? resolveAssignmentOwner(store, requestedAssignee) : null;
      if (requestedAssignee && !suggestedOwner) {
        return jsonResponse({ error: "Assignee must match an active owner with a Slack user ID." }, 400);
      }
      const category = inferTaskCategory(
        { category: input.category, title, description, initiative, githubRef },
        store.getGitHubSettings()
      );
      const result = store.createTask({
        title,
        description,
        status: confirmed ? "confirmed" : "proposed",
        priority: parseTaskPriority(input.priority) ?? inferPriorityFromText(`${title} ${description}`),
        category,
        assignee: suggestedOwner?.ownerName ?? null,
        reporter: stringValue(input.reporter) ?? context.authorName ?? context.authorId ?? null,
        notify: booleanValue(input.notify) ?? true,
        initiative,
        nextAction: stringValue(input.nextAction),
        result: stringValue(input.result),
        githubRef,
        channelId: context.channelId ?? null,
        threadTs: context.threadTs ?? null,
        sourceAgentId: auth.agent.id,
        sourceAgentName: context.agentName ?? auth.agent.name,
        sourceAuthor: context.authorId ?? context.authorName ?? null,
        sourceUrl: context.permalink ?? null,
        dueAt: stringValue(input.dueAt),
        dedupeKey: store.buildDedupeKey(context)
      });
      const githubSync = await syncTaskToGitHub(store, result.task);
      let task = store.getTask(result.task.id) ?? result.task;

      const adapter = adapterFor(auth.agent.type);
      const assignment = suggestedOwner && !result.duplicate
        ? createAssignmentRequestForOwner(store, auth.agent, task, suggestedOwner, {
            requestedBy: context.authorId ?? context.authorName ?? null
          })
        : null;
      if (assignment) task = assignment.task;
      return {
        ok: true,
        duplicate: result.duplicate,
        channelMode,
        task,
        githubSync,
        assignmentRequest: assignment?.assignmentRequest,
        actions: [...adapter.createTask(task, result.duplicate), ...(assignment?.actions ?? [])]
      };
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
    .post("/api/agent/slack/interaction", ({ request, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

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

function parseAssignmentInteraction(value: unknown): {
  requestId: string | null;
  action: "accept" | "decline" | "delegate";
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

  if (explicitAction === "accept" || actionId === "atm_assignment_accept") {
    return { requestId, action: "accept", delegateOwnerId: null, responseText };
  }
  if (explicitAction === "delegate" || actionId === "atm_assignment_delegate_select") {
    return { requestId, action: "delegate", delegateOwnerId, responseText };
  }
  return { requestId, action: "decline", delegateOwnerId: null, responseText };
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
