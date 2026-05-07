import { describe, expect, test } from "bun:test";
import {
  filterTasksByDetailedStatus,
  filterTaskMemberColumns,
  filterTaskBoardTasks,
  filterTasksByMember,
  filterTasks,
  filterTasksByPriority,
  filterTasksBySource,
  filterTasksByStatusGroup,
  filterTasksByStatusFilters,
  insertTaskIntoBoardState,
  persistTaskBoardDrop,
  reconcileTaskBoardDropState,
  replaceTaskInList,
  taskDetailedStatusFilterOptions,
  taskBoardDropPatch,
  taskBoardDropUpdate,
  taskCreateBoardContext,
  taskCreateDefaultStatus,
  taskCreateTitleValidationMessage,
  taskMemberColumns,
  taskMemberFilterOptions,
  taskPriorityFilterOptions,
  taskSourceFilterOptions,
  taskStatusFilterDependency,
  taskStatusGroupCollapseKey,
  taskStatusGroupFilterOptions,
  taskStatusGroupForId,
  taskStatusGroupRequiresDetailedStatusChoice,
  taskStatusGroupForStatus,
  taskStatusGroups,
  taskStatusGroupSections,
  toggleTaskStatusGroupCollapse,
  unassignedMemberId
} from "../src/client/lib/tasks";
import type { ApiClient, OwnerMapping, Task } from "../src/client/types";

describe("task search", () => {
  test("matches tasks by title and ID only", () => {
    const tasks: Task[] = [
      task({
        id: "ATM-101",
        title: "Ship member board",
        status: "blocked",
        assignee: "Alice",
        githubRef: "acme/tasks#77"
      }),
      task({
        id: "ATM-202",
        title: "Refine detail panel",
        status: "review_needed",
        assignee: "Bob",
        githubRef: "acme/tasks#88"
      })
    ];

    expect(filterTasks(tasks, "member").map((item) => item.id)).toEqual(["ATM-101"]);
    expect(filterTasks(tasks, "202").map((item) => item.id)).toEqual(["ATM-202"]);
    expect(filterTasks(tasks, "blocked")).toEqual([]);
    expect(filterTasks(tasks, "Alice")).toEqual([]);
    expect(filterTasks(tasks, "tasks#77")).toEqual([]);
  });
});

describe("task member columns", () => {
  test("groups visible tasks by active member and always includes Unassigned", () => {
    const people: OwnerMapping[] = [
      owner({ id: "owner-bob", ownerName: "Bob", active: true }),
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-inactive", ownerName: "Inactive", active: false })
    ];
    const tasks: Task[] = [
      task({ id: "ATM-1", title: "Alice task", assignee: "Alice" }),
      task({ id: "ATM-2", title: "Unassigned task", assignee: "" }),
      task({ id: "ATM-3", title: "External task", assignee: "External" })
    ];

    const columns = taskMemberColumns(tasks, people);

    expect(columns.map((column) => column.label)).toEqual(["Alice", "Bob", "Unassigned"]);
    expect(columns.find((column) => column.label === "Alice")?.tasks.map((item) => item.id)).toEqual(["ATM-1"]);
    expect(columns.find((column) => column.id === unassignedMemberId)?.tasks.map((item) => item.id)).toEqual(["ATM-2", "ATM-3"]);
    expect(columns.find((column) => column.label === "Bob")?.tasks).toEqual([]);
    expect(columns.find((column) => column.label === "Inactive")).toBeUndefined();
  });
});

