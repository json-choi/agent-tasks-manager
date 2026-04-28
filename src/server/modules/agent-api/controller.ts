import { Elysia } from "elysia";
import { adapterFor } from "../../adapters/agent-adapter";
import type { ServerContext } from "../../context";
import { syncTaskToGitHub } from "../../services/github-sync.service";
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
import type { TaskState } from "../../shared/types";
import { asRecord, booleanValue, jsonResponse, numberValue, stringValue } from "../../shared/utils";

export function agentApiController({ store, requireAgent }: ServerContext) {
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
        assignee: stringValue(input.assignee),
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
      const task = store.getTask(result.task.id) ?? result.task;

      const adapter = adapterFor(auth.agent.type);
      return {
        ok: true,
        duplicate: result.duplicate,
        channelMode,
        task,
        githubSync,
        actions: adapter.createTask(task, result.duplicate)
      };
    })
    .post("/api/agent/task/:id/assignment-response", ({ request, params, body }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const accepted = booleanValue(input.accepted);
      const assignee = stringValue(input.assigneeId) ?? stringValue(input.assignee);
      const current = store.getTask(params.id);
      if (!current) return jsonResponse({ error: "Task not found" }, 404);

      const nextStatus: TaskState =
        accepted === true ? "in_progress" : accepted === false ? "blocked" : "assigning";
      const task = store.updateTask(params.id, {
        status: nextStatus,
        assignee: assignee ?? current.assignee
      });
      if (!task) return jsonResponse({ error: "Task not found" }, 404);

      store.markAgentSeen(auth.agent.id);
      store.recordEvent(auth.agent.id, "agent.task.assignment_response", {
        taskId: task.id,
        accepted,
        assignee,
        text: stringValue(input.text)
      });

      const adapter = adapterFor(auth.agent.type);
      return {
        ok: true,
        task,
        actions: adapter.postTaskUpdate(
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
      const updated = store.updateTask(task.id, {
        status: "assigning",
        assignee: assignee ?? task.assignee
      });
      if (!updated) return jsonResponse({ error: "Task not found" }, 404);

      store.markAgentSeen(auth.agent.id);
      store.recordEvent(auth.agent.id, "agent.task.ask_assignee", {
        taskId: task.id,
        assignee
      });

      return {
        ok: true,
        task: updated,
        actions: adapterFor(auth.agent.type).askAssignee(updated, assignee ?? updated.assignee)
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
      return { outbox: store.listOutbox(auth.agent.id, limit) };
    })
    .post("/api/agent/outbox/:id/ack", ({ request, params }) => {
      const auth = requireAgent(request);
      if ("response" in auth) return auth.response;

      const item = store.ackOutbox(auth.agent.id, params.id);
      if (!item) return jsonResponse({ error: "Outbox item not found" }, 404);
      return { ok: true, outbox: item };
    });
}
