import { Activity, AlertTriangle, Bot, CheckCircle2, CircleDot, GitBranch, Pencil, Plus, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { MetricCard, OwnerOptions, PriorityLine, ResultLine } from "../components/common";
import { errorMessage, relativeTime } from "../lib/format";
import {
  activityLabel,
  categories,
  filterTasks,
  focusTasks,
  priorities,
  priorityMetrics,
  statuses,
  taskDraft,
  taskMetrics,
  taskSource
} from "../lib/tasks";
import type { ApiClient, OwnerMapping, ResultMessage, Task, Translator, View } from "../types";

export function TaskWorkspace({
  api,
  people,
  result,
  search,
  selectedTask,
  tasks,
  t,
  view,
  onCreateTask,
  onReloadTasks,
  onSelectTask
}: {
  api: ApiClient;
  people: OwnerMapping[];
  result: ResultMessage | null;
  search: string;
  selectedTask: Task | null;
  tasks: Task[];
  t: Translator;
  view: View;
  onCreateTask: (event: FormEvent<HTMLFormElement>) => void;
  onReloadTasks: () => Promise<void>;
  onSelectTask: (id: string | null) => void;
}) {
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const matchingTasks = useMemo(() => filterTasks(tasks, search), [search, tasks]);
  const visibleTasks = useMemo(
    () => view === "tasks" ? matchingTasks : focusTasks(matchingTasks).slice(0, 8),
    [matchingTasks, view]
  );
  const metrics = useMemo(() => taskMetrics(tasks), [tasks]);
  const priority = useMemo(() => priorityMetrics(tasks), [tasks]);
  const recentTasks = useMemo(
    () => [...tasks].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5),
    [tasks]
  );

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
            <button id="new-task-toggle" type="button" onClick={() => setIsComposerOpen((open) => !open)}>
              <Plus className="icon" aria-hidden="true" />
              <span>{t("New")}</span>
            </button>
          </div>

          {isComposerOpen ? (
            <TaskComposer people={people} result={result} t={t} onCreateTask={onCreateTask} />
          ) : null}

          <TaskTable tasks={visibleTasks} t={t} onSelectTask={onSelectTask} />
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
        <TaskDetail api={api} people={people} task={selectedTask} t={t} onReloadTasks={onReloadTasks} onSelectTask={onSelectTask} />
      ) : null}
    </section>
  );
}

