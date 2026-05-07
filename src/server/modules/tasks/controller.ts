import { Elysia } from "elysia";
import type { ServerContext } from "../../context";
import type { AuthUserSession } from "../../services/auth.service";
import { syncTaskToGitHub } from "../../services/github-sync.service";
import { inferTaskCategory } from "../../services/task-classification.service";
import { parseTaskCategory, parseTaskPriority, parseTaskState } from "../../shared/parsers";
import type { Task, TaskCategory, TaskPriority, TaskState } from "../../shared/types";
import { asRecord, booleanValue, jsonResponse, stringValue } from "../../shared/utils";

export function tasksController({ store, requireAdmin, requireUser }: ServerContext) {
  return new Elysia({ name: "tasks.controller" })
    .get("/api/tasks", async ({ request, query }) => {
      const auth = await requireUser(request);
      if ("response" in auth) return auth.response;

      const status = parseTaskState(query.status);
      const assignee = auth.user.role === "owner" ? stringValue(query.assignee) : auth.user.owner?.ownerName ?? null;
      if (auth.user.role === "member" && !assignee) return { tasks: [] };
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
      const description = stringValue(input.description) ?? "";
      const initiative = stringValue(input.initiative);
      const githubRef = stringValue(input.githubRef);
      const assignee = slackOwnerName(store, input.assignee, "Assignee");
      if (assignee instanceof Response) return assignee;
      const reporter = slackOwnerName(store, input.reporter, "Reporter");
      if (reporter instanceof Response) return reporter;

      const status = parseTaskState(input.status) ?? "confirmed";
      const result = store.createTask({
        title,
        description,
        status,
        priority: parseTaskPriority(input.priority) ?? "P2",
        category: inferTaskCategory({ category: input.category, title, description, initiative, githubRef }, store.getGitHubSettings()),
        assignee,
        reporter,
        notify: booleanValue(input.notify) ?? true,
        initiative,
        nextAction: stringValue(input.nextAction),
        result: stringValue(input.result),
        githubRef,
        dueAt: stringValue(input.dueAt)
      });
      const githubSync = await syncTaskToGitHub(store, result.task);
      const task = store.getTask(result.task.id) ?? result.task;

      return jsonResponse({ task, duplicate: result.duplicate, githubSync }, 201);
    })
    .get("/api/tasks/:id", async ({ request, params }) => {
      const auth = await requireUser(request);
      if ("response" in auth) return auth.response;

      const task = store.getTask(params.id);
      if (!task) return jsonResponse({ error: "Task not found" }, 404);
      if (!canAccessTask(auth.user, task)) return jsonResponse({ error: "Task not found" }, 404);
      return { task };
    })
    .patch("/api/tasks/:id", async ({ request, params, body }) => {
      const auth = await requireUser(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const current = store.getTask(params.id);
      if (!current) return jsonResponse({ error: "Task not found" }, 404);
      if (!canAccessTask(auth.user, current)) return jsonResponse({ error: "Task not found" }, 404);
      if (auth.user.role === "member") {
        const allowed = new Set(["status", "nextAction", "result"]);
        const forbidden = Object.keys(input).filter((key) => !allowed.has(key));
        if (forbidden.length > 0) return jsonResponse({ error: "Members can only update status, next action, and result." }, 403);

        const update: { status?: TaskState; nextAction?: string | null; result?: string | null } = {};
        const status = parseTaskState(input.status);
        if ("status" in input) {
          if (!status) return jsonResponse({ error: "A valid status is required" }, 400);
          update.status = status;
        }
        if ("nextAction" in input) update.nextAction = stringValue(input.nextAction);
        if ("result" in input) update.result = stringValue(input.result);
        if (Object.keys(update).length === 0) return jsonResponse({ error: "No supported task changes provided" }, 400);

        const task = store.updateTask(params.id, update);
        if (!task) return jsonResponse({ error: "Task not found" }, 404);
        const githubSync = await syncTaskToGitHub(store, task);
        return { task: store.getTask(task.id) ?? task, githubSync };
      }

      const update: {
        title?: string;
        description?: string;
        status?: TaskState;
        priority?: TaskPriority;
        category?: TaskCategory;
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
      const category = parseTaskCategory(input.category);
      const assignee = "assignee" in input ? slackOwnerName(store, input.assignee, "Assignee") : undefined;
      if (assignee instanceof Response) return assignee;
      const reporter = "reporter" in input ? slackOwnerName(store, input.reporter, "Reporter") : undefined;
      if (reporter instanceof Response) return reporter;

      if ("status" in input && !status) return jsonResponse({ error: "A valid status is required" }, 400);
      if (title) update.title = title;
      if (description !== null) update.description = description;
      if (status) update.status = status;
      if (priority) update.priority = priority;
      if (category) update.category = category;
      if (assignee !== undefined) update.assignee = assignee;
      if (reporter !== undefined) update.reporter = reporter;
      if ("notify" in input) update.notify = booleanValue(input.notify) ?? true;
      if ("initiative" in input) update.initiative = stringValue(input.initiative);
      if ("nextAction" in input) update.nextAction = stringValue(input.nextAction);
      if ("result" in input) update.result = stringValue(input.result);
      if ("githubRef" in input) {
        const githubRef = stringValue(input.githubRef);
        update.githubRef = githubRef;
        if (githubRef && !category) update.category = "coding";
      }
      if ("dueAt" in input) update.dueAt = stringValue(input.dueAt);

      const task = store.updateTask(params.id, update);
      if (!task) return jsonResponse({ error: "Task not found" }, 404);
      const githubSync = await syncTaskToGitHub(store, task);
      return { task: store.getTask(task.id) ?? task, githubSync };
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

function canAccessTask(user: AuthUserSession, task: Task): boolean {
  if (user.role === "owner") return true;
  return Boolean(user.owner?.ownerName && task.assignee === user.owner.ownerName);
}