describe("task board filter options", () => {
  test("derives stable member filter options from active board columns", () => {
    const people: OwnerMapping[] = [
      owner({ id: "owner-bob", ownerName: "Bob", active: true }),
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-inactive", ownerName: "Inactive", active: false })
    ];
    const options = taskMemberFilterOptions([
      task({ id: "ATM-1", title: "Alice ready", assignee: "Alice" }),
      task({ id: "ATM-2", title: "Unknown owner", assignee: "External" }),
      task({ id: "ATM-3", title: "No owner", assignee: "" })
    ], people);

    expect(options.emptyLabel).toBeNull();
    expect(options.options).toEqual([
      { value: "owner-alice", label: "Alice", count: 1 },
      { value: "owner-bob", label: "Bob", count: 0 },
      { value: unassignedMemberId, label: "Unassigned", count: 2 }
    ]);
  });

  test("keeps Unassigned as the member empty-state fallback", () => {
    const options = taskMemberFilterOptions([], []);

    expect(options.emptyLabel).toBeNull();
    expect(options.options).toEqual([
      { value: unassignedMemberId, label: "Unassigned", count: 0 }
    ]);
  });

  test("filters board columns by selected member without changing task search", () => {
    const columns = taskMemberColumns([
      task({ id: "ATM-1", title: "Alice ready", assignee: "Alice" }),
      task({ id: "ATM-2", title: "Bob ready", assignee: "Bob" })
    ], [
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-bob", ownerName: "Bob", active: true })
    ]);

    expect(filterTaskMemberColumns(columns, "").map((column) => column.id)).toEqual([
      "owner-alice",
      "owner-bob",
      unassignedMemberId
    ]);
    expect(filterTaskMemberColumns(columns, "owner-bob").map((column) => column.label)).toEqual(["Bob"]);
  });

  test("filters board tasks by selected member before columns are rendered", () => {
    const people: OwnerMapping[] = [
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-bob", ownerName: "Bob", active: true })
    ];
    const tasks = [
      task({ id: "ATM-1", title: "Alice task", assignee: "Alice" }),
      task({ id: "ATM-2", title: "Bob task", assignee: "Bob" }),
      task({ id: "ATM-3", title: "External task", assignee: "External" }),
      task({ id: "ATM-4", title: "Unassigned task", assignee: "" })
    ];

    expect(filterTasksByMember(tasks, people, "")).toEqual(tasks);
    expect(filterTasksByMember(tasks, people, "owner-bob").map((item) => item.id)).toEqual(["ATM-2"]);
    expect(filterTasksByMember(tasks, people, unassignedMemberId).map((item) => item.id)).toEqual(["ATM-3", "ATM-4"]);
  });

  test("derives unique source filter options in stable source order", () => {
    const options = taskSourceFilterOptions([
      task({ id: "ATM-1", title: "Manual task" }),
      task({ id: "ATM-2", title: "Agent task", channelId: "C123" }),
      task({ id: "ATM-3", title: "Issue task", githubRef: "acme/tasks#3" }),
      task({ id: "ATM-4", title: "Code task", category: "coding" }),
      task({ id: "ATM-5", title: "Another issue", githubRef: "acme/tasks#5" })
    ]);

    expect(options.emptyLabel).toBeNull();
    expect(options.options).toEqual([
      { value: "Issue", label: "Issue", count: 2 },
      { value: "Code", label: "Code", count: 1 },
      { value: "Agent", label: "Agent", count: 1 },
      { value: "Manual", label: "Manual", count: 1 }
    ]);
  });

  test("returns source empty-state copy when no board tasks provide sources", () => {
    const options = taskSourceFilterOptions([]);

    expect(options.options).toEqual([]);
    expect(options.emptyLabel).toBe("No sources available");
  });

  test("filters board tasks by selected source without changing task search scope", () => {
    const tasks = [
      task({ id: "ATM-1", title: "Manual task" }),
      task({ id: "ATM-2", title: "Agent task", channelId: "C123" }),
      task({ id: "ATM-3", title: "Issue task", githubRef: "acme/tasks#3" }),
      task({ id: "ATM-4", title: "Code task", category: "coding" })
    ];

    expect(filterTasksBySource(tasks, "").map((item) => item.id)).toEqual(["ATM-1", "ATM-2", "ATM-3", "ATM-4"]);
    expect(filterTasksBySource(tasks, "Agent").map((item) => item.id)).toEqual(["ATM-2"]);
    expect(filterTasksBySource(tasks, "Issue").map((item) => item.id)).toEqual(["ATM-3"]);
  });

  test("derives priority filter options in stable priority order", () => {
    const implicitPriorityTask = task({ id: "ATM-4", title: "Implicit default task" });
    delete implicitPriorityTask.priority;

    const options = taskPriorityFilterOptions([
      task({ id: "ATM-1", title: "Critical task", priority: "P0" }),
      task({ id: "ATM-2", title: "Default task", priority: "P2" }),
      task({ id: "ATM-3", title: "Medium task", priority: "P1" }),
      implicitPriorityTask
    ]);

    expect(options.emptyLabel).toBeNull();
    expect(options.options).toEqual([
      { value: "P0", label: "P0", count: 1 },
      { value: "P1", label: "P1", count: 1 },
      { value: "P2", label: "P2", count: 2 }
    ]);
  });

  test("filters board tasks by selected priority without changing task search scope", () => {
    const implicitPriorityTask = task({ id: "ATM-4", title: "Implicit default task" });
    delete implicitPriorityTask.priority;

    const tasks = [
      task({ id: "ATM-1", title: "Critical task", priority: "P0" }),
      task({ id: "ATM-2", title: "Medium task", priority: "P1" }),
      task({ id: "ATM-3", title: "Default task", priority: "P2" }),
      implicitPriorityTask
    ];

    expect(filterTasksByPriority(tasks, "").map((item) => item.id)).toEqual(["ATM-1", "ATM-2", "ATM-3", "ATM-4"]);
    expect(filterTasksByPriority(tasks, "P0").map((item) => item.id)).toEqual(["ATM-1"]);
    expect(filterTasksByPriority(tasks, "P2").map((item) => item.id)).toEqual(["ATM-3", "ATM-4"]);
  });

  test("derives broad status group filter options in board order", () => {
    const options = taskStatusGroupFilterOptions([
      task({ id: "ATM-1", title: "Proposed task", status: "proposed" }),
      task({ id: "ATM-2", title: "Confirmed task", status: "confirmed" }),
      task({ id: "ATM-3", title: "Progress task", status: "in_progress" }),
      task({ id: "ATM-4", title: "Review task", status: "review_needed" }),
      task({ id: "ATM-5", title: "Done task", status: "done" }),
      task({ id: "ATM-6", title: "Cancelled task", status: "cancelled" })
    ]);

    expect(options.emptyLabel).toBeNull();
    expect(options.options).toEqual([
      { value: "backlog-ready", label: "Backlog/Ready", count: 2 },
      { value: "in-progress", label: "In Progress", count: 1 },
      { value: "blocked-review", label: "Blocked/Review", count: 1 },
      { value: "done", label: "Done", count: 1 }
    ]);
  });

  test("filters board tasks by selected broad status group", () => {
    const tasks = [
      task({ id: "ATM-1", title: "Ready task", status: "confirmed" }),
      task({ id: "ATM-2", title: "Progress task", status: "in_progress" }),
      task({ id: "ATM-3", title: "Blocked task", status: "blocked" }),
      task({ id: "ATM-4", title: "Review task", status: "review_needed" }),
      task({ id: "ATM-5", title: "Done task", status: "done" })
    ];

    expect(filterTasksByStatusGroup(tasks, "").map((item) => item.id)).toEqual(["ATM-1", "ATM-2", "ATM-3", "ATM-4", "ATM-5"]);
    expect(filterTasksByStatusGroup(tasks, "blocked-review").map((item) => item.id)).toEqual(["ATM-3", "ATM-4"]);
    expect(filterTasksByStatusGroup(tasks, "done").map((item) => item.id)).toEqual(["ATM-5"]);
    expect(filterTasksByStatusGroup(tasks, "missing").map((item) => item.id)).toEqual(["ATM-1", "ATM-2", "ATM-3", "ATM-4", "ATM-5"]);
  });

  test("derives detailed status options from the selected broad status group", () => {
    const tasks = [
      task({ id: "ATM-1", title: "Proposed task", status: "proposed" }),
      task({ id: "ATM-2", title: "Confirmed task", status: "confirmed" }),
      task({ id: "ATM-3", title: "Progress task", status: "in_progress" }),
      task({ id: "ATM-4", title: "Blocked task", status: "blocked" }),
      task({ id: "ATM-5", title: "Review task", status: "review_needed" }),
      task({ id: "ATM-6", title: "Done task", status: "done" })
    ];

    expect(taskDetailedStatusFilterOptions(tasks, "blocked-review").options).toEqual([
      { value: "blocked", label: "blocked", count: 1 },
      { value: "review_needed", label: "review needed", count: 1 }
    ]);
    expect(taskDetailedStatusFilterOptions(tasks, "in-progress").options).toEqual([
      { value: "in_progress", label: "in progress", count: 1 }
    ]);
  });

  test("derives detailed status options in board order when no broad status group is selected", () => {
    const options = taskDetailedStatusFilterOptions([
      task({ id: "ATM-1", title: "Proposed task", status: "proposed" }),
      task({ id: "ATM-2", title: "Progress task", status: "in_progress" }),
      task({ id: "ATM-3", title: "Done task", status: "done" })
    ], "");

    expect(options.emptyLabel).toBeNull();
    expect(options.options).toEqual([
      { value: "proposed", label: "proposed", count: 1 },
      { value: "confirmed", label: "confirmed", count: 0 },
      { value: "assigning", label: "assigning", count: 0 },
      { value: "in_progress", label: "in progress", count: 1 },
      { value: "blocked", label: "blocked", count: 0 },
      { value: "review_needed", label: "review needed", count: 0 },
      { value: "done", label: "done", count: 1 }
    ]);
  });

  test("filters board tasks by selected detailed status", () => {
    const tasks = [
      task({ id: "ATM-1", title: "Blocked task", status: "blocked" }),
      task({ id: "ATM-2", title: "Review task", status: "review_needed" }),
      task({ id: "ATM-3", title: "Done task", status: "done" })
    ];

    expect(filterTasksByDetailedStatus(tasks, "").map((item) => item.id)).toEqual(["ATM-1", "ATM-2", "ATM-3"]);
    expect(filterTasksByDetailedStatus(tasks, "review_needed").map((item) => item.id)).toEqual(["ATM-2"]);
    expect(filterTasksByDetailedStatus(tasks, "missing")).toEqual([]);
  });

  test("applies broad status group and detailed status as one board dataset filter", () => {
    const tasks = [
      task({ id: "ATM-1", title: "Ready task", status: "confirmed" }),
      task({ id: "ATM-2", title: "Blocked task", status: "blocked" }),
      task({ id: "ATM-3", title: "Review task", status: "review_needed" }),
      task({ id: "ATM-4", title: "Done task", status: "done" })
    ];

    expect(filterTasksByStatusFilters(tasks, "", "").map((item) => item.id)).toEqual(["ATM-1", "ATM-2", "ATM-3", "ATM-4"]);
    expect(filterTasksByStatusFilters(tasks, "blocked-review", "").map((item) => item.id)).toEqual(["ATM-2", "ATM-3"]);
    expect(filterTasksByStatusFilters(tasks, "", "review_needed").map((item) => item.id)).toEqual(["ATM-3"]);
    expect(filterTasksByStatusFilters(tasks, "blocked-review", "review_needed").map((item) => item.id)).toEqual(["ATM-3"]);
    expect(filterTasksByStatusFilters(tasks, "backlog-ready", "review_needed")).toEqual([]);
    expect(filterTasksByStatusFilters(tasks, "blocked-review", "missing")).toEqual([]);
  });

  test("applies member, status, detailed status, priority, and source as one board filter", () => {
    const people: OwnerMapping[] = [
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-bob", ownerName: "Bob", active: true })
    ];
    const tasks = [
      task({ id: "ATM-1", title: "Alice blocked issue", assignee: "Alice", status: "blocked", priority: "P0", githubRef: "acme/tasks#1" }),
      task({ id: "ATM-2", title: "Alice review issue", assignee: "Alice", status: "review_needed", priority: "P0", githubRef: "acme/tasks#2" }),
      task({ id: "ATM-3", title: "Alice blocked manual", assignee: "Alice", status: "blocked", priority: "P0" }),
      task({ id: "ATM-4", title: "Bob blocked issue", assignee: "Bob", status: "blocked", priority: "P0", githubRef: "acme/tasks#4" }),
      task({ id: "ATM-5", title: "Alice blocked low priority", assignee: "Alice", status: "blocked", priority: "P2", githubRef: "acme/tasks#5" })
    ];

    expect(filterTaskBoardTasks(tasks, people, {
      detailedStatus: "blocked",
      memberId: "owner-alice",
      priority: "P0",
      source: "Issue",
      statusGroup: "blocked-review"
    }).map((item) => item.id)).toEqual(["ATM-1"]);
  });

  test("keeps combined board filters strict across member, status group, priority, and source", () => {
    const people: OwnerMapping[] = [
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-bob", ownerName: "Bob", active: true })
    ];
    const tasks = [
      task({ id: "ATM-1", title: "Target issue", assignee: "Alice", status: "blocked", priority: "P0", githubRef: "acme/tasks#1" }),
      task({ id: "ATM-2", title: "Wrong member", assignee: "Bob", status: "blocked", priority: "P0", githubRef: "acme/tasks#2" }),
      task({ id: "ATM-3", title: "Wrong status group", assignee: "Alice", status: "in_progress", priority: "P0", githubRef: "acme/tasks#3" }),
      task({ id: "ATM-4", title: "Wrong priority", assignee: "Alice", status: "blocked", priority: "P1", githubRef: "acme/tasks#4" }),
      task({ id: "ATM-5", title: "Wrong source", assignee: "Alice", status: "blocked", priority: "P0" }),
      task({ id: "ATM-6", title: "Review issue also in group", assignee: "Alice", status: "review_needed", priority: "P0", githubRef: "acme/tasks#6" })
    ];

    expect(filterTaskBoardTasks(tasks, people, {
      memberId: "owner-alice",
      priority: "P0",
      source: "Issue",
      statusGroup: "blocked-review"
    }).map((item) => item.id)).toEqual(["ATM-1", "ATM-6"]);

    expect(filterTaskBoardTasks(tasks, people, {
      detailedStatus: "blocked",
      memberId: "owner-alice",
      priority: "P0",
      source: "Issue",
      statusGroup: "blocked-review"
    }).map((item) => item.id)).toEqual(["ATM-1"]);

    expect(filterTaskBoardTasks(tasks, people, {
      detailedStatus: "blocked",
      memberId: "owner-bob",
      priority: "P0",
      source: "Issue",
      statusGroup: "blocked-review"
    }).map((item) => item.id)).toEqual(["ATM-2"]);
  });

  test("applies combined board filters after title and ID search has defined the board dataset", () => {
    const people: OwnerMapping[] = [
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-bob", ownerName: "Bob", active: true })
    ];
    const tasks = [
      task({ id: "ATM-101", title: "Deploy board filter", assignee: "Alice", status: "blocked", priority: "P0", githubRef: "acme/tasks#101" }),
      task({ id: "ATM-102", title: "Deploy manual fallback", assignee: "Alice", status: "blocked", priority: "P0" }),
      task({ id: "ATM-201", title: "Source-only match", assignee: "Alice", status: "blocked", priority: "P0", githubRef: "acme/deploy#201" }),
      task({ id: "ATM-301", title: "Deploy wrong owner", assignee: "Bob", status: "blocked", priority: "P0", githubRef: "acme/tasks#301" })
    ];
    const boardBaseTasks = filterTasks(tasks, "deploy");

    expect(filterTaskBoardTasks(boardBaseTasks, people, {
      memberId: "owner-alice",
      priority: "P0",
      source: "Issue",
      statusGroup: "blocked-review"
    }).map((item) => item.id)).toEqual(["ATM-101"]);
  });

  test("keeps detailed status filters dependent on compatible broad status groups", () => {
    expect(taskStatusFilterDependency("blocked-review", "review_needed")).toMatchObject({
      isDetailedStatusFilterDisabled: false,
      shouldResetDetailedStatus: false
    });
    expect(taskStatusFilterDependency("backlog-ready", "review_needed")).toMatchObject({
      isDetailedStatusFilterDisabled: false,
      shouldResetDetailedStatus: true
    });
    expect(taskStatusFilterDependency("", "review_needed")).toMatchObject({
      isDetailedStatusFilterDisabled: false,
      shouldResetDetailedStatus: false
    });
  });

  test("disables redundant detailed status filters for single-status groups", () => {
    expect(taskStatusFilterDependency("in-progress", "")).toMatchObject({
      isDetailedStatusFilterDisabled: true,
      shouldResetDetailedStatus: false
    });
    expect(taskStatusFilterDependency("in-progress", "in_progress")).toMatchObject({
      isDetailedStatusFilterDisabled: true,
      shouldResetDetailedStatus: true
    });
    expect(taskStatusFilterDependency("done", "blocked")).toMatchObject({
      isDetailedStatusFilterDisabled: true,
      shouldResetDetailedStatus: true
    });
  });
});

