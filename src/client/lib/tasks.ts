import type { ApiClient, OwnerMapping, Task, View } from "../types";

export const statuses = ["proposed", "confirmed", "assigning", "in_progress", "blocked", "review_needed", "done", "cancelled"] as const;
export const priorities = ["P0", "P1", "P2"] as const;
export const categories = ["general", "coding"] as const;
export const taskViews: View[] = ["dashboard", "tasks"];
export const unassignedMemberId = "__unassigned__";
export const taskSourceFilterOrder = ["Issue", "Code", "Agent", "Manual"] as const;

export type TaskStatusGroup = {
  id: string;
  label: string;
  statuses: readonly string[];
};

export const taskStatusGroups: readonly TaskStatusGroup[] = [
  { id: "backlog-ready", label: "Backlog/Ready", statuses: ["proposed", "confirmed", "assigning"] },
  { id: "in-progress", label: "In Progress", statuses: ["in_progress"] },
  { id: "blocked-review", label: "Blocked/Review", statuses: ["blocked", "review_needed"] },
  { id: "done", label: "Done", statuses: ["done"] }
] as const;

export type TaskMemberColumn = {
  id: string;
  label: string;
  assignee: string | null;
  tasks: Task[];
};

export type TaskStatusGroupSection = TaskStatusGroup & {
  tasks: Task[];
};

export type TaskFilterOption = {
  value: string;
  label: string;
  count: number;
};

export type TaskFilterOptionList = {
  options: TaskFilterOption[];
  emptyLabel: string | null;
};

export type TaskBoardFilters = {
  memberId?: string;
  statusGroup?: string;
  detailedStatus?: string;
  priority?: string;
  source?: string;
};

export type TaskStatusFilterDependency = {
  selectedStatusGroup: TaskStatusGroup | null;
  selectedDetailedStatusGroup: TaskStatusGroup | null;
  isDetailedStatusFilterDisabled: boolean;
  shouldResetDetailedStatus: boolean;
};

export type TaskBoardDropUpdate = {
  assignee: string | null;
  status: string;
  changed: boolean;
};

export type TaskCreateBoardContext = {
  assignee: string;
  memberLabel: string;
  memberId: string | null;
  status: string;
  statusGroupId: string | null;
  statusGroupLabel: string;
};

export function taskDraft(task: Task): {
  status: string;
  priority: string;
  category: string;
  assignee: string;
  reporter: string;
  initiative: string;
  nextAction: string;
  result: string;
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
    result: task.result || "",
    githubRef: task.githubRef || "",
    description: task.description || ""
  };
}

export function taskCreateBoardContext({
  columns,
  detailedStatusFilter = "",
  memberId = "",
  statusGroupFilter = ""
}: {
  columns: TaskMemberColumn[];
  detailedStatusFilter?: string;
  memberId?: string;
  statusGroupFilter?: string;
}): TaskCreateBoardContext {
  const column = memberId ? columns.find((item) => item.id === memberId) ?? null : null;
  const statusGroup = statusGroupFilter
    ? taskStatusGroupForId(statusGroupFilter)
    : detailedStatusFilter
      ? taskStatusGroupForStatus(detailedStatusFilter)
      : null;

  return {
    assignee: column?.assignee ?? "",
    memberLabel: column?.label ?? "Unassigned",
    memberId: column?.id ?? null,
    status: taskCreateDefaultStatus(statusGroupFilter, detailedStatusFilter),
    statusGroupId: statusGroup?.id ?? null,
    statusGroupLabel: statusGroup?.label ?? "Backlog/Ready"
  };
}

export function taskCreateDefaultStatus(statusGroupFilter = "", detailedStatusFilter = "") {
  const detailedStatus = detailedStatusFilter.trim();
  if (detailedStatus && taskStatusGroupForStatus(detailedStatus)) return detailedStatus;

  const statusGroup = statusGroupFilter ? taskStatusGroupForId(statusGroupFilter) : null;
  if (!statusGroup) return "confirmed";
  if (statusGroup.statuses.includes("confirmed")) return "confirmed";
  return statusGroup.statuses[0] ?? "confirmed";
}

export function taskCreateTitleValidationMessage(title: string) {
  return title.trim() ? null : "Task title is required.";
}

export function slackPeople(people: OwnerMapping[]) {
  return people.filter((owner) => owner.active && owner.slackUserId);
}

export function filterTasks(tasks: Task[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return tasks;
  return tasks.filter((task) => [task.title, task.id]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query)));
}

export function taskMemberColumns(tasks: Task[], people: OwnerMapping[]): TaskMemberColumn[] {
  const activeMembers = people
    .filter((owner) => owner.active)
    .sort((a, b) => a.ownerName.localeCompare(b.ownerName));
  const activeNames = new Set(activeMembers.map((owner) => owner.ownerName));
  const columns: TaskMemberColumn[] = activeMembers.map((owner) => ({
    id: owner.id,
    label: owner.ownerName,
    assignee: owner.ownerName,
    tasks: tasks.filter((task) => task.assignee === owner.ownerName)
  }));
  const unassignedTasks = tasks.filter((task) => !task.assignee || !activeNames.has(task.assignee));

  columns.push({
    id: unassignedMemberId,
    label: "Unassigned",
    assignee: null,
    tasks: unassignedTasks
  });

  return columns;
}

