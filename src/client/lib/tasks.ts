import type { OwnerMapping, Task, View } from "../types";

export const statuses = ["proposed", "confirmed", "assigning", "in_progress", "blocked", "review_needed", "done", "cancelled"];
export const priorities = ["P0", "P1", "P2"] as const;
export const categories = ["general", "coding"] as const;
export const taskViews: View[] = ["dashboard", "tasks"];

export function taskDraft(task: Task): {
  status: string;
  priority: string;
  category: string;
  assignee: string;
  reporter: string;
  initiative: string;
  nextAction: string;
  githubRef: string;
  description: string;
} {
  return {
    status: task.status,
    priority: task.priority || "P2",
    category: task.category || "general",
    assignee: task.assignee || "",
    reporter: task.reporter || "",
    initiative: task.initiative || "",
    nextAction: task.nextAction || "",
    githubRef: task.githubRef || "",
    description: task.description || ""
  };
}

export function slackPeople(people: OwnerMapping[]) {
  return people.filter((owner) => owner.active && owner.slackUserId);
}

export function filterTasks(tasks: Task[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return tasks;
  return tasks.filter((task) => [task.title, task.id, task.status, task.category, task.assignee, task.reporter, task.githubRef]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query)));
}

export function taskMetrics(tasks: Task[]) {
  return {
    open: tasks.filter((task) => !["done", "cancelled"].includes(task.status)).length,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    inProgress: tasks.filter((task) => task.status === "in_progress").length
  };
}

export function priorityMetrics(tasks: Task[]) {
  const total = Math.max(tasks.length, 1);
  const p0 = tasks.filter((task) => task.priority === "P0").length;
  const p1 = tasks.filter((task) => task.priority === "P1").length;
  const p2 = tasks.filter((task) => task.priority === "P2" || !task.priority).length;
  const p0End = Math.round((p0 / total) * 360);
  const p1End = p0End + Math.round((p1 / total) * 360);
  return {
    p0,
    p1,
    p2,
    gradient: `conic-gradient(var(--coral) 0 ${p0End}deg, var(--amber) ${p0End}deg ${p1End}deg, var(--blue) ${p1End}deg 360deg)`
  };
}

export function focusTasks(tasks: Task[]) {
  const priorityRank: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  const statusRank: Record<string, number> = { blocked: 0, review_needed: 1, in_progress: 2, assigning: 3, confirmed: 4, proposed: 5 };
  return tasks
    .filter((task) => !["done", "cancelled"].includes(task.status))
    .sort((a, b) => {
      const statusDelta = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
      if (statusDelta) return statusDelta;
      const priorityDelta = (priorityRank[a.priority || ""] ?? 3) - (priorityRank[b.priority || ""] ?? 3);
      if (priorityDelta) return priorityDelta;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
}

export function taskSource(task: Task) {
  if (task.githubRef) return "Issue";
  if (task.category === "coding") return "Code";
  if (task.channelId || task.threadTs || task.sourceAgentName) return "Agent";
  return "Manual";
}

export function activityLabel(task: Task) {
  if (task.status === "done") return "Task completed";
  if (task.status === "blocked") return "Task blocked";
  if (task.status === "in_progress") return "Task in progress";
  if (task.status === "proposed") return "Task proposed";
  return "Task updated";
}

export function searchPlaceholder(view: View) {
  if (view === "tasks") return "Search all tasks...";
  if (view === "agents") return "Search agents...";
  if (view === "integrations") return "Search integrations...";
  if (view === "settings") return "Search settings...";
  return "Search tasks...";
}

export function filterRecords<T extends object>(items: T[], fields: string[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) => fields.some((field) => String((item as Record<string, unknown>)[field] ?? "").toLowerCase().includes(query)));
}
