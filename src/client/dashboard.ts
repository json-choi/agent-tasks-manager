type Task = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority?: "P0" | "P1" | "P2";
  assignee?: string | null;
  reporter?: string | null;
  initiative?: string | null;
  nextAction?: string | null;
  githubRef?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  sourceAgentName?: string | null;
  markdownPath?: string;
  updatedAt: string;
};

const state: {
  token: string;
  tasks: Task[];
  selected: Task | null;
  search: string;
  view: string;
} = {
  token: localStorage.getItem("tm_admin_token") || "",
  tasks: [],
  selected: null,
  search: "",
  view: "dashboard"
};

const statuses = ["proposed", "confirmed", "assigning", "in_progress", "blocked", "review_needed", "done", "cancelled"];
const priorities = ["P0", "P1", "P2"];

function boot() {
  const root = document.getElementById("app");
  if (!root) return;
  root.innerHTML = layout();
  bindEvents();
  loadTasks();
}

async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type") && options.body) headers.set("content-type", "application/json");
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function layout() {
  return `
    <main class="dashboard-shell">
      <header class="product-header compact-header">
        <div class="brand-lockup">
          <img class="brand-avatar" src="/assets/brand/atm-persona.svg" alt="">
          <div>
            <p class="eyebrow">ATM · Agent Tasks Manager</p>
            <h1>Task Console</h1>
            <p class="muted">Self-hosted queue for agent-proposed work.</p>
          </div>
        </div>
        <nav class="nav">
          <a class="link-button secondary-button" href="/setup">Setup</a>
          <button id="logout" type="button">Logout</button>
        </nav>
      </header>
      <section id="login-screen" class="login-screen">
        <form id="login-form" class="panel login">
          <p class="eyebrow">Admin access</p>
          <h2>Open the self-hosted task console.</h2>
          <label>Email <input name="email" type="email" autocomplete="email" required></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
          <button type="submit">Login</button>
          <p id="login-result" class="result"></p>
        </form>
      </section>
      <section id="app-view" class="app-shell-frame hidden">
        <div class="app-shell-nav">
          <div class="app-nav-left">
            <img class="app-nav-mark" src="/assets/brand/atm-persona.svg" alt="">
            ${["dashboard", "tasks", "agents", "integrations", "settings"].map((view) => `<button class="app-tab ${view === "dashboard" ? "active" : ""}" type="button" data-view="${view}">${titleCase(view)}</button>`).join("")}
          </div>
          <div class="toolbar-actions">
            <input id="task-search" aria-label="Search tasks" placeholder="Search tasks...">
            <button id="refresh" type="button">Refresh</button>
          </div>
        </div>
        <section id="task-dashboard">
          <section class="metric-grid" aria-label="Task metrics">
            <div class="metric-card"><span>Tasks</span><strong id="metric-total">0</strong><small id="metric-total-note">stored locally</small></div>
            <div class="metric-card ok"><span>Done</span><strong id="metric-done">0</strong><small>completed</small></div>
            <div class="metric-card danger"><span>Blocked</span><strong id="metric-blocked">0</strong><small>waiting on help</small></div>
            <div class="metric-card blue"><span>In Progress</span><strong id="metric-in-progress">0</strong><small>owned work</small></div>
            <div class="metric-card"><span>Open</span><strong id="metric-open">0</strong><small>needs attention</small></div>
          </section>
          <section class="app-shell-grid">
            <section class="panel task-table-panel">
              <div class="list-head">
                <div><h2 id="task-panel-title">Tasks</h2><p id="task-panel-subtitle" class="muted">Markdown-backed task index</p></div>
                <button id="new-task-toggle" type="button">+ New task</button>
              </div>
              <form id="task-form" class="composer hidden">
                <div class="composer-grid">
                  <label>Title <input name="title" required></label>
                  <label>Assignee <input name="assignee" placeholder="@user or Slack ID"></label>
                  <label>Priority <select name="priority"><option value="P2">P2</option><option value="P1">P1</option><option value="P0">P0</option></select></label>
                  <label>Status <select name="status"><option value="confirmed">confirmed</option><option value="proposed">proposed</option><option value="in_progress">in_progress</option></select></label>
                  <label>Reporter <input name="reporter" placeholder="@reporter"></label>
                  <label>GitHub ref <input name="githubRef" placeholder="owner/repo#123"></label>
                </div>
                <label>Description <textarea name="description" rows="3"></textarea></label>
                <label>Next action <input name="nextAction" placeholder="Concrete next step"></label>
                <button type="submit">Create Task</button>
                <p id="task-result" class="result"></p>
              </form>
              <table><thead><tr><th>Task</th><th>Priority</th><th>Status</th><th>Owner</th><th>Source</th><th>Updated</th></tr></thead><tbody id="task-list"></tbody></table>
            </section>
            <aside class="app-side-stack">
              <section class="panel"><h2>Recent activity</h2><div id="activity-list" class="activity-list"></div></section>
              <section class="panel"><h2>Priority breakdown</h2><div class="priority-summary"><div id="priority-donut" class="priority-donut"></div><div id="priority-list" class="priority-list"></div></div></section>
            </aside>
          </section>
          <section id="detail" class="panel detail-panel hidden"></section>
        </section>
        <section id="secondary-view" class="secondary-view hidden"></section>
      </section>
    </main>
  `;
}

