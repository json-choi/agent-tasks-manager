import { Bot, ChevronDown, GitBranch, Pencil, Plus, type LucideIcon } from "lucide-react";
import { useState, type DragEvent } from "react";
import { taskSource, taskStatusGroupSections, taskStatusGroups, type TaskMemberColumn as TaskMemberColumnModel, type TaskStatusGroup } from "../lib/tasks";
import type { Task, Translator } from "../types";

const taskDragMimeType = "application/x-agent-task-id";

export function MemberKanbanColumn({
  column,
  idPrefix = "",
  isDragEnabled,
  isSelectedMember,
  selectedTaskId,
  collapsedStatusGroups,
  statusGroups = taskStatusGroups,
  t,
  onDropTask,
  onCreateTask,
  onToggleStatusGroup,
  onSelectTask
}: {
  column: TaskMemberColumnModel;
  idPrefix?: string;
  isDragEnabled: boolean;
  isSelectedMember: boolean;
  selectedTaskId: string | null;
  collapsedStatusGroups: ReadonlySet<string>;
  statusGroups?: readonly TaskStatusGroup[];
  t: Translator;
  onDropTask: (taskId: string, targetMemberId: string, targetStatusGroupId: string) => void;
  onCreateTask?: ((column: TaskMemberColumnModel, statusGroupId?: string) => void) | undefined;
  onToggleStatusGroup: (columnId: string, groupId: string) => void;
  onSelectTask: (id: string, memberId: string) => void;
}) {
  const sections = taskStatusGroupSections(column.tasks, statusGroups);
  const visibleTaskCount = sections.reduce((count, section) => count + section.tasks.length, 0);
  const [activeDropGroupId, setActiveDropGroupId] = useState<string | null>(null);
  const isEmptyColumn = visibleTaskCount === 0;

  function activateDropZone(event: DragEvent<HTMLElement>, groupId: string) {
    if (!isDragEnabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setActiveDropGroupId(groupId);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>, groupId: string) {
    const relatedNode = event.relatedTarget && "nodeType" in event.relatedTarget
      ? event.relatedTarget as Node
      : null;
    if (relatedNode && event.currentTarget.contains(relatedNode)) return;
    setActiveDropGroupId((currentGroupId) => currentGroupId === groupId ? null : currentGroupId);
  }

  function handleDrop(event: DragEvent<HTMLElement>, groupId: string) {
    if (!isDragEnabled) return;
    event.preventDefault();
    setActiveDropGroupId(null);
    const taskId = event.dataTransfer.getData(taskDragMimeType) || event.dataTransfer.getData("text/plain");
    if (!taskId) return;
    onDropTask(taskId, column.id, groupId);
  }

  return (
    <section className={`member-column${isSelectedMember ? " selected-member" : ""}${isEmptyColumn ? " empty-member" : ""}`} aria-label={t(column.label)}>
      <div className="member-column-head">
        <h3>{t(column.label)}</h3>
        <div className="member-column-actions">
          <span>{visibleTaskCount}</span>
          {onCreateTask ? (
            <button
              className="member-column-create"
              type="button"
              aria-label={`${t("Create task for")} ${t(column.label)}`}
              title={t("Create task")}
              onClick={() => onCreateTask(column)}
            >
              <Plus className="icon" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      {isEmptyColumn ? <p className="member-column-empty">{t("No assigned tasks")}</p> : null}
      <div className="status-group-stack">
        {sections.map((group) => {
          const isCollapsed = collapsedStatusGroups.has(group.id);
          const isDropTarget = activeDropGroupId === group.id;
          const cardListId = `${idPrefix}${column.id}-${group.id}-cards`;
          const dropZoneLabel = `${t(column.label)} ${t(group.label)} ${t("drop zone")}`;
          return (
            <section
              className={`status-group kanban-drop-zone${isCollapsed ? " collapsed" : ""}${isDropTarget ? " drag-over" : ""}${isDragEnabled ? " can-drop" : ""}`}
              key={group.id}
              aria-label={dropZoneLabel}
              data-drop-active={isDropTarget ? "true" : "false"}
              data-drop-enabled={isDragEnabled ? "true" : "false"}
              data-status-group={group.id}
              onDragLeave={(event) => handleDragLeave(event, group.id)}
              onDragEnter={(event) => activateDropZone(event, group.id)}
              onDragOver={(event) => activateDropZone(event, group.id)}
              onDrop={(event) => handleDrop(event, group.id)}
            >
              <div className="status-group-head">
                <button
                  className="status-group-toggle"
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-controls={cardListId}
                  onClick={() => onToggleStatusGroup(column.id, group.id)}
                >
                  <span className="status-group-title">
                    <ChevronDown className="icon" aria-hidden="true" />
                    <span>{t(group.label)}</span>
                  </span>
                  <small>{group.tasks.length}</small>
                </button>
                {onCreateTask ? (
                  <button
                    className="status-group-create"
                    type="button"
                    aria-label={`${t("Create task in")} ${t(column.label)} ${t(group.label)}`}
                    title={t("Create task")}
                    onClick={() => onCreateTask(column, group.id)}
                  >
                    <Plus className="icon" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <div className="kanban-card-list" id={cardListId} hidden={isCollapsed}>
                {group.tasks.length ? group.tasks.map((task) => (
                  <TaskKanbanCard
                    isDragEnabled={isDragEnabled}
                    isSelected={selectedTaskId === task.id}
                    key={task.id}
                    memberId={column.id}
                    task={task}
                    t={t}
                    onSelectTask={onSelectTask}
                  />
                )) : (
                  <p className="kanban-empty">
                    <span>{t("No tasks")}</span>
                    {isDragEnabled ? <small>{t("Drop here")}</small> : null}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function TaskKanbanCard({
  isDragEnabled,
  memberId,
  isSelected,
  task,
  t,
  onSelectTask
}: {
  isDragEnabled: boolean;
  memberId: string;
  isSelected: boolean;
  task: Task;
  t: Translator;
  onSelectTask: (id: string, memberId: string) => void;
}) {
  const SourceIcon = taskSourceIcon(task);
  const source = taskSource(task);
  const priority = task.priority || "P2";
  const detailedStatus = formatDetailedStatus(task.status);

  return (
    <button
      className={`kanban-card${isSelected ? " selected" : ""}`}
      type="button"
      aria-label={t(`${task.id}: ${task.title}`)}
      aria-pressed={isSelected}
      draggable={isDragEnabled}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(taskDragMimeType, task.id);
        event.dataTransfer.setData("text/plain", task.id);
      }}
      onClick={() => onSelectTask(task.id, memberId)}
    >
      <span className="kanban-card-topline">
        <span className="kanban-card-id">{task.id}</span>
        <span className="source-pill icon-pill" title={t(source)} aria-label={t(source)}>
          <SourceIcon className="icon" aria-hidden="true" />
          <span className="sr-only">{t(source)}</span>
        </span>
      </span>
      <span className="kanban-card-title">{task.title}</span>
      <span className="kanban-card-meta">
        <span className={`priority priority-${priority}`}>{priority}</span>
        <span className={`status-pill status-${task.status}`}>{t(detailedStatus)}</span>
      </span>
    </button>
  );
}

export function taskSourceIcon(task: Task): LucideIcon {
  if (task.githubRef) return GitBranch;
  if (task.category === "coding") return GitBranch;
  if (task.channelId || task.threadTs || task.sourceAgentName) return Bot;
  return Pencil;
}

function formatDetailedStatus(status: string) {
  return status.split("_").join(" ");
}
