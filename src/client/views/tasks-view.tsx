import { Activity, AlertTriangle, CheckCircle2, CircleDot, Filter, Flag, GitBranch, Tag, TextCursorInput, UserRound, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { MetricCard, OwnerOptions, PriorityLine, ResultLine } from "../components/common";
import { MemberKanbanColumn, taskSourceIcon } from "../components/member-kanban-column";
import { errorMessage, relativeTime } from "../lib/format";
import {
  activityLabel,
  categories,
  filterTaskMemberColumns,
  filterTaskBoardTasks,
  filterTasks,
  filterTasksByStatusFilters,
  formatTaskStatus,
  focusTasks,
  priorities,
  priorityMetrics,
  persistTaskBoardDrop,
  statuses,
  taskBoardDropUpdate,
  taskCreateBoardContext,
  taskCreateTitleValidationMessage,
  taskDraft,
  taskMetrics,
  taskMemberColumns,
  taskMemberFilterOptions,
  taskDetailedStatusFilterOptions,
  taskPriorityFilterOptions,
  taskSource,
  taskSourceFilterOptions,
  taskStatusFilterDependency,
  taskStatusGroupCollapseKey,
  taskStatusGroupFilterOptions,
  taskStatusGroupForStatus,
  taskStatusGroupForId,
  taskStatusGroupRequiresDetailedStatusChoice,
  taskStatusGroups,
  toggleTaskStatusGroupCollapse,
  unassignedMemberId,
  type TaskCreateBoardContext
} from "../lib/tasks";
import type { ApiClient, OwnerMapping, ResultMessage, Task, Translator, View } from "../types";

type PendingStatusDrop = {
  assignee: string | null;
  currentAssignee: string | null;
  currentStatus: string;
  selectedStatus: string;
  statusGroupId: string;
  statusGroupLabel: string;
  statuses: readonly string[];
  targetMemberId: string;
  targetMemberLabel: string;
  taskId: string;
  taskTitle: string;
};

export function TaskWorkspace({
  api,
  isOwner,
  people,
  search,
  selectedMemberId,
  selectedTask,
  tasks,
  t,
  view,
  onCreateTask,
  onReloadTasks,
  onSelectTask,
  onTaskUpdated
}: {
  api: ApiClient;
  isOwner: boolean;
  people: OwnerMapping[];
  search: string;
  selectedMemberId: string | null;
  selectedTask: Task | null;
  tasks: Task[];
  t: Translator;
  view: View;
  onCreateTask: (event: FormEvent<HTMLFormElement>) => Promise<Task | null>;
  onReloadTasks: () => Promise<void>;
  onSelectTask: (id: string | null, memberId?: string | null) => void;
  onTaskUpdated: (task: Task) => void;
}) {
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [createContext, setCreateContext] = useState<TaskCreateBoardContext>({
    assignee: "",
    memberLabel: "Unassigned",
    memberId: null,
    status: "confirmed",
    statusGroupId: null,
    statusGroupLabel: "Backlog/Ready"
  });
  const [boardResult, setBoardResult] = useState<ResultMessage | null>(null);
  const [createResult, setCreateResult] = useState<ResultMessage | null>(null);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [isSavingBoardDrop, setIsSavingBoardDrop] = useState(false);
  const [pendingStatusDrop, setPendingStatusDrop] = useState<PendingStatusDrop | null>(null);
  const [memberFilterId, setMemberFilterId] = useState("");
  const [statusGroupFilter, setStatusGroupFilter] = useState("");
  const [detailedStatusFilter, setDetailedStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const matchingTasks = useMemo(() => filterTasks(tasks, search), [search, tasks]);
  const boardBaseTasks = useMemo(
    () => view === "tasks" ? matchingTasks.filter((task) => task.status !== "cancelled") : focusTasks(matchingTasks).slice(0, 8),
    [matchingTasks, view]
  );
  const statusFilteredTasks = useMemo(
    () => filterTasksByStatusFilters(boardBaseTasks, statusGroupFilter, detailedStatusFilter),
    [boardBaseTasks, detailedStatusFilter, statusGroupFilter]
  );
  const boardFilteredTasks = useMemo(
    () => filterTaskBoardTasks(boardBaseTasks, people, {
      detailedStatus: detailedStatusFilter,
      priority: priorityFilter,
      source: sourceFilter,
      statusGroup: statusGroupFilter
    }),
    [boardBaseTasks, detailedStatusFilter, people, priorityFilter, sourceFilter, statusGroupFilter]
  );
  const visibleTasks = useMemo(
    () => filterTaskBoardTasks(boardBaseTasks, people, {
      detailedStatus: detailedStatusFilter,
      memberId: memberFilterId,
      priority: priorityFilter,
      source: sourceFilter,
      statusGroup: statusGroupFilter
    }),
    [boardBaseTasks, detailedStatusFilter, memberFilterId, people, priorityFilter, sourceFilter, statusGroupFilter]
  );
  const memberColumns = useMemo(() => taskMemberColumns(visibleTasks, people), [people, visibleTasks]);
  const filteredMemberColumns = useMemo(() => filterTaskMemberColumns(memberColumns, memberFilterId), [memberColumns, memberFilterId]);
  const memberFilterOptions = useMemo(() => taskMemberFilterOptions(boardFilteredTasks, people), [boardFilteredTasks, people]);
  const statusGroupFilterOptions = useMemo(() => taskStatusGroupFilterOptions(boardBaseTasks), [boardBaseTasks]);
  const detailedStatusFilterOptions = useMemo(() => taskDetailedStatusFilterOptions(boardBaseTasks, statusGroupFilter), [boardBaseTasks, statusGroupFilter]);
  const statusFilterDependency = useMemo(
    () => taskStatusFilterDependency(statusGroupFilter, detailedStatusFilter),
    [detailedStatusFilter, statusGroupFilter]
  );
  const isDetailedStatusFilterDisabled = statusFilterDependency.isDetailedStatusFilterDisabled || !detailedStatusFilterOptions.options.length;
  const priorityFilterOptions = useMemo(() => taskPriorityFilterOptions(statusFilteredTasks), [statusFilteredTasks]);
  const sourceFilterOptions = useMemo(
    () => taskSourceFilterOptions(filterTaskBoardTasks(boardBaseTasks, people, {
      detailedStatus: detailedStatusFilter,
      priority: priorityFilter,
      statusGroup: statusGroupFilter
    })),
    [boardBaseTasks, detailedStatusFilter, people, priorityFilter, statusGroupFilter]
  );
  const visibleStatusGroups = useMemo(
    () => {
      const selectedStatusGroup = statusGroupFilter ? taskStatusGroupForId(statusGroupFilter) : null;
      const selectedDetailedStatusGroup = detailedStatusFilter ? taskStatusGroupForStatus(detailedStatusFilter) : null;
      return selectedStatusGroup ? [selectedStatusGroup] : selectedDetailedStatusGroup ? [selectedDetailedStatusGroup] : taskStatusGroups;
    },
    [detailedStatusFilter, statusGroupFilter]
  );
  const metrics = useMemo(() => taskMetrics(tasks), [tasks]);
  const priority = useMemo(() => priorityMetrics(tasks), [tasks]);
  const recentTasks = useMemo(
    () => [...tasks].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5),
    [tasks]
  );
  const dismissDetailPanel = useCallback(() => {
    onSelectTask(null, null);
  }, [onSelectTask]);
  const openColumnComposer = useCallback((assignee: string | null, memberId: string, statusGroupId?: string) => {
    setCreateContext(taskCreateBoardContext({
      columns: memberColumns,
      detailedStatusFilter,
      memberId,
      statusGroupFilter: statusGroupId ?? statusGroupFilter
    }));
    setCreateResult(null);
    setIsComposerOpen(true);
  }, [detailedStatusFilter, memberColumns, statusGroupFilter]);
  const cancelComposer = useCallback(() => {
    if (isCreatingTask) return;
    setCreateResult(null);
    setIsComposerOpen(false);
  }, [isCreatingTask]);
  const handleStatusGroupFilterChange = useCallback((value: string) => {
    const selectedGroup = value ? taskStatusGroupForId(value) : null;
    setStatusGroupFilter(value);
    setDetailedStatusFilter((currentDetailedStatus) => {
      if (!currentDetailedStatus || !selectedGroup) return currentDetailedStatus;
      if (selectedGroup.statuses.length <= 1) return "";
      return selectedGroup.statuses.includes(currentDetailedStatus) ? currentDetailedStatus : "";
    });
  }, []);
  const handleDetailedStatusFilterChange = useCallback((value: string) => {
    setDetailedStatusFilter(value);
    if (!value) return;

    const matchingGroup = taskStatusGroupForStatus(value);
    if (matchingGroup) {
      setStatusGroupFilter(matchingGroup.id);
    }
  }, []);
  const handlePriorityFilterChange = useCallback((value: string) => {
    setPriorityFilter(priorities.includes(value as (typeof priorities)[number]) ? value : "");
  }, []);
  const handleCreateTask = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isCreatingTask) return;

    const form = event.currentTarget;
    const titleField = form.elements.namedItem("title") as HTMLInputElement | null;
    const title = titleField?.value.trim() ?? "";
    const validationMessage = taskCreateTitleValidationMessage(title);
    if (validationMessage) {
      setCreateResult({ text: validationMessage, ok: false });
      titleField?.focus();
      return;
    }

    setCreateResult(null);
    setIsCreatingTask(true);

    try {
      const task = await onCreateTask(event);
      if (!task) {
        setCreateResult({ text: "Task could not be created.", ok: false });
        return;
      }

      const createdMemberId = task.assignee
        ? people.find((owner) => owner.active && owner.ownerName === task.assignee)?.id ?? createContext.memberId
        : unassignedMemberId;
      setCreateResult(null);
      setIsComposerOpen(false);
      onSelectTask(task.id, createdMemberId);
    } catch (error) {
      setCreateResult({ text: errorMessage(error), ok: false });
    } finally {
      setIsCreatingTask(false);
    }
  }, [createContext.memberId, isCreatingTask, onCreateTask, onSelectTask, people]);

  useEffect(() => {
    if (memberFilterId && !memberFilterOptions.options.some((option) => option.value === memberFilterId)) {
      setMemberFilterId("");
    }
  }, [memberFilterId, memberFilterOptions.options]);

  useEffect(() => {
    if (statusGroupFilter && !statusGroupFilterOptions.options.some((option) => option.value === statusGroupFilter)) {
      setStatusGroupFilter("");
    }
  }, [statusGroupFilter, statusGroupFilterOptions.options]);

  useEffect(() => {
    if (
      detailedStatusFilter &&
      (
        statusFilterDependency.shouldResetDetailedStatus ||
        !detailedStatusFilterOptions.options.some((option) => option.value === detailedStatusFilter)
      )
    ) {
      setDetailedStatusFilter("");
    }
  }, [detailedStatusFilter, detailedStatusFilterOptions.options, statusFilterDependency.shouldResetDetailedStatus]);

  useEffect(() => {
    if (priorityFilter && !priorityFilterOptions.options.some((option) => option.value === priorityFilter)) {
      setPriorityFilter("");
    }
  }, [priorityFilter, priorityFilterOptions.options]);

  useEffect(() => {
    if (sourceFilter && !sourceFilterOptions.options.some((option) => option.value === sourceFilter)) {
      setSourceFilter("");
    }
  }, [sourceFilter, sourceFilterOptions.options]);

  const saveBoardDrop = useCallback(async (drop: {
    assignee: string | null;
    currentAssignee: string | null;
    currentStatus: string;
    selectedStatus: string | null;
    statusGroupId: string;
    targetMemberId: string;
    taskId: string;
  }) => {
    const update = taskBoardDropUpdate({
      assignee: drop.assignee,
      currentAssignee: drop.currentAssignee,
      currentStatus: drop.currentStatus,
      selectedStatus: drop.selectedStatus,
      statusGroupId: drop.statusGroupId
    });
    if (!update?.changed) return true;

    try {
      setBoardResult(null);
      setIsSavingBoardDrop(true);
      const persistedTask = await persistTaskBoardDrop(api, drop.taskId, update, isOwner);
      onTaskUpdated(persistedTask);
      await onReloadTasks();
      onTaskUpdated(persistedTask);
      onSelectTask(persistedTask.id, drop.targetMemberId);
      return true;
    } catch (error) {
      setBoardResult({ text: errorMessage(error), ok: false });
      return false;
    } finally {
      setIsSavingBoardDrop(false);
    }
  }, [api, isOwner, onReloadTasks, onSelectTask, onTaskUpdated]);

  const handleTaskDrop = useCallback(async (taskId: string, targetMemberId: string, targetStatusGroupId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    const column = memberColumns.find((item) => item.id === targetMemberId);
    const statusGroup = taskStatusGroupForId(targetStatusGroupId);
    if (!task || !column || !statusGroup) return;
    if (!isOwner && column.assignee !== task.assignee) return;

    const defaultStatus = statusGroup.statuses.includes(task.status) ? task.status : statusGroup.statuses[0] ?? "";
    if (taskStatusGroupRequiresDetailedStatusChoice(statusGroup.id)) {
      setBoardResult(null);
      setPendingStatusDrop({
        assignee: column.assignee,
        currentAssignee: task.assignee ?? null,
        currentStatus: task.status,
        selectedStatus: defaultStatus,
        statusGroupId: statusGroup.id,
        statusGroupLabel: statusGroup.label,
        statuses: statusGroup.statuses,
        targetMemberId,
        targetMemberLabel: column.label,
        taskId: task.id,
        taskTitle: task.title
      });
      return;
    }

    await saveBoardDrop({
      assignee: column.assignee,
      currentAssignee: task.assignee ?? null,
      currentStatus: task.status,
      selectedStatus: defaultStatus,
      statusGroupId: statusGroup.id,
      targetMemberId,
      taskId: task.id
    });
  }, [isOwner, memberColumns, saveBoardDrop, tasks]);

  const confirmPendingStatusDrop = useCallback(async () => {
    if (!pendingStatusDrop || isSavingBoardDrop) return;
    const isComplete = await saveBoardDrop(pendingStatusDrop);
    if (isComplete) {
      setPendingStatusDrop(null);
    }
  }, [isSavingBoardDrop, pendingStatusDrop, saveBoardDrop]);

  const cancelPendingStatusDrop = useCallback(() => {
    if (isSavingBoardDrop) return;
    setPendingStatusDrop(null);
  }, [isSavingBoardDrop]);

  useEffect(() => {
    if (!pendingStatusDrop) return;
    if (!tasks.some((task) => task.id === pendingStatusDrop.taskId)) {
      setPendingStatusDrop(null);
    }
  }, [pendingStatusDrop, tasks]);

  useEffect(() => {
    if (!pendingStatusDrop) return;

    function handleStatusPopoverKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        cancelPendingStatusDrop();
      }
    }

    window.addEventListener("keydown", handleStatusPopoverKeydown);
    return () => window.removeEventListener("keydown", handleStatusPopoverKeydown);
  }, [cancelPendingStatusDrop, pendingStatusDrop]);

  useEffect(() => {
    if (!selectedTask) return;

    function handleDetailPanelKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        dismissDetailPanel();
      }
    }

    window.addEventListener("keydown", handleDetailPanelKeydown);
    return () => window.removeEventListener("keydown", handleDetailPanelKeydown);
  }, [dismissDetailPanel, selectedTask]);

  return (
    <section id="task-dashboard">
      <section className="focus-summary" aria-label={t("Task metrics")}>
        <MetricCard Icon={AlertTriangle} label={t("Blocked")} tone="danger" value={metrics.blocked} />
        <MetricCard Icon={Activity} label={t("Progress")} tone="blue" value={metrics.inProgress} />
        <MetricCard Icon={CircleDot} label={t("Open")} value={metrics.open} />
      </section>

      <section className="app-shell-grid">
        <section className="panel task-table-panel">
          <div className="list-head">
            <div>
              <h2>{t(view === "tasks" ? "All tasks" : "Focus queue")}</h2>
              <p className="muted">
                {t(view === "tasks" ? "Search, create, and edit Markdown-backed tasks." : "Open work, highest risk first.")}
              </p>
            </div>
            <div className="board-toolbar">
              <label className="board-filter" htmlFor="task-member-filter">
                <Users className="icon" aria-hidden="true" />
                <span className="sr-only">{t("Member")}</span>
                <select
                  id="task-member-filter"
                  aria-label={t("Filter by member")}
                  value={memberFilterId}
                  onChange={(event) => setMemberFilterId(event.currentTarget.value)}
                >
                  <option value="">{t("All members")}</option>
                  {memberFilterOptions.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.label)} ({option.count})
                    </option>
                  ))}
                </select>
              </label>
              <label className="board-filter" htmlFor="task-status-group-filter">
                <CircleDot className="icon" aria-hidden="true" />
                <span className="sr-only">{t("Status group")}</span>
                <select
                  id="task-status-group-filter"
                  aria-label={t("Filter by status group")}
                  value={statusGroupFilter}
                  onChange={(event) => handleStatusGroupFilterChange(event.currentTarget.value)}
                  disabled={!statusGroupFilterOptions.options.length}
                >
                  <option value="">{t("All status groups")}</option>
                  {statusGroupFilterOptions.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.label)} ({option.count})
                    </option>
                  ))}
                </select>
              </label>
              <label className="board-filter" htmlFor="task-detailed-status-filter">
                <CircleDot className="icon" aria-hidden="true" />
                <span className="sr-only">{t("Detailed status")}</span>
                <select
                  id="task-detailed-status-filter"
                  aria-label={t("Filter by detailed status")}
                  value={detailedStatusFilter}
                  onChange={(event) => handleDetailedStatusFilterChange(event.currentTarget.value)}
                  disabled={isDetailedStatusFilterDisabled}
                >
                  <option value="">{t(statusGroupFilter ? "All detailed statuses in group" : "All detailed statuses")}</option>
                  {detailedStatusFilterOptions.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.label)} ({option.count})
                    </option>
                  ))}
                </select>
              </label>
              <label className="board-filter" htmlFor="task-priority-filter">
                <AlertTriangle className="icon" aria-hidden="true" />
                <span className="sr-only">{t("Priority")}</span>
                <select
                  id="task-priority-filter"
                  aria-label={t("Filter by priority")}
                  value={priorityFilter}
                  onChange={(event) => handlePriorityFilterChange(event.currentTarget.value)}
                  disabled={!priorityFilterOptions.options.length}
                >
                  <option value="">{t("All priorities")}</option>
                  {priorityFilterOptions.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.label)} ({option.count})
                    </option>
                  ))}
                </select>
              </label>
              <label className="board-filter" htmlFor="task-source-filter">
                <Filter className="icon" aria-hidden="true" />
                <span className="sr-only">{t("Source")}</span>
                <select
                  id="task-source-filter"
                  aria-label={t("Filter by source")}
                  value={sourceFilter}
                  onChange={(event) => setSourceFilter(event.currentTarget.value)}
                  disabled={!sourceFilterOptions.options.length}
                >
                  <option value="">{t("All sources")}</option>
                  {sourceFilterOptions.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.label)} ({option.count})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {isOwner && isComposerOpen ? (
            <TaskComposer
              createContext={createContext}
              isSubmitting={isCreatingTask}
              key={`${createContext.memberId ?? "board"}:${createContext.assignee}:${createContext.status}:${createContext.statusGroupId ?? "default"}`}
              people={people}
              result={createResult}
              t={t}
              onCancel={cancelComposer}
              onCreateTask={handleCreateTask}
            />
          ) : null}

          <TaskKanbanBoard
            columns={filteredMemberColumns}
            isDragEnabled={true}
            selectedMemberId={selectedMemberId}
            selectedTaskId={selectedTask?.id ?? null}
            statusGroups={visibleStatusGroups}
            t={t}
            onDropTask={handleTaskDrop}
            onCreateTask={isOwner ? openColumnComposer : undefined}
            onSelectTask={onSelectTask}
          />
          {pendingStatusDrop ? (
            <TaskDropStatusPopover
              isSaving={isSavingBoardDrop}
              pendingDrop={pendingStatusDrop}
              t={t}
              onCancel={cancelPendingStatusDrop}
              onChangeStatus={(selectedStatus) => setPendingStatusDrop((current) => current ? { ...current, selectedStatus } : current)}
              onConfirm={confirmPendingStatusDrop}
            />
          ) : null}
          <ResultLine result={boardResult} t={t} />
        </section>
      </section>

      <details className="insight-disclosure">
        <summary>
          <span>
            <strong>{t("Context")}</strong>
            <small>{t("Recent activity and priority mix")}</small>
          </span>
        </summary>
        <div className="insight-grid">
          <section>
            <h2>{t("Recent activity")}</h2>
            <div className="activity-list">
              {recentTasks.length ? recentTasks.map((task) => <ActivityItem key={task.id} task={task} t={t} />) : <p className="muted">{t("No activity yet.")}</p>}
            </div>
          </section>
          <section>
            <h2>{t("Priority")}</h2>
            <div className="priority-summary">
              <div className="priority-donut" style={{ background: priority.gradient }} />
              <div className="priority-list">
                <PriorityLine color="coral" count={priority.p0} label="P0" />
                <PriorityLine color="amber" count={priority.p1} label="P1" />
                <PriorityLine color="blue" count={priority.p2} label="P2" />
              </div>
            </div>
          </section>
        </div>
      </details>

      {selectedTask ? (
        <div
          className="detail-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              dismissDetailPanel();
            }
          }}
        >
          <TaskDetail api={api} isOwner={isOwner} people={people} task={selectedTask} t={t} onDismiss={dismissDetailPanel} onReloadTasks={onReloadTasks} onSelectTask={onSelectTask} onTaskUpdated={onTaskUpdated} />
        </div>
      ) : null}
    </section>
  );
}