function bindEvents() {
  byId("login-form").addEventListener("submit", onLogin);
  byId("task-form").addEventListener("submit", onCreateTask);
  byId("refresh").addEventListener("click", () => loadTasks());
  byId("task-search").addEventListener("input", (event) => {
    state.search = (event.currentTarget as HTMLInputElement).value;
    renderTasks();
  });
  byId("new-task-toggle").addEventListener("click", () => byId("task-form").classList.toggle("hidden"));
  byId("logout").addEventListener("click", onLogout);
  document.querySelectorAll("[data-view]").forEach((node) => {
    node.addEventListener("click", () => setView((node as HTMLElement).dataset.view || "dashboard"));
  });
}

async function onLogin(event: Event) {
  event.preventDefault();
  try {
    const form = event.currentTarget as HTMLFormElement;
    const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
    state.token = data.token;
    localStorage.setItem("tm_admin_token", data.token);
    setResult("login-result", "Logged in.");
    await loadTasks();
  } catch (error) {
    setResult("login-result", errorMessage(error), false);
  }
}

async function onCreateTask(event: Event) {
  event.preventDefault();
  try {
    const form = event.currentTarget as HTMLFormElement;
    await api("/api/tasks", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
    form.reset();
    setResult("task-result", "Task created.");
    await loadTasks();
  } catch (error) {
    setResult("task-result", errorMessage(error), false);
  }
}

async function onLogout() {
  await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => null);
  localStorage.removeItem("tm_admin_token");
  state.token = "";
  showApp(false);
}

async function loadTasks() {
  try {
    const data = await api("/api/tasks");
    state.tasks = data.tasks || [];
    showApp(true);
    await renderActiveView();
  } catch (error) {
    showApp(false);
    if (state.token) setResult("login-result", errorMessage(error), false);
  }
}

function showApp(show: boolean) {
  byId("app-view").classList.toggle("hidden", !show);
  byId("login-screen").classList.toggle("hidden", show);
}

async function setView(view: string) {
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((node) => node.classList.toggle("active", (node as HTMLElement).dataset.view === view));
  await renderActiveView();
}

async function renderActiveView() {
  const taskViews = ["dashboard", "tasks"];
  byId("task-dashboard").classList.toggle("hidden", !taskViews.includes(state.view));
  byId("secondary-view").classList.toggle("hidden", taskViews.includes(state.view));
  byId("app-view").classList.toggle("view-tasks", state.view === "tasks");
  (byId("task-search") as HTMLInputElement).placeholder = state.view === "tasks" ? "Search all tasks..." : "Search tasks...";
  if (taskViews.includes(state.view)) {
    renderTasks();
    return;
  }
  byId("detail").classList.add("hidden");
  await renderSecondaryView(state.view);
}

function renderTasks() {
  text("task-panel-title", state.view === "tasks" ? "All tasks" : "Tasks");
  text("task-panel-subtitle", state.view === "tasks" ? "Search, create, and edit Markdown-backed tasks." : "Markdown-backed task index");
  renderDashboardSummary();
  const query = state.search.trim().toLowerCase();
  const tasks = query ? state.tasks.filter((task) => [task.title, task.id, task.status, task.assignee, task.reporter, task.githubRef].filter(Boolean).some((value) => String(value).toLowerCase().includes(query))) : state.tasks;
  byId("task-list").innerHTML = tasks.length ? tasks.map(renderTaskRow).join("") : '<tr><td colspan="6" class="empty-state">No tasks match this view.</td></tr>';
  document.querySelectorAll("#task-list [data-id]").forEach((node) => node.addEventListener("click", () => selectTask((node as HTMLElement).dataset.id || "")));
}