export function taskMemberFilterOptions(tasks: Task[], people: OwnerMapping[]): TaskFilterOptionList {
  const options = taskMemberColumns(tasks, people).map((column) => ({
    value: column.id,
    label: column.label,
    count: column.tasks.length
  }));

  return taskFilterOptionList(options, "No members available");
}

export function filterTaskMemberColumns(columns: TaskMemberColumn[], memberId: string) {
  if (!memberId) return columns;
  return columns.filter((column) => column.id === memberId);
}

export function filterTasksByMember(tasks: Task[], people: OwnerMapping[], memberId: string) {
  if (!memberId) return tasks;
  const column = taskMemberColumns(tasks, people).find((item) => item.id === memberId);
  return column?.tasks ?? [];
}

export function filterTasksBySource(tasks: Task[], sourceFilter: string) {
  if (!sourceFilter) return tasks;
  return tasks.filter((task) => taskSource(task) === sourceFilter);
}

export function filterTasksByPriority(tasks: Task[], priorityFilter: string) {
  if (!priorityFilter) return tasks;
  return tasks.filter((task) => (task.priority || "P2") === priorityFilter);
}

export function filterTasksByStatusGroup(tasks: Task[], statusGroupFilter: string) {
  if (!statusGroupFilter) return tasks;
  const statusGroup = taskStatusGroupForId(statusGroupFilter);
  if (!statusGroup) return tasks;
  return tasks.filter((task) => statusGroup.statuses.includes(task.status));
}

export function filterTasksByDetailedStatus(tasks: Task[], detailedStatusFilter: string) {
  if (!detailedStatusFilter) return tasks;
  return tasks.filter((task) => task.status === detailedStatusFilter);
}

export function filterTasksByStatusFilters(tasks: Task[], statusGroupFilter: string, detailedStatusFilter: string) {
  const statusGroup = statusGroupFilter ? taskStatusGroupForId(statusGroupFilter) : null;
  const detailedStatus = detailedStatusFilter.trim();

  if (!statusGroup && !detailedStatus) return tasks;
  if (!detailedStatus) return statusGroup ? filterTasksByStatusGroup(tasks, statusGroup.id) : tasks;

  const detailedStatusGroup = taskStatusGroupForStatus(detailedStatus);
  if (!detailedStatusGroup) return [];
  if (statusGroup && !statusGroup.statuses.includes(detailedStatus)) return [];

  return tasks.filter((task) => task.status === detailedStatus);
}

export function filterTaskBoardTasks(tasks: Task[], people: OwnerMapping[], filters: TaskBoardFilters = {}) {
  const statusFilteredTasks = filterTasksByStatusFilters(tasks, filters.statusGroup ?? "", filters.detailedStatus ?? "");
  const priorityFilteredTasks = filterTasksByPriority(statusFilteredTasks, filters.priority ?? "");
  const sourceFilteredTasks = filterTasksBySource(priorityFilteredTasks, filters.source ?? "");
  return filterTasksByMember(sourceFilteredTasks, people, filters.memberId ?? "");
}

export function taskStatusGroupFilterOptions(tasks: Task[]): TaskFilterOptionList {
  const options = taskStatusGroups.map((group) => ({
    value: group.id,
    label: group.label,
    count: tasks.filter((task) => group.statuses.includes(task.status)).length
  }));

  return taskFilterOptionList(options, "No status groups available");
}

export function taskDetailedStatusFilterOptions(tasks: Task[], statusGroupFilter: string): TaskFilterOptionList {
  const selectedGroup = statusGroupFilter ? taskStatusGroupForId(statusGroupFilter) : null;
  const candidateStatuses = selectedGroup
    ? selectedGroup.statuses
    : taskStatusGroups.flatMap((group) => [...group.statuses]);
  const options = candidateStatuses.map((status) => ({
    value: status,
    label: formatTaskStatus(status),
    count: tasks.filter((task) => task.status === status).length
  }));

  return taskFilterOptionList(options, "No detailed statuses available");
}

export function taskStatusFilterDependency(statusGroupFilter: string, detailedStatusFilter: string): TaskStatusFilterDependency {
  const selectedStatusGroup = statusGroupFilter ? taskStatusGroupForId(statusGroupFilter) : null;
  const selectedDetailedStatusGroup = detailedStatusFilter ? taskStatusGroupForStatus(detailedStatusFilter) : null;
  const isDetailedStatusFilterDisabled = Boolean(selectedStatusGroup && selectedStatusGroup.statuses.length <= 1);
  const isDetailedStatusCompatible = Boolean(
    !detailedStatusFilter ||
    (
      selectedDetailedStatusGroup &&
      (!selectedStatusGroup || selectedStatusGroup.statuses.includes(detailedStatusFilter)) &&
      !isDetailedStatusFilterDisabled
    )
  );

  return {
    selectedStatusGroup,
    selectedDetailedStatusGroup,
    isDetailedStatusFilterDisabled,
    shouldResetDetailedStatus: Boolean(detailedStatusFilter && !isDetailedStatusCompatible)
  };
}