function TaskDropStatusPopover({
  isSaving,
  pendingDrop,
  t,
  onCancel,
  onChangeStatus,
  onConfirm
}: {
  isSaving: boolean;
  pendingDrop: PendingStatusDrop;
  t: Translator;
  onCancel: () => void;
  onChangeStatus: (status: string) => void;
  onConfirm: () => void;
}) {
  return (
    <div className="drop-status-popover" role="dialog" aria-modal="false" aria-labelledby="drop-status-title">
      <div className="drop-status-head">
        <div>
          <p className="eyebrow">{t("Choose detailed status")}</p>
          <h3 id="drop-status-title">{t(pendingDrop.statusGroupLabel)}</h3>
        </div>
        <button className="icon-button" type="button" aria-label={t("Cancel")} disabled={isSaving} onClick={onCancel}>
          <X className="icon" aria-hidden="true" />
        </button>
      </div>
      <p className="drop-status-context">
        <span className="kanban-card-id">{pendingDrop.taskId}</span>
        <span>{pendingDrop.taskTitle}</span>
        <span className="drop-status-target">{t(pendingDrop.targetMemberLabel)}</span>
      </p>
      <div className="drop-status-options" role="radiogroup" aria-label={t("Detailed status")}>
        {pendingDrop.statuses.map((status) => (
          <button
            className={`drop-status-option${pendingDrop.selectedStatus === status ? " selected" : ""}`}
            type="button"
            role="radio"
            aria-checked={pendingDrop.selectedStatus === status}
            disabled={isSaving}
            key={status}
            onClick={() => onChangeStatus(status)}
          >
            <span className={`status-pill status-${status}`}>{t(formatTaskStatus(status))}</span>
          </button>
        ))}
      </div>
      <div className="drop-status-actions">
        <button className="secondary-button" type="button" disabled={isSaving} onClick={onCancel}>{t("Cancel")}</button>
        <button className="composer-submit" type="button" disabled={isSaving} onClick={onConfirm}>
          <CheckCircle2 className="icon" aria-hidden="true" />
          <span>{t(isSaving ? "Saving..." : "Save drop")}</span>
        </button>
      </div>
    </div>
  );
}