describe("task status groups", () => {
  test("defines the member board status order and detailed statuses", () => {
    expect(taskStatusGroups.map((group) => group.id)).toEqual([
      "backlog-ready",
      "in-progress",
      "blocked-review",
      "done"
    ]);
    expect(taskStatusGroups.map((group) => [...group.statuses])).toEqual([
      ["proposed", "confirmed", "assigning"],
      ["in_progress"],
      ["blocked", "review_needed"],
      ["done"]
    ]);
    expect(taskStatusGroups.some((group) => group.statuses.includes("cancelled"))).toBe(false);
  });

  test("maps detailed statuses to their board group", () => {
    expect(taskStatusGroupForId("backlog-ready")?.label).toBe("Backlog/Ready");
    expect(taskStatusGroupForStatus("proposed")?.id).toBe("backlog-ready");
    expect(taskStatusGroupForStatus("confirmed")?.id).toBe("backlog-ready");
    expect(taskStatusGroupForStatus("assigning")?.id).toBe("backlog-ready");
    expect(taskStatusGroupForStatus("in_progress")?.id).toBe("in-progress");
    expect(taskStatusGroupForStatus("blocked")?.id).toBe("blocked-review");
    expect(taskStatusGroupForStatus("review_needed")?.id).toBe("blocked-review");
    expect(taskStatusGroupForStatus("done")?.id).toBe("done");
    expect(taskStatusGroupForStatus("cancelled")).toBeNull();
  });

  test("defaults new board tasks into a sensible member column and status group", () => {
    const columns = taskMemberColumns([
      task({ id: "ATM-1", title: "Alice ready", assignee: "Alice", status: "confirmed" }),
      task({ id: "ATM-2", title: "Bob blocked", assignee: "Bob", status: "blocked" })
    ], [
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-bob", ownerName: "Bob", active: true })
    ]);

    expect(taskCreateBoardContext({ columns })).toEqual({
      assignee: "",
      memberLabel: "Unassigned",
      memberId: null,
      status: "confirmed",
      statusGroupId: null,
      statusGroupLabel: "Backlog/Ready"
    });
    expect(taskCreateBoardContext({ columns, memberId: "owner-bob" })).toEqual({
      assignee: "Bob",
      memberLabel: "Bob",
      memberId: "owner-bob",
      status: "confirmed",
      statusGroupId: null,
      statusGroupLabel: "Backlog/Ready"
    });
    expect(taskCreateBoardContext({ columns, memberId: unassignedMemberId, statusGroupFilter: "in-progress" })).toEqual({
      assignee: "",
      memberLabel: "Unassigned",
      memberId: unassignedMemberId,
      status: "in_progress",
      statusGroupId: "in-progress",
      statusGroupLabel: "In Progress"
    });
    expect(taskCreateBoardContext({ columns, memberId: "owner-bob", statusGroupFilter: "blocked-review" })).toEqual({
      assignee: "Bob",
      memberLabel: "Bob",
      memberId: "owner-bob",
      status: "blocked",
      statusGroupId: "blocked-review",
      statusGroupLabel: "Blocked/Review"
    });
  });

  test("chooses initial detailed status from board filters without defaulting to cancelled", () => {
    expect(taskCreateDefaultStatus()).toBe("confirmed");
    expect(taskCreateDefaultStatus("backlog-ready")).toBe("confirmed");
    expect(taskCreateDefaultStatus("blocked-review")).toBe("blocked");
    expect(taskCreateDefaultStatus("done")).toBe("done");
    expect(taskCreateDefaultStatus("blocked-review", "review_needed")).toBe("review_needed");
    expect(taskCreateDefaultStatus("backlog-ready", "cancelled")).toBe("confirmed");
  });

  test("validates board-native task creation titles before posting", () => {
    expect(taskCreateTitleValidationMessage("")).toBe("Task title is required.");
    expect(taskCreateTitleValidationMessage("   ")).toBe("Task title is required.");
    expect(taskCreateTitleValidationMessage("Ship board creation states")).toBeNull();
  });

  test("builds board drop updates from member and status group targets", () => {
    expect(taskBoardDropUpdate({
      assignee: "Bob",
      currentAssignee: "Alice",
      currentStatus: "confirmed",
      selectedStatus: "blocked",
      statusGroupId: "blocked-review"
    })).toEqual({
      assignee: "Bob",
      status: "blocked",
      changed: true
    });

    expect(taskBoardDropUpdate({
      assignee: "Alice",
      currentAssignee: "Alice",
      currentStatus: "confirmed",
      statusGroupId: "in-progress"
    })).toEqual({
      assignee: "Alice",
      status: "in_progress",
      changed: true
    });

    expect(taskBoardDropUpdate({
      assignee: "Alice",
      currentAssignee: "Alice",
      currentStatus: "confirmed",
      selectedStatus: "cancelled",
      statusGroupId: "backlog-ready"
    })).toBeNull();

    expect(taskBoardDropUpdate({
      assignee: null,
      currentAssignee: "Alice",
      currentStatus: "in_progress",
      statusGroupId: "done"
    })).toEqual({
      assignee: null,
      status: "done",
      changed: true
    });

    expect(taskBoardDropUpdate({
      assignee: "Alice",
      currentAssignee: "Alice",
      currentStatus: "blocked",
      selectedStatus: " blocked ",
      statusGroupId: "blocked-review"
    })).toEqual({
      assignee: "Alice",
      status: "blocked",
      changed: false
    });

    expect(taskBoardDropUpdate({
      assignee: "Alice",
      currentAssignee: "Alice",
      currentStatus: "blocked",
      selectedStatus: null,
      statusGroupId: "blocked-review"
    })).toBeNull();
  });

  test("uses the destination status section for single-status board drops", () => {
    expect(taskStatusGroupRequiresDetailedStatusChoice("in-progress")).toBe(false);
    expect(taskStatusGroupRequiresDetailedStatusChoice("done")).toBe(false);
    expect(taskStatusGroupRequiresDetailedStatusChoice("backlog-ready")).toBe(true);
    expect(taskStatusGroupRequiresDetailedStatusChoice("blocked-review")).toBe(true);

    expect(taskBoardDropUpdate({
      assignee: "Alice",
      currentAssignee: "Alice",
      currentStatus: "blocked",
      selectedStatus: "blocked",
      statusGroupId: "in-progress"
    })).toEqual({
      assignee: "Alice",
      status: "in_progress",
      changed: true
    });
  });

  test("persists single-status board drops directly without a selected detailed status", async () => {
    const update = taskBoardDropUpdate({
      assignee: "Bob",
      currentAssignee: "Alice",
      currentStatus: "confirmed",
      selectedStatus: null,
      statusGroupId: "in-progress"
    });
    const persistedTask = task({ id: "ATM-1", title: "Ready task", assignee: "Bob", status: "in_progress" });
    const calls: Array<{ path: string; options?: RequestInit }> = [];
    const api: ApiClient = async <T>(path: string, options?: RequestInit): Promise<T> => {
      calls.push(options ? { path, options } : { path });
      return { task: persistedTask } as T;
    };

    expect(update).toEqual({
      assignee: "Bob",
      status: "in_progress",
      changed: true
    });
    await expect(persistTaskBoardDrop(api, "ATM-1", update!, true)).resolves.toBe(persistedTask);
    expect(JSON.parse(String(calls[0]?.options?.body))).toEqual({
      assignee: "Bob",
      status: "in_progress"
    });
  });

  test("treats empty and null assignees as the same Unassigned drop target", () => {
    expect(taskBoardDropUpdate({
      assignee: null,
      currentAssignee: "",
      currentStatus: "done",
      statusGroupId: "done"
    })).toEqual({
      assignee: null,
      status: "done",
      changed: false
    });
  });

  test("includes destination member assignee in owner board drop patches", () => {
    expect(taskBoardDropPatch({
      assignee: "Bob",
      status: "in_progress",
      changed: true
    }, true)).toEqual({
      assignee: "Bob",
      status: "in_progress"
    });

    expect(taskBoardDropPatch({
      assignee: null,
      status: "done",
      changed: true
    }, true)).toEqual({
      assignee: null,
      status: "done"
    });
  });

  test("keeps member board drop patches scoped to status changes", () => {
    expect(taskBoardDropPatch({
      assignee: "Bob",
      status: "blocked",
      changed: true
    }, false)).toEqual({
      status: "blocked"
    });
  });

  test("persists board drops through the task patch API", async () => {
    const persistedTask = task({ id: "ATM-1", title: "Ready task", assignee: "Bob", status: "in_progress" });
    const calls: Array<{ path: string; options?: RequestInit }> = [];
    const api: ApiClient = async <T>(path: string, options?: RequestInit): Promise<T> => {
      calls.push(options ? { path, options } : { path });
      return { task: persistedTask } as T;
    };

    await expect(persistTaskBoardDrop(api, "ATM-1", {
      assignee: "Bob",
      status: "in_progress",
      changed: true
    }, true)).resolves.toBe(persistedTask);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/api/tasks/ATM-1");
    expect(calls[0]?.options?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.options?.body))).toEqual({
      assignee: "Bob",
      status: "in_progress"
    });
  });

  test("refreshes local board task state with the persisted task payload", () => {
    const currentTasks = [
      task({ id: "ATM-1", title: "Ready task", assignee: "Alice", status: "confirmed" }),
      task({ id: "ATM-2", title: "Other task", assignee: "Bob", status: "blocked" })
    ];
    const persistedTask = task({
      id: "ATM-1",
      title: "Ready task",
      assignee: "Bob",
      status: "in_progress",
      updatedAt: "2026-05-08T01:00:00.000Z"
    });

    const refreshedTasks = replaceTaskInList(currentTasks, persistedTask);
    const columns = taskMemberColumns(refreshedTasks, [
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-bob", ownerName: "Bob", active: true })
    ]);

    expect(refreshedTasks).not.toBe(currentTasks);
    expect(columns.find((column) => column.label === "Alice")?.tasks).toEqual([]);
    expect(columns.find((column) => column.label === "Bob")?.tasks.map((item) => item.id)).toEqual(["ATM-1", "ATM-2"]);
    expect(taskStatusGroupSections(columns.find((column) => column.label === "Bob")?.tasks ?? [])
      .find((section) => section.id === "in-progress")?.tasks.map((item) => item.id)).toEqual(["ATM-1"]);
  });

  test("reconciles stale reloaded board state with the persisted drop payload", () => {
    const staleReloadedTasks = [
      task({ id: "ATM-1", title: "Ready task", assignee: "Alice", status: "confirmed" }),
      task({ id: "ATM-2", title: "Other task", assignee: "Bob", status: "blocked" })
    ];
    const persistedTask = task({
      id: "ATM-1",
      title: "Ready task",
      assignee: "Bob",
      status: "in_progress",
      updatedAt: "2026-05-08T01:00:00.000Z"
    });

    const reconciledTasks = reconcileTaskBoardDropState(staleReloadedTasks, persistedTask);
    const columns = taskMemberColumns(reconciledTasks, [
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-bob", ownerName: "Bob", active: true })
    ]);

    expect(columns.find((column) => column.label === "Alice")?.tasks).toEqual([]);
    expect(columns.find((column) => column.label === "Bob")?.tasks.map((item) => item.id)).toEqual(["ATM-1", "ATM-2"]);
    expect(taskStatusGroupSections(columns.find((column) => column.label === "Bob")?.tasks ?? [])
      .find((section) => section.id === "in-progress")?.tasks.map((item) => item.id)).toEqual(["ATM-1"]);
  });

  test("keeps the persisted dropped task visible when reload omits it", () => {
    const persistedTask = task({
      id: "ATM-1",
      title: "Ready task",
      assignee: "Bob",
      status: "in_progress"
    });

    expect(reconcileTaskBoardDropState([], persistedTask)).toEqual([persistedTask]);
  });

  test("inserts a newly created board task into its member status section", () => {
    const people = [
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-bob", ownerName: "Bob", active: true })
    ];
    const currentTasks = [
      task({ id: "ATM-1", title: "Ready task", assignee: "Alice", status: "confirmed" })
    ];
    const createdTask = task({
      id: "ATM-2",
      title: "New progress task",
      assignee: "Bob",
      status: "in_progress",
      priority: "P1"
    });
    const refreshedTasks = insertTaskIntoBoardState(currentTasks, createdTask);
    const columns = taskMemberColumns(refreshedTasks, people);
    const bobBoardTasks = filterTaskBoardTasks(refreshedTasks, people, { memberId: "owner-bob" });

    expect(refreshedTasks).toEqual([...currentTasks, createdTask]);
    expect(bobBoardTasks.map((item) => item.id)).toEqual(["ATM-2"]);
    expect(columns.find((column) => column.label === "Bob")?.tasks.map((item) => item.id)).toEqual(["ATM-2"]);
    expect(taskStatusGroupSections(columns.find((column) => column.label === "Bob")?.tasks ?? [])
      .find((section) => section.id === "in-progress")?.tasks.map((item) => item.id)).toEqual(["ATM-2"]);
  });

  test("inserts newly created unassigned board tasks into the Unassigned column", () => {
    const createdTask = task({
      id: "ATM-2",
      title: "New unassigned task",
      assignee: null,
      status: "blocked"
    });
    const refreshedTasks = insertTaskIntoBoardState([], createdTask);
    const columns = taskMemberColumns(refreshedTasks, [
      owner({ id: "owner-alice", ownerName: "Alice", active: true })
    ]);

    expect(columns.find((column) => column.id === unassignedMemberId)?.tasks.map((item) => item.id)).toEqual(["ATM-2"]);
    expect(taskStatusGroupSections(columns.find((column) => column.id === unassignedMemberId)?.tasks ?? [])
      .find((section) => section.id === "blocked-review")?.tasks.map((item) => item.id)).toEqual(["ATM-2"]);
  });

  test("keeps local board task state unchanged when persisted task is not present", () => {
    const currentTasks = [
      task({ id: "ATM-1", title: "Ready task", assignee: "Alice", status: "confirmed" })
    ];
    const refreshedTasks = replaceTaskInList(currentTasks, task({ id: "ATM-404", title: "Missing task" }));

    expect(refreshedTasks).toBe(currentTasks);
  });

  test("builds every grouped board section for a member column", () => {
    const sections = taskStatusGroupSections([
      task({ id: "ATM-1", title: "Ready task", status: "confirmed" }),
      task({ id: "ATM-2", title: "Progress task", status: "in_progress" }),
      task({ id: "ATM-3", title: "Review task", status: "review_needed" }),
      task({ id: "ATM-4", title: "Cancelled task", status: "cancelled" })
    ]);

    expect(sections.map((section) => section.label)).toEqual([
      "Backlog/Ready",
      "In Progress",
      "Blocked/Review",
      "Done"
    ]);
    expect(sections.map((section) => section.tasks.map((item) => item.id))).toEqual([
      ["ATM-1"],
      ["ATM-2"],
      ["ATM-3"],
      []
    ]);
  });

  test("keeps each member column task in its matching status section", () => {
    const people: OwnerMapping[] = [
      owner({ id: "owner-alice", ownerName: "Alice", active: true }),
      owner({ id: "owner-bob", ownerName: "Bob", active: true })
    ];
    const columns = taskMemberColumns([
      task({ id: "ATM-1", title: "Alice ready", assignee: "Alice", status: "confirmed" }),
      task({ id: "ATM-2", title: "Alice blocked", assignee: "Alice", status: "blocked" }),
      task({ id: "ATM-3", title: "Bob progress", assignee: "Bob", status: "in_progress" }),
      task({ id: "ATM-4", title: "Unassigned done", assignee: "", status: "done" }),
      task({ id: "ATM-5", title: "Bob cancelled", assignee: "Bob", status: "cancelled" })
    ], people);

    const groupedByColumn = Object.fromEntries(
      columns.map((column) => [
        column.label,
        Object.fromEntries(
          taskStatusGroupSections(column.tasks).map((section) => [
            section.id,
            section.tasks.map((item) => item.id)
          ])
        )
      ])
    );

    expect(groupedByColumn).toEqual({
      Alice: {
        "backlog-ready": ["ATM-1"],
        "in-progress": [],
        "blocked-review": ["ATM-2"],
        done: []
      },
      Bob: {
        "backlog-ready": [],
        "in-progress": ["ATM-3"],
        "blocked-review": [],
        done: []
      },
      Unassigned: {
        "backlog-ready": [],
        "in-progress": [],
        "blocked-review": [],
        done: ["ATM-4"]
      }
    });
  });

  test("toggles collapsed status groups independently per member column", () => {
    const aliceBacklog = taskStatusGroupCollapseKey("owner-alice", "backlog-ready");
    const bobBacklog = taskStatusGroupCollapseKey("owner-bob", "backlog-ready");
    const aliceProgress = taskStatusGroupCollapseKey("owner-alice", "in-progress");

    const afterAliceBacklog = toggleTaskStatusGroupCollapse(new Set(), "owner-alice", "backlog-ready");
    expect([...afterAliceBacklog]).toEqual([aliceBacklog]);
    expect(afterAliceBacklog.has(bobBacklog)).toBe(false);

    const afterBobBacklog = toggleTaskStatusGroupCollapse(afterAliceBacklog, "owner-bob", "backlog-ready");
    expect([...afterBobBacklog].sort()).toEqual([aliceBacklog, bobBacklog].sort());

    const afterAliceProgress = toggleTaskStatusGroupCollapse(afterBobBacklog, "owner-alice", "in-progress");
    expect([...afterAliceProgress].sort()).toEqual([aliceBacklog, aliceProgress, bobBacklog].sort());

    const afterAliceBacklogExpanded = toggleTaskStatusGroupCollapse(afterAliceProgress, "owner-alice", "backlog-ready");
    expect([...afterAliceBacklogExpanded].sort()).toEqual([aliceProgress, bobBacklog].sort());
  });
});

type TaskOverrides = Partial<Omit<Task, "priority">> & {
  priority?: Task["priority"] | undefined;
};

function task(overrides: TaskOverrides): Task {
  const { priority, ...rest } = overrides;
  const item: Task = {
    id: "ATM-0",
    title: "Untitled task",
    description: "",
    status: "confirmed",
    priority: "P2",
    category: "general",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...rest
  };
  if ("priority" in overrides) {
    if (priority === undefined) {
      delete item.priority;
    } else {
      item.priority = priority;
    }
  }
  return item;
}

function owner(overrides: Partial<OwnerMapping>): OwnerMapping {
  return {
    id: "owner-0",
    ownerName: "Owner",
    slackUserId: "U_OWNER",
    aliases: [],
    active: true,
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides
  };
}