function TaskComposer({
  people,
  result,
  t,
  onCreateTask
}: {
  people: OwnerMapping[];
  result: ResultMessage | null;
  t: Translator;
  onCreateTask: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="composer" onSubmit={onCreateTask}>
      <div className="composer-grid">
        <label htmlFor="task-title">
          {t("Title")}
          <input id="task-title" name="title" required />
        </label>
        <label htmlFor="task-assignee">
          {t("Assignee")}
          <select id="task-assignee" name="assignee">
            <OwnerOptions emptyLabel="No assignee" people={people} t={t} />
          </select>
        </label>
        <label htmlFor="task-priority">
          {t("Priority")}
          <select id="task-priority" name="priority" defaultValue="P2">
            {priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select>
        </label>
        <label htmlFor="task-category">
          {t("Category")}
          <select id="task-category" name="category" defaultValue="general">
            {categories.map((category) => <option key={category} value={category}>{t(category)}</option>)}
          </select>
        </label>
        <label htmlFor="task-status">
          {t("Status")}
          <select id="task-status" name="status" defaultValue="confirmed">
            <option value="confirmed">confirmed</option>
            <option value="proposed">proposed</option>
            <option value="in_progress">in_progress</option>
          </select>
        </label>
        <label htmlFor="task-reporter">
          {t("Reporter")}
          <select id="task-reporter" name="reporter">
            <OwnerOptions emptyLabel="No reporter" people={people} t={t} />
          </select>
        </label>
        <label htmlFor="task-github-ref">
          {t("GitHub ref")}
          <input id="task-github-ref" name="githubRef" placeholder="owner/repo#123" />
        </label>
      </div>
      <label className="description-field" htmlFor="task-description">
        {t("Description")}
        <textarea id="task-description" name="description" rows={3} />
      </label>
      <label className="next-action-field" htmlFor="task-next-action">
        {t("Next action")}
        <input id="task-next-action" name="nextAction" placeholder={t("Concrete next step")} />
      </label>
      <button className="composer-submit" type="submit">
        <CheckCircle2 className="icon" aria-hidden="true" />
        <span>{t("Create Task")}</span>
      </button>
      <ResultLine result={result} t={t} />
    </form>
  );
}

function TaskTable({
  tasks,
  t,
  onSelectTask
}: {
  tasks: Task[];
  t: Translator;
  onSelectTask: (id: string) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>{t("Task")}</th>
          <th>{t("Priority")}</th>
          <th>{t("Status")}</th>
          <th>{t("Owner")}</th>
          <th>{t("Source")}</th>
          <th>{t("Updated")}</th>
        </tr>
      </thead>
      <tbody>
        {tasks.length ? (
          tasks.map((task) => <TaskRow key={task.id} task={task} t={t} onSelectTask={onSelectTask} />)
        ) : (
          <tr>
            <td colSpan={6} className="empty-state">{t("No tasks need attention in this view.")}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function TaskRow({ task, t, onSelectTask }: { task: Task; t: Translator; onSelectTask: (id: string) => void }) {
  const SourceIcon = taskSourceIcon(task);
  const source = taskSource(task);

  return (
    <tr>
      <td>
        <button className="row-button" type="button" onClick={() => onSelectTask(task.id)}>{task.title}</button>
        <span>{task.id}</span>
      </td>
      <td><span className={`priority priority-${task.priority || "P2"}`}>{task.priority || "P2"}</span></td>
      <td><span className={`status-pill status-${task.status}`}>{t(task.status.replace("_", " "))}</span></td>
      <td>{task.assignee || t("Unassigned")}</td>
      <td>
        <span className="source-pill icon-pill" title={t(source)} aria-label={t(source)}>
          <SourceIcon className="icon" aria-hidden="true" />
          <span className="sr-only">{t(source)}</span>
        </span>
      </td>
      <td>{relativeTime(task.updatedAt)}</td>
    </tr>
  );
}

function TaskDetail({
  api,
  people,
  task,
  t,
  onReloadTasks,
  onSelectTask
}: {
  api: ApiClient;
  people: OwnerMapping[];
  task: Task;
  t: Translator;
  onReloadTasks: () => Promise<void>;
  onSelectTask: (id: string | null) => void;
}) {
  const [draft, setDraft] = useState(taskDraft(task));
  const [result, setResult] = useState<ResultMessage | null>(null);

  useEffect(() => {
    setDraft(taskDraft(task));
    setResult(null);
  }, [task]);

  async function saveSelected() {
    try {
      const data = await api<{ task: Task }>(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify(draft)
      });
      setResult({ text: "Saved.", ok: true });
      await onReloadTasks();
      onSelectTask(data.task.id);
    } catch (error) {
      setResult({ text: errorMessage(error), ok: false });
    }
  }

  return (
    <section className="panel detail-panel">
      <div className="detail-head">
        <div>
          <p className="eyebrow">{t("Task")}</p>
          <h2>{task.title}</h2>
        </div>
        <button className="icon-button secondary-button" type="button" aria-label={t("Clear")} title={t("Clear")} onClick={() => onSelectTask(null)}>
          <CircleDot className="icon" aria-hidden="true" />
          <span className="sr-only">{t("Clear")}</span>
        </button>
      </div>
      <dl className="kv detail-meta">
        <dt>{t("ID")}</dt>
        <dd>{task.id}</dd>
        <dt>{t("Slack")}</dt>
        <dd>{[task.channelId, task.threadTs].filter(Boolean).join(" ")}</dd>
        <dt>{t("Markdown")}</dt>
        <dd>{task.markdownPath || ""}</dd>
      </dl>
      <div className="detail-grid">
        <label htmlFor="priority-select">
          {t("Priority")}
          <select id="priority-select" value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.currentTarget.value })}>
            {priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select>
        </label>
        <label htmlFor="status-select">
          {t("Status")}
          <select id="status-select" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.currentTarget.value })}>
            {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <label htmlFor="category-select">
          {t("Category")}
          <select id="category-select" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.currentTarget.value })}>
            {categories.map((category) => <option key={category} value={category}>{t(category)}</option>)}
          </select>
        </label>
        <label htmlFor="assignee-input">
          {t("Assignee")}
          <select id="assignee-input" value={draft.assignee} onChange={(event) => setDraft({ ...draft, assignee: event.currentTarget.value })}>
            <OwnerOptions emptyLabel="Unassigned" people={people} t={t} />
          </select>
        </label>
        <label htmlFor="reporter-input">
          {t("Reporter")}
          <select id="reporter-input" value={draft.reporter} onChange={(event) => setDraft({ ...draft, reporter: event.currentTarget.value })}>
            <OwnerOptions emptyLabel="No reporter" people={people} t={t} />
          </select>
        </label>
        <label htmlFor="github-ref-input">
          {t("GitHub ref")}
          <input id="github-ref-input" value={draft.githubRef} onChange={(event) => setDraft({ ...draft, githubRef: event.currentTarget.value })} />
        </label>
        <label htmlFor="initiative-input">
          {t("Initiative")}
          <input id="initiative-input" value={draft.initiative} onChange={(event) => setDraft({ ...draft, initiative: event.currentTarget.value })} />
        </label>
        <label className="wide-field" htmlFor="next-action-input">
          {t("Next action")}
          <input id="next-action-input" value={draft.nextAction} onChange={(event) => setDraft({ ...draft, nextAction: event.currentTarget.value })} />
        </label>
        <label className="wide-field" htmlFor="description-input">
          {t("Description")}
          <textarea id="description-input" rows={5} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })} />
        </label>
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

function taskSourceIcon(task: Task): LucideIcon {
  if (task.githubRef) return GitBranch;
  if (task.category === "coding") return GitBranch;
  if (task.channelId || task.threadTs || task.sourceAgentName) return Bot;
  return Pencil;
}