function renderDashboardSummary() {
  const total = state.tasks.length;
  const open = state.tasks.filter((task) => !["done", "cancelled"].includes(task.status)).length;
  const blocked = state.tasks.filter((task) => task.status === "blocked").length;
  const inProgress = state.tasks.filter((task) => task.status === "in_progress").length;
  const done = state.tasks.filter((task) => task.status === "done").length;
  text("metric-total", String(total));
  text("metric-open", String(open));
  text("metric-blocked", String(blocked));
  text("metric-in-progress", String(inProgress));
  text("metric-done", String(done));
  text("metric-total-note", total === 1 ? "1 task stored" : `${total} tasks stored`);
  const p0 = state.tasks.filter((task) => task.priority === "P0").length;
  const p1 = state.tasks.filter((task) => task.priority === "P1").length;
  const p2 = state.tasks.filter((task) => task.priority === "P2" || !task.priority).length;
  const safeTotal = Math.max(total, 1);
  const p0End = Math.round((p0 / safeTotal) * 360);
  const p1End = p0End + Math.round((p1 / safeTotal) * 360);
  byId("priority-donut").style.background = `conic-gradient(var(--coral) 0 ${p0End}deg, var(--amber) ${p0End}deg ${p1End}deg, var(--blue) ${p1End}deg 360deg)`;
  byId("priority-list").innerHTML = [["P0", p0, "coral"], ["P1", p1, "amber"], ["P2", p2, "blue"]].map(([label, count, color]) => `<div><i class="${color}"></i><span>${label}</span><strong>${count}</strong></div>`).join("");
  const recent = [...state.tasks].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5);
  byId("activity-list").innerHTML = recent.length ? recent.map((task) => `<div class="activity-item"><span class="activity-dot status-${escapeHtml(task.status)}"></span><div><strong>${escapeHtml(activityLabel(task))}</strong><p>${escapeHtml(task.title)}</p></div><time>${escapeHtml(relativeTime(task.updatedAt))}</time></div>`).join("") : '<p class="muted">No activity yet.</p>';
}

async function renderSecondaryView(view: string) {
  if (view === "agents") {
    const data = await api("/api/settings/agents");
    byId("secondary-view").innerHTML = `<section class="panel secondary-panel"><div class="list-head"><div><h2>Agents</h2><p class="muted">Installed agent plugins and API credentials.</p></div><a class="link-button" href="/setup">Install plugin</a></div><div class="card-grid">${data.agents?.length ? data.agents.map(renderAgentCard).join("") : '<div class="empty-card">No agents configured yet.</div>'}</div></section>`;
    return;
  }
  if (view === "integrations") {
    const data = await api("/api/settings/github");
    const github = data.github || {};
    byId("secondary-view").innerHTML = `<section class="panel secondary-panel"><div class="list-head"><div><h2>Integrations</h2><p class="muted">GitHub sync and external entry points.</p></div><span class="toggle-pill">${github.enabled ? "Enabled" : "Disabled"}</span></div><div class="settings-grid">${settingTile("GitHub token", github.tokenConfigured ? "Configured" : "Missing", github.tokenConfigured ? "ok" : "warn")}${settingTile("Auto-create issues", github.autoCreateIssues ? "On" : "Off", github.autoCreateIssues ? "ok" : "neutral")}${settingTile("Rules", String((github.rules || []).length), "neutral")}${settingTile("Labels", (github.labels || []).join(", ") || "None", "neutral")}</div></section>`;
    return;
  }
  const data = await api("/api/setup/status");
  const storage = data.storage || {};
  byId("secondary-view").innerHTML = `<section class="panel secondary-panel"><div class="list-head"><div><h2>Settings</h2><p class="muted">Local runtime, storage, and channel policy state.</p></div><a class="link-button" href="/setup">Open setup</a></div><dl class="kv settings-kv"><dt>Setup locked</dt><dd>${escapeHtml(data.setupLocked ? "yes" : "no")}</dd><dt>Data dir</dt><dd>${escapeHtml(storage.dataDir || "")}</dd><dt>Tasks dir</dt><dd>${escapeHtml(storage.tasksDir || "")}</dd><dt>SQLite</dt><dd>${escapeHtml(storage.sqlitePath || "")}</dd><dt>Agents</dt><dd>${escapeHtml(String((data.agents || []).length))}</dd><dt>Channel policies</dt><dd>${escapeHtml(String((data.channelPolicies || []).length))}</dd></dl></section>`;
}