export function taskSourceFilterOptions(tasks: Task[]): TaskFilterOptionList {
  const counts = new Map<string, number>();

  for (const task of tasks) {
    const source = taskSource(task);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  const options = taskSourceFilterOrder
    .filter((source) => counts.has(source))
    .map((source) => ({
      value: source,
      label: source,
      count: counts.get(source) ?? 0
    }));

  return taskFilterOptionList(options, "No sources available");
}

export function taskPriorityFilterOptions(tasks: Task[]): TaskFilterOptionList {
  const options = priorities
    .map((priority) => ({
      value: priority,
      label: priority,
      count: tasks.filter((task) => (task.priority || "P2") === priority).length
    }))
    .filter((option) => option.count > 0);

  return taskFilterOptionList(options, "No priorities available");
}

export function taskStatusGroupForStatus(status: string) {
  return taskStatusGroups.find((group) => group.statuses.includes(status)) ?? null;
}

export function taskStatusGroupForId(id: string) {
  return taskStatusGroups.find((group) => group.id === id) ?? null;
}

export function taskStatusGroupRequiresDetailedStatusChoice(statusGroupId: string) {
  const statusGroup = taskStatusGroupForId(statusGroupId);
  return Boolean(statusGroup && statusGroup.statuses.length > 1);
}

export function taskBoardDropUpdate({
  assignee,
  currentAssignee,
  currentStatus,
  selectedStatus,
  statusGroupId
}: {
  assignee: string | null;
  currentAssignee?: string | null;
  currentStatus: string;
  selectedStatus?: string | null;
  statusGroupId: string;
}): TaskBoardDropUpdate | null {
  const statusGroup = taskStatusGroupForId(statusGroupId);
  if (!statusGroup) return null;

  const normalizedSelectedStatus = typeof selectedStatus === "string" ? selectedStatus.trim() : selectedStatus;
  const status = statusGroup.statuses.length === 1
    ? statusGroup.statuses[0]
    : normalizedSelectedStatus;
  if (!status || !statusGroup.statuses.includes(status)) return null;

  const normalizedAssignee = assignee || null;
  const normalizedCurrentAssignee = currentAssignee || null;

  return {
    assignee: normalizedAssignee,
    status,
    changed: normalizedCurrentAssignee !== normalizedAssignee || currentStatus !== status
  };
}

export function taskBoardDropPatch(update: TaskBoardDropUpdate, canChangeAssignee: boolean) {
  return canChangeAssignee
    ? { assignee: update.assignee, status: update.status }
    : { status: update.status };
}

export async function persistTaskBoardDrop(api: ApiClient, taskId: string, update: TaskBoardDropUpdate, canChangeAssignee: boolean) {
  const data = await api<{ task: Task }>(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: JSON.stringify(taskBoardDropPatch(update, canChangeAssignee))
  });

  return data.task;
}

export function replaceTaskInList(tasks: Task[], updatedTask: Task) {
  let replaced = false;
  const nextTasks = tasks.map((task) => {
    if (task.id !== updatedTask.id) return task;
    replaced = true;
    return updatedTask;
  });

  return replaced ? nextTasks : tasks;
}

export function reconcileTaskBoardDropState(tasks: Task[], persistedTask: Task) {
  const nextTasks = replaceTaskInList(tasks, persistedTask);
  return nextTasks === tasks ? [...tasks, persistedTask] : nextTasks;
}

export function insertTaskIntoBoardState(tasks: Task[], createdTask: Task) {
  return reconcileTaskBoardDropState(tasks, createdTask);
}

export function taskStatusGroupSections(tasks: Task[], statusGroups: readonly TaskStatusGroup[] = taskStatusGroups): TaskStatusGroupSection[] {
  return statusGroups.map((group) => ({
    ...group,
    tasks: tasks.filter((task) => group.statuses.includes(task.status))
  }));
}

export function taskStatusGroupCollapseKey(columnId: string, groupId: string) {
  return `${columnId}:${groupId}`;
}

export function toggleTaskStatusGroupCollapse(collapsedStatusGroups: ReadonlySet<string>, columnId: string, groupId: string) {
  const collapseKey = taskStatusGroupCollapseKey(columnId, groupId);
  const next = new Set(collapsedStatusGroups);
  if (next.has(collapseKey)) {
    next.delete(collapseKey);
  } else {
    next.add(collapseKey);
  }
  return next;
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

export function formatTaskStatus(status: string) {
  return status.split("_").join(" ");
}

function taskFilterOptionList(options: TaskFilterOption[], emptyLabel: string): TaskFilterOptionList {
  return {
    options,
    emptyLabel: options.length ? null : emptyLabel
  };
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
