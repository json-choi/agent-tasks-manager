import { Elysia } from "elysia";
import type { ServerContext } from "../../context";
import { parseTaskPriority, parseTaskState } from "../../shared/parsers";
import type { TaskPriority, TaskState } from "../../shared/types";
import { asRecord, booleanValue, jsonResponse, stringValue } from "../../shared/utils";

export function tasksController({ store, requireAdmin }: ServerContext) {
  return new Elysia({ name: "tasks.controller" })
    .get("/api/tasks", async ({ request, query }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const status = parseTaskState(query.status);
      const assignee = stringValue(query.assignee);
      return {
        tasks: store.listTasks({
          ...(status ? { status } : {}),
          ...(assignee ? { assignee } : {})
        })
      };
    })
    .post("/api/tasks", async ({ request, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const title = stringValue(input.title);
      if (!title) return jsonResponse({ error: "Task title is required" }, 400);
      const assignee = slackOwnerName(store, input.assignee, "Assignee");
      if (assignee instanceof Response) return assignee;
      const reporter = slackOwnerName(store, input.reporter, "Reporter");
      if (reporter instanceof Response) return reporter;

      const status = parseTaskState(input.status) ?? "confirmed";
      const result = store.createTask({
        title,
        description: stringValue(input.description) ?? "",
        status,
        priority: parseTaskPriority(input.priority) ?? "P2",
        assignee,
        reporter,
        notify: booleanValue(input.notify) ?? true,
        initiative: stringValue(input.initiative),
        nextAction: stringValue(input.nextAction),
        result: stringValue(input.result),
        githubRef: stringValue(input.githubRef),
        dueAt: stringValue(input.dueAt)
      });

      return jsonResponse({ task: result.task, duplicate: result.duplicate }, 201);
    })
    .get("/api/tasks/:id", async ({ request, params }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const task = store.getTask(params.id);
      if (!task) return jsonResponse({ error: "Task not found" }, 404);
      return { task };
    })
    .patch("/api/tasks/:id", async ({ request, params, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const update: {
        title?: string;
        description?: string;
        status?: TaskState;
        priority?: TaskPriority;
        assignee?: string | null;
        reporter?: string | null;
        notify?: boolean;
        initiative?: string | null;
        nextAction?: string | null;
        result?: string | null;
        githubRef?: string | null;
        dueAt?: string | null;
      } = {};
      const title = stringValue(input.title);
      const description = typeof input.description === "string" ? input.description : null;
      const status = parseTaskState(input.status);
      const priority = parseTaskPriority(input.priority);
      const assignee = "assignee" in input ? slackOwnerName(store, input.assignee, "Assignee") : undefined;
      if (assignee instanceof Response) return assignee;
      const reporter = "reporter" in input ? slackOwnerName(store, input.reporter, "Reporter") : undefined;
      if (reporter instanceof Response) return reporter;

      if (title) update.title = title;
      if (description !== null) update.description = description;
      if (status) update.status = status;
      if (priority) update.priority = priority;
      if (assignee !== undefined) update.assignee = assignee;
      if (reporter !== undefined) update.reporter = reporter;
      if ("notify" in input) update.notify = booleanValue(input.notify) ?? true;
      if ("initiative" in input) update.initiative = stringValue(input.initiative);
      if ("nextAction" in input) update.nextAction = stringValue(input.nextAction);
      if ("result" in input) update.result = stringValue(input.result);
      if ("githubRef" in input) update.githubRef = stringValue(input.githubRef);
      if ("dueAt" in input) update.dueAt = stringValue(input.dueAt);

      const task = store.updateTask(params.id, update);
      if (!task) return jsonResponse({ error: "Task not found" }, 404);
      return { task };
    });
}

function slackOwnerName(
  store: ServerContext["store"],
  value: unknown,
  field: "Assignee" | "Reporter"
): string | null | Response {
  const raw = stringValue(value);
  if (!raw) return null;
  const owner = store.resolveOwner(raw);
  if (!owner?.slackUserId) {
    return jsonResponse({ error: `${field} must be selected from active Slack users in Settings.` }, 400);
  }
  return owner.ownerName;
}