function renderTaskRow(task: Task) {
  return `<tr><td><button class="row-button" type="button" data-id="${task.id}">${escapeHtml(task.title)}</button><span>${escapeHtml(task.id)}</span></td><td><span class="priority priority-${escapeHtml(task.priority || "P2")}">${escapeHtml(task.priority || "P2")}</span></td><td><span class="status-pill status-${escapeHtml(task.status)}">${escapeHtml(task.status.replace("_", " "))}</span></td><td>${escapeHtml(task.assignee || "Unassigned")}</td><td><span class="source-pill">${escapeHtml(taskSource(task))}</span></td><td>${escapeHtml(relativeTime(task.updatedAt))}</td></tr>`;
}

function selectTask(id: string) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  state.selected = task;
  const statusOptions = statuses.map((status) => `<option value="${status}"${status === task.status ? " selected" : ""}>${status}</option>`).join("");
  const priorityOptions = priorities.map((priority) => `<option value="${priority}"${priority === task.priority ? " selected" : ""}>${priority}</option>`).join("");
  byId("detail").innerHTML = `<h2>${escapeHtml(task.title)}</h2><dl class="kv"><dt>ID</dt><dd>${escapeHtml(task.id)}</dd><dt>Slack</dt><dd>${escapeHtml(task.channelId || "")} ${escapeHtml(task.threadTs || "")}</dd><dt>Markdown</dt><dd>${escapeHtml(task.markdownPath || "")}</dd></dl><label>Priority <select id="priority-select">${priorityOptions}</select></label><label>Status <select id="status-select">${statusOptions}</select></label><label>Assignee <input id="assignee-input" value="${escapeAttr(task.assignee || "")}"></label><label>Reporter <input id="reporter-input" value="${escapeAttr(task.reporter || "")}"></label><label>Initiative <input id="initiative-input" value="${escapeAttr(task.initiative || "")}"></label><label>Next action <input id="next-action-input" value="${escapeAttr(task.nextAction || "")}"></label><label>GitHub ref <input id="github-ref-input" value="${escapeAttr(task.githubRef || "")}"></label><label>Description <textarea id="description-input" rows="8">${escapeHtml(task.description || "")}</textarea></label><button id="save-task" type="button">Save Changes</button><p id="detail-result" class="result"></p>`;
  byId("detail").classList.remove("hidden");
  byId("save-task").addEventListener("click", saveSelected);
}

async function saveSelected() {
  if (!state.selected) return;
  try {
    const data = await api(`/api/tasks/${state.selected.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: value("status-select"),
        priority: value("priority-select"),
        assignee: value("assignee-input"),
        reporter: value("reporter-input"),
        initiative: value("initiative-input"),
        nextAction: value("next-action-input"),
        githubRef: value("github-ref-input"),
        description: value("description-input")
      })
    });
    state.selected = data.task;
    setResult("detail-result", "Saved.");
    await loadTasks();
    selectTask(data.task.id);
  } catch (error) {
    setResult("detail-result", errorMessage(error), false);
  }
}

function renderAgentCard(agent: Record<string, unknown>) {
  return `<article class="entity-card"><h3>${escapeHtml(agent.name || agent.type || "Agent")}</h3><p>${escapeHtml(agent.type || "")} · ${escapeHtml(agent.status || "")}</p><dl><dt>Token</dt><dd>${escapeHtml(agent.apiTokenPreview || "not generated")}</dd><dt>Workspace</dt><dd>${escapeHtml(agent.workspacePath || "not set")}</dd></dl></article>`;
}

function settingTile(label: string, value: string, tone: string) {
  return `<div class="setting-tile ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function taskSource(task: Task) {
  if (task.githubRef) return "Issue";
  if (task.channelId || task.threadTs || task.sourceAgentName) return "Agent";
  return "Manual";
}
function activityLabel(task: Task) {
  if (task.status === "done") return "Task completed";
  if (task.status === "blocked") return "Task blocked";
  if (task.status === "in_progress") return "Task in progress";
  if (task.status === "proposed") return "Task proposed";
  return "Task updated";
}
function relativeTime(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return "";
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function setResult(id: string, message: string, ok = true) {
  const node = byId(id);
  node.textContent = message;
  node.className = ok ? "result ok" : "result error";
}
function byId(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}
function text(id: string, value: string) {
  byId(id).textContent = value;
}
function value(id: string) {
  return (byId(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
}
function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char] || char);
}
function escapeAttr(value: unknown) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

boot();