function TaskComposer({
  createContext,
  isSubmitting,
  people,
  result,
  t,
  onCancel,
  onCreateTask
}: {
  createContext: TaskCreateBoardContext;
  isSubmitting: boolean;
  people: OwnerMapping[];
  result: ResultMessage | null;
  t: Translator;
  onCancel: () => void;
  onCreateTask: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const selectedStatusGroup = createContext.statusGroupId ? taskStatusGroupForId(createContext.statusGroupId) : null;
  const statusOptions = selectedStatusGroup?.statuses ?? [createContext.status];
  const isTitleInvalid = result?.ok === false && result.text === "Task title is required.";

  return (
    <form
      className={`composer${isSubmitting ? " is-loading" : ""}${result?.ok === false ? " has-error" : ""}`}
      aria-busy={isSubmitting}
      noValidate
      onSubmit={onCreateTask}
    >
      <div className="composer-head">
        <div>
          <h3>{t("Create task")}</h3>
          <p className="muted">{t("Add focused work directly to the selected board lane.")}</p>
        </div>
        <div className="composer-context" aria-label={t("Task scope")}>
          <span className="composer-chip">
            <Users className="icon" aria-hidden="true" />
            {t(createContext.memberLabel)}
          </span>
          <span className="composer-chip">
            <CircleDot className="icon" aria-hidden="true" />
            {t(createContext.statusGroupLabel)}
          </span>
        </div>
        <button className="icon-button" type="button" aria-label={t("Cancel")} disabled={isSubmitting} onClick={onCancel}>
          <X className="icon" aria-hidden="true" />
        </button>
      </div>
      <input name="assignee" type="hidden" value={createContext.assignee} />
      <label className="composer-title-field" htmlFor="task-title">
        <span className="composer-label">
          <TextCursorInput className="icon" aria-hidden="true" />
          {t("Title")}
        </span>
        <input
          id="task-title"
          name="title"
          aria-describedby={isTitleInvalid ? "task-title-error" : undefined}
          aria-invalid={isTitleInvalid}
          disabled={isSubmitting}
          placeholder={t("Task title")}
          required
        />
      </label>
      {isTitleInvalid ? <p className="field-error" id="task-title-error">{t("Task title is required.")}</p> : null}
      <div className="composer-control-row">
        <label htmlFor="task-priority">
          <span className="composer-label">
            <Flag className="icon" aria-hidden="true" />
            {t("Priority")}
          </span>
          <select id="task-priority" name="priority" defaultValue="P2" disabled={isSubmitting}>
            {priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select>
        </label>
        <label htmlFor="task-status">
          <span className="composer-label">
            <CircleDot className="icon" aria-hidden="true" />
            {t("Status")}
          </span>
          <select id="task-status" name="status" defaultValue={createContext.status} disabled={isSubmitting}>
            {statusOptions.map((status) => <option key={status} value={status}>{t(formatTaskStatus(status))}</option>)}
          </select>
        </label>
        <label htmlFor="task-category">
          <span className="composer-label">
            <Tag className="icon" aria-hidden="true" />
            {t("Category")}
          </span>
          <select id="task-category" name="category" defaultValue="general" disabled={isSubmitting}>
            {categories.map((category) => <option key={category} value={category}>{t(category)}</option>)}
          </select>
        </label>
        <label htmlFor="task-reporter">
          <span className="composer-label">
            <UserRound className="icon" aria-hidden="true" />
            {t("Reporter")}
          </span>
          <select id="task-reporter" name="reporter" disabled={isSubmitting}>
            <OwnerOptions emptyLabel="No reporter" people={people} t={t} />
          </select>
        </label>
        <label htmlFor="task-github-ref">
          <span className="composer-label">
            <GitBranch className="icon" aria-hidden="true" />
            {t("GitHub ref")}
          </span>
          <input id="task-github-ref" name="githubRef" disabled={isSubmitting} placeholder="owner/repo#123" />
        </label>
      </div>
      <div className="composer-detail-grid">
        <label className="next-action-field" htmlFor="task-next-action">
          {t("Next action")}
          <input id="task-next-action" name="nextAction" disabled={isSubmitting} placeholder={t("Concrete next step")} />
        </label>
        <label className="description-field" htmlFor="task-description">
          {t("Description")}
          <textarea id="task-description" name="description" disabled={isSubmitting} rows={3} />
        </label>
      </div>
      <div className="composer-actions">
        <button className="secondary-button" type="button" disabled={isSubmitting} onClick={onCancel}>{t("Cancel")}</button>
        <button className="composer-submit" type="submit" disabled={isSubmitting}>
          <CheckCircle2 className="icon" aria-hidden="true" />
          <span>{t(isSubmitting ? "Creating..." : "Create Task")}</span>
        </button>
      </div>
      <ResultLine result={result} t={t} />
    </form>
  );
}

function TaskKanbanBoard({
  columns,
  isDragEnabled,
  selectedMemberId,
  selectedTaskId,
  statusGroups,
  t,
  onDropTask,
  onCreateTask,
  onSelectTask
}: {
  columns: ReturnType<typeof taskMemberColumns>;
  isDragEnabled: boolean;
  selectedMemberId: string | null;
  selectedTaskId: string | null;
  statusGroups: typeof taskStatusGroups;
  t: Translator;
  onDropTask: (taskId: string, targetMemberId: string, targetStatusGroupId: string) => void;
  onCreateTask?: ((assignee: string | null, memberId: string, statusGroupId?: string) => void) | undefined;
  onSelectTask: (id: string, memberId: string) => void;
}) {
  const hasTasks = columns.some((column) => column.tasks.length);
  const [collapsedStatusGroups, setCollapsedStatusGroups] = useState<Set<string>>(() => new Set());
  const [mobileSelectedMemberId, setMobileSelectedMemberId] = useState(() => selectedMemberId ?? columns[0]?.id ?? "");
  const toggleStatusGroup = useCallback((columnId: string, groupId: string) => {
    setCollapsedStatusGroups((current) => toggleTaskStatusGroupCollapse(current, columnId, groupId));
  }, []);
  const mobileSelectedColumn = columns.find((column) => column.id === mobileSelectedMemberId) ?? columns[0] ?? null;

  useEffect(() => {
    if (selectedMemberId && columns.some((column) => column.id === selectedMemberId)) {
      setMobileSelectedMemberId(selectedMemberId);
      return;
    }

    setMobileSelectedMemberId((currentMemberId) => {
      if (columns.some((column) => column.id === currentMemberId)) return currentMemberId;
      return columns[0]?.id ?? "";
    });
  }, [columns, selectedMemberId]);

  return (
    <>
      <div className="mobile-member-control">
        <label className="board-filter" htmlFor="mobile-member-selector">
          <Users className="icon" aria-hidden="true" />
          <span className="sr-only">{t("Mobile selected member")}</span>
          <select
            id="mobile-member-selector"
            aria-label={t("Select member")}
            value={mobileSelectedColumn?.id ?? ""}
            onChange={(event) => setMobileSelectedMemberId(event.currentTarget.value)}
            disabled={!columns.length}
          >
            {columns.map((column) => (
              <option key={column.id} value={column.id}>
                {t(column.label)} ({column.tasks.length})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="member-board" aria-label={t("Task board")}>
        {columns.map((column) => {
          const columnCollapsedStatusGroups = new Set(
            statusGroups
              .filter((group) => collapsedStatusGroups.has(taskStatusGroupCollapseKey(column.id, group.id)))
              .map((group) => group.id)
          );

          return (
            <MemberKanbanColumn
              collapsedStatusGroups={columnCollapsedStatusGroups}
              column={column}
              isDragEnabled={isDragEnabled}
              isSelectedMember={selectedMemberId === column.id}
              key={column.id}
              selectedTaskId={selectedTaskId}
              statusGroups={statusGroups}
              t={t}
              onDropTask={onDropTask}
              onCreateTask={onCreateTask ? (targetColumn, statusGroupId) => onCreateTask(targetColumn.assignee, targetColumn.id, statusGroupId) : undefined}
              onToggleStatusGroup={toggleStatusGroup}
              onSelectTask={onSelectTask}
            />
          );
        })}
        {!hasTasks ? <p className="empty-state board-empty">{t("No tasks need attention in this view.")}</p> : null}
      </div>

      <div className="mobile-member-board" aria-label={t("Selected member task board")}>
        {mobileSelectedColumn ? (
          <MemberKanbanColumn
            collapsedStatusGroups={new Set(
              statusGroups
                .filter((group) => collapsedStatusGroups.has(taskStatusGroupCollapseKey(mobileSelectedColumn.id, group.id)))
                .map((group) => group.id)
            )}
            column={mobileSelectedColumn}
            idPrefix="mobile-"
            isDragEnabled={isDragEnabled}
            isSelectedMember={true}
            selectedTaskId={selectedTaskId}
            statusGroups={statusGroups}
            t={t}
            onDropTask={onDropTask}
            onCreateTask={onCreateTask ? (targetColumn, statusGroupId) => onCreateTask(targetColumn.assignee, targetColumn.id, statusGroupId) : undefined}
            onToggleStatusGroup={toggleStatusGroup}
            onSelectTask={onSelectTask}
          />
        ) : (
          <p className="empty-state board-empty">{t("No tasks need attention in this view.")}</p>
        )}
      </div>
    </>
  );
}

function TaskDetail({
  api,
  isOwner,
  people,
  task,
  t,
  onDismiss,
  onReloadTasks,
  onSelectTask,
  onTaskUpdated
}: {
  api: ApiClient;
  isOwner: boolean;
  people: OwnerMapping[];
  task: Task;
  t: Translator;
  onDismiss: () => void;
  onReloadTasks: () => Promise<void>;
  onSelectTask: (id: string | null, memberId?: string | null) => void;
  onTaskUpdated: (task: Task) => void;
}) {
  const [draft, setDraft] = useState(taskDraft(task));
  const [result, setResult] = useState<ResultMessage | null>(null);
  const SourceIcon = taskSourceIcon(task);
  const source = taskSource(task);
  const detailedStatus = formatStatus(task.status);
  const metadata = [
    { label: "Slack channel", value: task.channelId },
    { label: "Slack thread", value: task.threadTs },
    { label: "GitHub ref", value: draft.githubRef },
    { label: "Markdown", value: task.markdownPath },
    { label: "Source agent", value: task.sourceAgentName },
    { label: "Updated", value: relativeTime(task.updatedAt) }
  ];

  useEffect(() => {
    setDraft(taskDraft(task));
    setResult(null);
  }, [task]);

  async function saveSelected() {
    try {
      const payload = isOwner
        ? draft
        : { status: draft.status, nextAction: draft.nextAction, result: draft.result };
      const data = await api<{ task: Task }>(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      setResult({ text: "Saved.", ok: true });
      onTaskUpdated(data.task);
      await onReloadTasks();
      onSelectTask(data.task.id);
    } catch (error) {
      setResult({ text: errorMessage(error), ok: false });
    }
  }

  return (
    <section className="panel detail-panel">
      <div className="detail-head">
        <div className="detail-title-block">
          <p className="eyebrow">{t("Task detail")}</p>
          <h2>{task.title}</h2>
          <div className="detail-badge-row" aria-label={t("Task badges")}>
            <span className="kanban-card-id">{task.id}</span>
            <span className={`priority priority-${draft.priority}`}>{draft.priority}</span>
            <span className={`status-pill status-${task.status}`}>{t(detailedStatus)}</span>
            <span className="source-pill">
              <SourceIcon className="icon" aria-hidden="true" />
              <span>{t(source)}</span>
            </span>
          </div>
        </div>
        <button className="icon-button secondary-button" type="button" aria-label={t("Close detail panel")} title={t("Close detail panel")} onClick={onDismiss}>
          <X className="icon" aria-hidden="true" />
          <span className="sr-only">{t("Close detail panel")}</span>
        </button>
      </div>

      <section className="detail-section" aria-labelledby="task-overview-heading">
        <h3 id="task-overview-heading">{t("Overview")}</h3>
        <dl className="detail-field-grid">
          <TaskDetailValue label="Assignee" t={t} value={draft.assignee || "Unassigned"} />
          <TaskDetailValue label="Reporter" t={t} value={draft.reporter} />
          <TaskDetailValue label="Priority" t={t} value={draft.priority} />
          <TaskDetailValue label="Detailed status" t={t} value={detailedStatus} />
          <TaskDetailValue label="Category" t={t} value={draft.category} />
          <TaskDetailValue label="Initiative" t={t} value={draft.initiative} />
        </dl>
      </section>

      <section className="detail-section" aria-labelledby="task-work-heading">
        <h3 id="task-work-heading">{t("Work")}</h3>
        <div className="detail-copy-grid">
          <TaskDetailCopy label="Description" t={t} value={draft.description} />
          <TaskDetailCopy label="Next action" t={t} value={draft.nextAction} />
          <TaskDetailCopy label="Result" t={t} value={draft.result} />
        </div>
      </section>

      <section className="detail-section" aria-labelledby="task-metadata-heading">
        <h3 id="task-metadata-heading">{t("Metadata")}</h3>
        <dl className="detail-field-grid metadata-grid">
          {metadata.map((item) => <TaskDetailValue key={item.label} label={item.label} t={t} value={item.value} />)}
        </dl>
      </section>

      <div className="detail-edit-grid" aria-label={t("Editable task fields")}>
        {isOwner ? <label htmlFor="priority-select">
          {t("Priority")}
          <select id="priority-select" value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.currentTarget.value })}>
            {priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select>
        </label> : null}
        <label htmlFor="status-select">
          {t("Status")}
          <select id="status-select" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.currentTarget.value })}>
            {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        {isOwner ? <label htmlFor="category-select">
          {t("Category")}
          <select id="category-select" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.currentTarget.value })}>
            {categories.map((category) => <option key={category} value={category}>{t(category)}</option>)}
          </select>
        </label> : null}
        {isOwner ? <label htmlFor="assignee-input">
          {t("Assignee")}
          <select id="assignee-input" value={draft.assignee} onChange={(event) => setDraft({ ...draft, assignee: event.currentTarget.value })}>
            <OwnerOptions emptyLabel="Unassigned" people={people} t={t} />
          </select>
        </label> : null}
        {isOwner ? <label htmlFor="reporter-input">
          {t("Reporter")}
          <select id="reporter-input" value={draft.reporter} onChange={(event) => setDraft({ ...draft, reporter: event.currentTarget.value })}>
            <OwnerOptions emptyLabel="No reporter" people={people} t={t} />
          </select>
        </label> : null}
        {isOwner ? <label htmlFor="github-ref-input">
          {t("GitHub ref")}
          <input id="github-ref-input" value={draft.githubRef} onChange={(event) => setDraft({ ...draft, githubRef: event.currentTarget.value })} />
        </label> : null}
        {isOwner ? <label htmlFor="initiative-input">
          {t("Initiative")}
          <input id="initiative-input" value={draft.initiative} onChange={(event) => setDraft({ ...draft, initiative: event.currentTarget.value })} />
        </label> : null}
        <label className="wide-field" htmlFor="next-action-input">
          {t("Next action")}
          <input id="next-action-input" value={draft.nextAction} onChange={(event) => setDraft({ ...draft, nextAction: event.currentTarget.value })} />
        </label>
        <label className="wide-field" htmlFor="result-input">
          {t("Result")}
          <textarea id="result-input" rows={3} value={draft.result} onChange={(event) => setDraft({ ...draft, result: event.currentTarget.value })} />
        </label>
        {isOwner ? <label className="wide-field" htmlFor="description-input">
          {t("Description")}
          <textarea id="description-input" rows={5} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })} />
        </label> : null}
      </div>
      <div className="button-row">
        <button type="button" onClick={saveSelected}>
          <CheckCircle2 className="icon" aria-hidden="true" />
          <span>{t("Save Changes")}</span>
        </button>
      </div>
      <ResultLine result={result} t={t} />
    </section>
  );
}

function TaskDetailValue({ label, t, value }: { label: string; t: Translator; value: string | null | undefined }) {
  return (
    <>
      <dt>{t(label)}</dt>
      <dd>{value ? t(value) : t("Not set")}</dd>
    </>
  );
}

function TaskDetailCopy({ label, t, value }: { label: string; t: Translator; value: string | null | undefined }) {
  return (
    <div className="detail-copy-block">
      <span>{t(label)}</span>
      <p>{value ? value : t("Not set")}</p>
    </div>
  );
}

function ActivityItem({ task, t }: { task: Task; t: Translator }) {
  return (
    <div className="activity-item">
      <span className={`activity-dot status-${task.status}`} />
      <div>
        <strong>{t(activityLabel(task))}</strong>
        <p>{task.title}</p>
      </div>
      <time>{relativeTime(task.updatedAt)}</time>
    </div>
  );
}

function formatStatus(status: string) {
  return formatTaskStatus(status);
}
