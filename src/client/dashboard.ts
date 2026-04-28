import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleDot,
  ClipboardList,
  Cloud,
  Copy,
  Database,
  GitBranch,
  LayoutDashboard,
  ListTodo,
  LogOut,
  Pencil,
  PlugZap,
  Plus,
  RefreshCcw,
  RotateCw,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  Wrench,
  createElement as createLucideElement
} from "lucide";
import {
  parseUiLanguage,
  translateDom,
  translateText,
  uiLanguageLabels,
  uiLanguages,
  uiLanguageStorageKey,
  type UiLanguage
} from "../shared/i18n";

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

type Agent = {
  id: string;
  type: "hermes" | "openclaw";
  name: string;
  apiTokenPreview?: string | null;
  cliPath?: string | null;
  configPath?: string | null;
  workspacePath?: string | null;
  status: string;
  lastSeenAt?: string | null;
  updatedAt: string;
};

type OwnerMapping = {
  id: string;
  ownerName: string;
  slackUserId?: string | null;
  aliases: string[];
  active: boolean;
  updatedAt: string;
};

type ChannelPolicy = {
  channelId: string;
  mode: string;
  updatedAt: string;
};

type GitHubRule = {
  repo: string;
  projectLabel?: string;
  initiativeIncludes?: string[];
  codeIndicators?: string[];
};

type GitHubSettings = {
  enabled: boolean;
  autoCreateIssues: boolean;
  autoUpdateTaskStatusFromGitHub: boolean;
  autoCompleteClosedIssues: boolean;
  tokenConfigured: boolean;
  rules: GitHubRule[];
  labels: string[];
  assigneesByOwner: Record<string, string>;
  updatedAt: string | null;
};

type PublicAccessSettings = {
  provider: "cloudflare";
  mode: "quick" | "remote";
  publicUrl: string | null;
  localServiceUrl: string;
  tunnelName: string | null;
  tunnelTokenConfigured: boolean;
  tunnelTokenPreview: string | null;
  accessProtected: boolean;
  updatedAt: string | null;
};

const state: {
  token: string;
  tasks: Task[];
  people: OwnerMapping[];
  selected: Task | null;
  search: string;
  view: string;
  language: UiLanguage;
} = {
  token: localStorage.getItem("tm_admin_token") || "",
  tasks: [],
  people: [],
  selected: null,
  search: "",
  view: "dashboard",
  language: initialUiLanguage()
};

const statuses = ["proposed", "confirmed", "assigning", "in_progress", "blocked", "review_needed", "done", "cancelled"];
const priorities = ["P0", "P1", "P2"];
const taskViews = ["dashboard", "tasks"];
const navViews = [
  ["dashboard", "Dashboard", "dashboard"],
  ["tasks", "Tasks", "tasks"],
  ["agents", "Agents", "agents"],
  ["integrations", "Integrations", "integrations"],
  ["settings", "Settings", "settings"]
] as const;

const iconMap = {
  activity: Activity,
  agents: Bot,
  blocked: AlertTriangle,
  check: CheckCircle2,
  cloud: Cloud,
  copy: Copy,
  dashboard: LayoutDashboard,
  database: Database,
  edit: Pencil,
  integrations: PlugZap,
  issue: GitBranch,
  logout: LogOut,
  open: CircleDot,
  plus: Plus,
  refresh: RefreshCcw,
  regenerate: RotateCw,
  search: Search,
  settings: Settings,
  shield: ShieldCheck,
  tasks: ListTodo,
  trash: Trash2,
  users: Users,
  wrench: Wrench
} as const;

type IconName = keyof typeof iconMap;
type IconNode = Parameters<typeof createLucideElement>[0];

function boot() {
  const root = document.getElementById("app");
  if (!root) return;
  root.innerHTML = layout();
  bindEvents();
  localizeApp();
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

function icon(name: IconName, className = "icon") {
  return createLucideElement(iconMap[name] as IconNode, {
    class: className,
    width: "18",
    height: "18",
    "aria-hidden": "true"
  }).outerHTML;
}

function iconOnly(name: IconName, label: string) {
  return `${icon(name)}<span class="sr-only">${escapeHtml(label)}</span>`;
}

function iconLabel(name: IconName, label: string) {
  return `${icon(name)}<span>${escapeHtml(label)}</span>`;
}

function navButton(view: string, label: string, iconName: IconName) {
  return `<button class="app-tab ${view === "dashboard" ? "active" : ""}" type="button" data-view="${view}" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">${iconOnly(iconName, label)}</button>`;
}

function initialUiLanguage(): UiLanguage {
  const storedLanguage = localStorage.getItem(uiLanguageStorageKey);
  if (storedLanguage) return parseUiLanguage(storedLanguage);
  return parseUiLanguage(navigator.language?.split("-")[0]);
}

function t(value: string) {
  return translateText(value, state.language);
}

function languageSelect(id: string) {
  return `<label class="language-control" aria-label="${escapeAttr(t("Language"))}">
    <span class="sr-only">${escapeHtml(t("Language"))}</span>
    <select id="${escapeAttr(id)}" data-language-select aria-label="${escapeAttr(t("Language"))}">
      ${uiLanguages.map((language) => `<option value="${language}"${language === state.language ? " selected" : ""}>${escapeHtml(uiLanguageLabels[language])}</option>`).join("")}
    </select>
  </label>`;
}

function slackPeople() {
  return state.people.filter((owner) => owner.active && owner.slackUserId);
}

function ownerOptions(emptyLabel: string, selected = "") {
  const people = slackPeople();
  const selectedValue = selected.trim();
  const emptySelected = selectedValue ? "" : " selected";
  const options = [`<option value=""${emptySelected}>${escapeHtml(emptyLabel)}</option>`];
  options.push(
    ...people.map((owner) => {
      const label = `${owner.ownerName} (${owner.slackUserId})`;
      return `<option value="${escapeAttr(owner.ownerName)}"${owner.ownerName === selectedValue ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
  );
  if (!people.length) {
    options.push(`<option value="" disabled>${escapeHtml("Add Slack users in Settings first")}</option>`);
  }
  return options.join("");
}

function bindLanguageControls() {
  document.querySelectorAll("[data-language-select]").forEach((node) => {
    node.addEventListener("change", () => {
      const language = parseUiLanguage((node as HTMLSelectElement).value);
      setUiLanguage(language);
    });
  });
}

function setUiLanguage(language: UiLanguage) {
  state.language = language;
  localStorage.setItem(uiLanguageStorageKey, language);
  localizeApp();
}

function syncLanguageControls() {
  document.querySelectorAll("[data-language-select]").forEach((node) => {
    (node as HTMLSelectElement).value = state.language;
  });
}

function localizeApp() {
  document.documentElement.lang = state.language;
  syncLanguageControls();
  translateDom(document.body, state.language);
}

function layout() {
  return `
    <main class="dashboard-shell">
      <section id="login-screen" class="login-screen">
        <div class="login-brand">
          <div class="brand-lockup-inline">
            <img class="brand-avatar" src="/assets/brand/atm-persona.svg" alt="">
            <div>
              <p class="eyebrow">Agent Task Manager</p>
              <h1>Task Console</h1>
            </div>
          </div>
          ${languageSelect("login-language")}
        </div>
        <form id="login-form" class="panel login">
          <p class="eyebrow">Admin</p>
          <h2>Sign in</h2>
          <label>Email <input name="email" type="email" autocomplete="email" required></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
          <button type="submit">Login</button>
          <p id="login-result" class="result"></p>
        </form>
      </section>
      <section id="app-view" class="app-shell-frame hidden">
        <aside class="app-sidebar">
          <div class="sidebar-brand">
            <img class="app-nav-mark" src="/assets/brand/atm-persona.svg" alt="">
            <div><strong>ATM</strong><span>Agent Task Manager</span></div>
          </div>
          <nav class="app-nav-left" aria-label="Primary">
            ${navViews.map(([view, label, iconName]) => navButton(view, label, iconName)).join("")}
          </nav>
          <div class="sidebar-actions">
            <a class="link-button secondary-button icon-button" href="/setup" aria-label="Setup" title="Setup">${iconOnly("wrench", "Setup")}</a>
            <button id="logout" class="icon-button" type="button" aria-label="Logout" title="Logout">${iconOnly("logout", "Logout")}</button>
          </div>
        </aside>
        <section class="app-main">
          <header class="app-topbar">
            <div>
              <p class="eyebrow">Workspace</p>
              <h1>Task Console</h1>
            </div>
            <div class="toolbar-actions">
              <label class="search-box" aria-label="Search tasks">${icon("search")}<input id="task-search" aria-label="Search tasks" placeholder="Search tasks..."></label>
              ${languageSelect("app-language")}
              <button id="refresh" class="icon-button" type="button" aria-label="Refresh" title="Refresh">${iconOnly("refresh", "Refresh")}</button>
            </div>
          </header>
          <section id="task-dashboard">
            <section class="focus-summary" aria-label="Task focus">
              <article class="focus-card danger">${icon("blocked")}<span>Blocked</span><strong id="metric-blocked">0</strong></article>
              <article class="focus-card blue">${icon("activity")}<span>Progress</span><strong id="metric-in-progress">0</strong></article>
              <article class="focus-card">${icon("open")}<span>Open</span><strong id="metric-open">0</strong></article>
            </section>
            <section class="app-shell-grid">
              <section class="panel task-table-panel">
                <div class="list-head">
                  <div><h2 id="task-panel-title">Tasks</h2><p id="task-panel-subtitle" class="muted">Markdown index</p></div>
                  <button id="new-task-toggle" type="button" aria-label="New task" title="New task">${iconLabel("plus", "New")}</button>
                </div>
                <form id="task-form" class="composer hidden">
                  <div class="composer-grid">
                    <label>Title <input name="title" required></label>
                    <label>Assignee <select name="assignee">${ownerOptions("No assignee")}</select></label>
                    <label>Priority <select name="priority"><option value="P2">P2</option><option value="P1">P1</option><option value="P0">P0</option></select></label>
                    <label>Status <select name="status"><option value="confirmed">confirmed</option><option value="proposed">proposed</option><option value="in_progress">in_progress</option></select></label>
                    <label>Reporter <select name="reporter">${ownerOptions("No reporter")}</select></label>
                    <label>GitHub ref <input name="githubRef" placeholder="owner/repo#123"></label>
                  </div>
                  <label class="description-field">Description <textarea name="description" rows="3"></textarea></label>
                  <label class="next-action-field">Next action <input name="nextAction" placeholder="Concrete next step"></label>
                  <button class="composer-submit" type="submit">Create Task</button>
                  <p id="task-result" class="result"></p>
                </form>
                <table><thead><tr><th>Task</th><th>Priority</th><th>Status</th><th>Owner</th><th>Source</th><th>Updated</th></tr></thead><tbody id="task-list"></tbody></table>
              </section>
            </section>
            <details class="insight-disclosure">
              <summary><span><strong>Context</strong><small>Recent activity and priority mix</small></span></summary>
              <div class="insight-grid">
                <section><h2>Recent activity</h2><div id="activity-list" class="activity-list"></div></section>
                <section><h2>Priority</h2><div class="priority-summary"><div id="priority-donut" class="priority-donut"></div><div id="priority-list" class="priority-list"></div></div></section>
              </div>
            </details>
            <section id="detail" class="panel detail-panel hidden"></section>
          </section>
          <section id="secondary-view" class="secondary-view hidden"></section>
        </section>
      </section>
    </main>
  `;
}

function bindEvents() {
  bindLanguageControls();
  byId("login-form").addEventListener("submit", onLogin);
  byId("task-form").addEventListener("submit", onCreateTask);
  byId("refresh").addEventListener("click", () => {
    if (taskViews.includes(state.view)) {
      loadTasks();
      return;
    }
    renderActiveView();
  });
  byId("task-search").addEventListener("input", (event) => {
    state.search = (event.currentTarget as HTMLInputElement).value;
    if (taskViews.includes(state.view)) {
      renderTasks();
      return;
    }
    renderActiveView();
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
    const [tasksData, ownersData] = await Promise.all([api("/api/tasks"), api("/api/settings/owners")]);
    state.tasks = tasksData.tasks || [];
    state.people = ownersData.owners || [];
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
  byId("task-dashboard").classList.toggle("hidden", !taskViews.includes(state.view));
  byId("secondary-view").classList.toggle("hidden", taskViews.includes(state.view));
  byId("app-view").classList.toggle("view-tasks", state.view === "tasks");
  (byId("task-search") as HTMLInputElement).placeholder = searchPlaceholder(state.view);
  if (taskViews.includes(state.view)) {
    renderTasks();
    localizeApp();
    return;
  }
  byId("detail").classList.add("hidden");
  await renderSecondaryView(state.view);
  localizeApp();
}

function renderTasks() {
  syncTaskFormPeople();
  text("task-panel-title", state.view === "tasks" ? "All tasks" : "Focus queue");
  text("task-panel-subtitle", state.view === "tasks" ? "Search, create, and edit Markdown-backed tasks." : "Open work, highest risk first.");
  renderDashboardSummary();
  const query = state.search.trim().toLowerCase();
  const matchingTasks = query ? state.tasks.filter((task) => [task.title, task.id, task.status, task.assignee, task.reporter, task.githubRef].filter(Boolean).some((value) => String(value).toLowerCase().includes(query))) : state.tasks;
  const tasks = state.view === "tasks" ? matchingTasks : focusTasks(matchingTasks).slice(0, 8);
  byId("task-list").innerHTML = tasks.length ? tasks.map(renderTaskRow).join("") : '<tr><td colspan="6" class="empty-state">No tasks need attention in this view.</td></tr>';
  document.querySelectorAll("#task-list [data-id]").forEach((node) => node.addEventListener("click", () => selectTask((node as HTMLElement).dataset.id || "")));
  localizeApp();
}

function syncTaskFormPeople() {
  const form = document.getElementById("task-form") as HTMLFormElement | null;
  if (!form) return;
  const assignee = form.elements.namedItem("assignee") as HTMLSelectElement | null;
  const reporter = form.elements.namedItem("reporter") as HTMLSelectElement | null;
  if (assignee) assignee.innerHTML = ownerOptions("No assignee", assignee.value);
  if (reporter) reporter.innerHTML = ownerOptions("No reporter", reporter.value);
}

function renderDashboardSummary() {
  const total = state.tasks.length;
  const open = state.tasks.filter((task) => !["done", "cancelled"].includes(task.status)).length;
  const blocked = state.tasks.filter((task) => task.status === "blocked").length;
  const inProgress = state.tasks.filter((task) => task.status === "in_progress").length;
  text("metric-open", String(open));
  text("metric-blocked", String(blocked));
  text("metric-in-progress", String(inProgress));
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

function focusTasks(tasks: Task[]) {
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

async function renderSecondaryView(view: string) {
  if (view === "agents") {
    await renderAgentsView();
    return;
  }
  if (view === "integrations") {
    await renderIntegrationsView();
    return;
  }
  await renderSettingsView();
}

async function renderAgentsView() {
  const data = await api("/api/settings/agents");
  const agents = filterRecords<Agent>(data.agents || [], ["id", "name", "type", "status", "workspacePath", "apiTokenPreview"]);
  byId("secondary-view").innerHTML = `<section class="panel secondary-panel"><div class="list-head"><div><h2>Agents</h2><p class="muted">Installed plugins.</p></div><a class="link-button" href="/setup">${iconLabel("plus", "Install")}</a></div><form id="agent-settings-form" class="settings-form"><input type="hidden" name="id"><div class="form-grid"><label>Type <select name="type"><option value="hermes">hermes</option><option value="openclaw">openclaw</option></select></label><label>Name <input name="name" placeholder="Agent name"></label><label>CLI path <input name="cliPath" placeholder="hermes"></label><label>Config path <input name="configPath" placeholder="/opt/agent/config.yml"></label><label>Workspace path <input name="workspacePath" placeholder="/opt/agent"></label><label class="check-row"><input name="regenerateToken" type="checkbox"> Regenerate token</label></div><div class="button-row"><button type="submit">${iconLabel("check", "Save")}</button><button id="agent-form-clear" class="icon-button" type="button" aria-label="Clear" title="Clear">${iconOnly("refresh", "Clear")}</button></div><p id="agent-settings-result" class="result"></p></form><div class="card-grid">${agents.length ? agents.map(renderAgentCard).join("") : '<div class="empty-card">No agents match this view.</div>'}</div></section>`;
  const form = byId("agent-settings-form") as HTMLFormElement;
  form.addEventListener("submit", onSaveAgent);
  byId("agent-form-clear").addEventListener("click", () => {
    form.reset();
    form.elements.namedItem("id") && ((form.elements.namedItem("id") as HTMLInputElement).value = "");
  });
  document.querySelectorAll("[data-agent-edit]").forEach((button) => {
    button.addEventListener("click", () => fillAgentForm(agents.find((agent) => agent.id === (button as HTMLElement).dataset.agentEdit)));
  });
  document.querySelectorAll("[data-agent-regen]").forEach((button) => {
    button.addEventListener("click", () => regenerateAgentToken(agents.find((agent) => agent.id === (button as HTMLElement).dataset.agentRegen)));
  });
  document.querySelectorAll("[data-agent-uninstall]").forEach((button) => {
    button.addEventListener("click", () => uninstallAgent(agents.find((agent) => agent.id === (button as HTMLElement).dataset.agentUninstall)));
  });
}

async function renderIntegrationsView() {
  const data = await api("/api/settings/github");
  const github = data.github as GitHubSettings;
  byId("secondary-view").innerHTML = `<section class="panel secondary-panel"><div class="list-head"><div><h2>Integrations</h2><p class="muted">GitHub sync and external entry points.</p></div><span class="toggle-pill">${github.enabled ? "Enabled" : "Disabled"}</span></div><div class="settings-grid">${settingTile("GitHub token", github.tokenConfigured ? "Configured" : "Missing", github.tokenConfigured ? "ok" : "warn")}${settingTile("Auto-create issues", github.autoCreateIssues ? "On" : "Off", github.autoCreateIssues ? "ok" : "neutral")}${settingTile("Rules", String((github.rules || []).length), "neutral")}${settingTile("Labels", (github.labels || []).join(", ") || "None", "neutral")}</div><form id="github-settings-form" class="settings-form"><div class="check-grid"><label class="check-row"><input name="enabled" type="checkbox"${github.enabled ? " checked" : ""}> Enable GitHub sync</label><label class="check-row"><input name="autoCreateIssues" type="checkbox"${github.autoCreateIssues ? " checked" : ""}> Auto-create issues</label><label class="check-row"><input name="autoUpdateTaskStatusFromGitHub" type="checkbox"${github.autoUpdateTaskStatusFromGitHub ? " checked" : ""}> Update task status from GitHub</label><label class="check-row"><input name="autoCompleteClosedIssues" type="checkbox"${github.autoCompleteClosedIssues ? " checked" : ""}> Complete closed issues</label></div><label>Labels <input name="labels" value="${escapeAttr((github.labels || []).join(", "))}" placeholder="task-manager, agent"></label><label>Rules <textarea name="rules" rows="4" placeholder="owner/repo | project-label | initiative words | code indicators">${escapeHtml((github.rules || []).map(ruleToLine).join("\n"))}</textarea></label><label>Assignees by owner <textarea name="assigneesByOwner" rows="4" placeholder="Alice=alice-gh">${escapeHtml(Object.entries(github.assigneesByOwner || {}).map(([owner, gh]) => `${owner}=${gh}`).join("\n"))}</textarea></label><div class="button-row"><button type="submit">Save GitHub Settings</button><button id="github-sync-now" type="button">Run Sync</button></div><p id="github-settings-result" class="result"></p></form></section>`;
  byId("github-settings-form").addEventListener("submit", onSaveGitHubSettings);
  byId("github-sync-now").addEventListener("click", runGitHubSyncNow);
}

async function renderSettingsView() {
  const data = await api("/api/setup/status");
  const publicAccessData = await api("/api/setup/public-access");
  const ownersData = await api("/api/settings/owners");
  const channelsData = await api("/api/settings/channels");
  const storage = data.storage || {};
  const publicAccess = publicAccessData.publicAccess as PublicAccessSettings;
  const owners = filterRecords<OwnerMapping>(ownersData.owners || [], ["ownerName", "slackUserId", "aliases"]);
  const policies = filterRecords<ChannelPolicy>(channelsData.policies || [], ["channelId", "mode"]);
  byId("secondary-view").innerHTML = `<div class="settings-page"><section class="panel runtime-panel"><div class="list-head"><div><h2>Runtime</h2><p class="muted">Local storage and setup state.</p></div><a class="link-button secondary-button" href="/setup">Open setup</a></div><dl class="kv settings-kv"><dt>Setup locked</dt><dd>${escapeHtml(data.setupLocked ? "yes" : "no")}</dd><dt>Data dir</dt><dd>${escapeHtml(storage.dataDir || "")}</dd><dt>Tasks dir</dt><dd>${escapeHtml(storage.tasksDir || "")}</dd><dt>SQLite</dt><dd>${escapeHtml(storage.sqlitePath || "")}</dd><dt>Agents</dt><dd>${escapeHtml(String((data.agents || []).length))}</dd><dt>Policies</dt><dd>${escapeHtml(String((data.channelPolicies || []).length))}</dd></dl><div class="button-row"><button id="storage-check-dashboard" type="button">Check Storage</button></div><p id="storage-dashboard-result" class="result"></p></section><section class="panel permissions-panel"><h2>Slack Permissions</h2><p class="muted">${data.review?.slackPermissionsReviewedAt ? `Reviewed at ${escapeHtml(data.review.slackPermissionsReviewedAt)}` : "Not reviewed yet."}</p><div class="button-row"><button id="permissions-review-dashboard" type="button">Mark Reviewed</button><button id="permissions-clear-dashboard" type="button">Clear Review</button></div><p id="permissions-dashboard-result" class="result"></p></section><section class="panel wide-panel public-access-panel"><div class="list-head"><div><h2>Public Access</h2><p class="muted">Cloudflare Tunnel access for the local dashboard.</p></div><span class="toggle-pill">${publicAccess.publicUrl ? "Configured" : "Not configured"}</span></div><div class="settings-grid public-status-grid">${settingTile("Provider", "Cloudflare", "neutral")}${settingTile("Mode", publicAccess.mode === "remote" ? "Production" : "Quick preview", "neutral")}${settingTile("Access", publicAccess.accessProtected ? "Protected" : "Needs Access", publicAccess.accessProtected ? "ok" : "warn")}${settingTile("cloudflared", publicAccessData.diagnostics?.installed ? "Installed" : "Missing", publicAccessData.diagnostics?.installed ? "ok" : "warn")}${settingTile("Tunnel token", publicAccess.tunnelTokenConfigured ? (publicAccess.tunnelTokenPreview || "Provided") : "Missing", publicAccess.tunnelTokenConfigured ? "ok" : "warn")}${settingTile("Public URL", publicAccess.publicUrl || "Not set", publicAccess.publicUrl ? "ok" : "neutral")}</div><form id="public-access-form" class="settings-form"><div class="form-grid"><label>Mode <select name="mode"><option value="quick"${publicAccess.mode === "quick" ? " selected" : ""}>Quick Tunnel preview</option><option value="remote"${publicAccess.mode === "remote" ? " selected" : ""}>Production tunnel token</option></select></label><label>Local service URL <input name="localServiceUrl" value="${escapeAttr(publicAccess.localServiceUrl || "")}" placeholder="http://localhost:3011"></label><label>Public URL <input name="publicUrl" value="${escapeAttr(publicAccess.publicUrl || "")}" placeholder="https://tasks.example.com"></label><label>Tunnel name <input name="tunnelName" value="${escapeAttr(publicAccess.tunnelName || "")}" placeholder="agent-task-manager"></label><label class="check-row"><input name="accessProtected" type="checkbox"${publicAccess.accessProtected ? " checked" : ""}> Cloudflare Access protects this hostname</label><label class="check-row"><input name="clearTunnelToken" type="checkbox"> Clear token status</label></div><label>Cloudflare install command or tunnel token <textarea name="tunnelToken" rows="3" autocomplete="off" spellcheck="false" placeholder="cloudflared service install ey..."></textarea></label><div class="button-row"><button type="submit">Save Public Access</button><button id="public-access-test" type="button">Check Public URL</button></div><p id="public-access-result" class="result"></p></form><div class="command-grid">${commandBlock("Quick Tunnel", "public-quick-command", publicAccessData.guide?.quickTunnelCommand || "")}${commandBlock("Production Run", "public-run-command", publicAccessData.guide?.remoteRunCommand || "Paste a token and save to generate this command.")}${commandBlock("Install Service", "public-service-command", publicAccessData.guide?.serviceInstallCommand || "Paste a token and save to generate this command.")}</div></section><section class="panel wide-panel owners-panel"><div class="list-head"><div><h2>Owners</h2><p class="muted">Map human owners to Slack users and aliases.</p></div></div><form id="owner-form" class="settings-form"><input type="hidden" name="id"><div class="form-grid"><label>Owner name <input name="ownerName" required></label><label>Slack user ID <input name="slackUserId" placeholder="U0123456789"></label><label>Aliases <input name="aliases" placeholder="alice, ali"></label><label class="check-row"><input name="active" type="checkbox" checked> Active</label></div><div class="button-row"><button type="submit">Save Owner</button><button id="owner-form-clear" type="button">Clear</button></div><p id="owner-result" class="result"></p></form><div class="compact-list">${owners.length ? owners.map(renderOwnerItem).join("") : '<div class="empty-card">No owners match this view.</div>'}</div></section><section class="panel wide-panel channel-policy-panel"><h2>Channel Policies</h2><p class="muted">Manual by default; suggestions only where expected.</p><form id="channel-policy-form" class="settings-form"><div class="form-grid"><label>Slack channel ID <input name="channelId" required placeholder="C0123456789"></label><label>Mode <select name="mode"><option value="manual_only">manual_only</option><option value="suggest_only">suggest_only</option></select></label></div><button type="submit">Save Policy</button><p id="channel-policy-result" class="result"></p></form><div class="compact-list">${policies.length ? policies.map(renderChannelPolicyItem).join("") : '<div class="empty-card">No channel policies match this view.</div>'}</div></section></div>`;
  bindSettingsEvents(owners, policies);
}

function renderTaskRow(task: Task) {
  const source = taskSource(task);
  return `<tr><td><button class="row-button" type="button" data-id="${task.id}">${escapeHtml(task.title)}</button><span>${escapeHtml(task.id)}</span></td><td><span class="priority priority-${escapeHtml(task.priority || "P2")}">${escapeHtml(task.priority || "P2")}</span></td><td><span class="status-pill status-${escapeHtml(task.status)}">${escapeHtml(task.status.replace("_", " "))}</span></td><td>${escapeHtml(task.assignee || "Unassigned")}</td><td><span class="source-pill icon-pill" title="${escapeAttr(source)}" aria-label="${escapeAttr(source)}">${icon(taskSourceIcon(task))}<span class="sr-only">${escapeHtml(source)}</span></span></td><td>${escapeHtml(relativeTime(task.updatedAt))}</td></tr>`;
}

function selectTask(id: string) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  state.selected = task;
  const statusOptions = statuses.map((status) => `<option value="${status}"${status === task.status ? " selected" : ""}>${status}</option>`).join("");
  const priorityOptions = priorities.map((priority) => `<option value="${priority}"${priority === task.priority ? " selected" : ""}>${priority}</option>`).join("");
  byId("detail").innerHTML = `<h2>${escapeHtml(task.title)}</h2><dl class="kv detail-meta"><dt>ID</dt><dd>${escapeHtml(task.id)}</dd><dt>Slack</dt><dd>${escapeHtml(task.channelId || "")} ${escapeHtml(task.threadTs || "")}</dd><dt>Markdown</dt><dd>${escapeHtml(task.markdownPath || "")}</dd></dl><div class="detail-grid"><label>Priority <select id="priority-select">${priorityOptions}</select></label><label>Status <select id="status-select">${statusOptions}</select></label><label>Assignee <select id="assignee-input">${ownerOptions("Unassigned", task.assignee || "")}</select></label><label>Reporter <select id="reporter-input">${ownerOptions("No reporter", task.reporter || "")}</select></label><label>GitHub ref <input id="github-ref-input" value="${escapeAttr(task.githubRef || "")}"></label><label>Initiative <input id="initiative-input" value="${escapeAttr(task.initiative || "")}"></label><label class="wide-field">Next action <input id="next-action-input" value="${escapeAttr(task.nextAction || "")}"></label><label class="wide-field">Description <textarea id="description-input" rows="5">${escapeHtml(task.description || "")}</textarea></label></div><div class="button-row"><button id="save-task" type="button">Save Changes</button></div><p id="detail-result" class="result"></p>`;
  byId("detail").classList.remove("hidden");
  byId("save-task").addEventListener("click", saveSelected);
  localizeApp();
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
  return `<article class="entity-card"><h3>${escapeHtml(agent.name || agent.type || "Agent")}</h3><p>${escapeHtml(agent.type || "")} · ${escapeHtml(agent.status || "")}</p><dl><dt>ID</dt><dd>${escapeHtml(agent.id || "")}</dd><dt>Token</dt><dd>${escapeHtml(agent.apiTokenPreview || "not generated")}</dd><dt>Workspace</dt><dd>${escapeHtml(agent.workspacePath || "not set")}</dd><dt>Updated</dt><dd>${escapeHtml(relativeTime(String(agent.updatedAt || "")))}</dd></dl><div class="card-actions"><button class="icon-button" type="button" data-agent-edit="${escapeAttr(agent.id || "")}" aria-label="Edit agent" title="Edit">${iconOnly("edit", "Edit")}</button><button class="icon-button" type="button" data-agent-regen="${escapeAttr(agent.id || "")}" aria-label="Regenerate token" title="Regenerate token">${iconOnly("regenerate", "Regenerate token")}</button><button class="icon-button danger-button" type="button" data-agent-uninstall="${escapeAttr(agent.id || "")}" aria-label="Uninstall agent" title="Uninstall">${iconOnly("trash", "Uninstall")}</button></div></article>`;
}

function settingTile(label: string, value: string, tone: string) {
  return `<div class="setting-tile ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function commandBlock(title: string, id: string, command: string) {
  return `<div class="command-card"><div class="command-head"><h3>${escapeHtml(title)}</h3><button class="icon-button" type="button" data-copy-command="${escapeAttr(id)}" aria-label="Copy ${escapeAttr(title)}" title="Copy">${iconOnly("copy", "Copy")}</button></div><pre id="${escapeAttr(id)}" class="commands">${escapeHtml(command)}</pre></div>`;
}

async function onSaveAgent(event: Event) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  try {
    const payload = formPayload(form);
    payload.regenerateToken = (form.elements.namedItem("regenerateToken") as HTMLInputElement).checked;
    const data = await api("/api/settings/agents", { method: "PATCH", body: JSON.stringify(payload) });
    const tokenLine = data.token ? `\nToken: ${data.token}` : "";
    setResult("agent-settings-result", `Saved ${data.agent.name}.${tokenLine}`);
    await renderAgentsView();
  } catch (error) {
    setResult("agent-settings-result", errorMessage(error), false);
  }
}

function fillAgentForm(agent?: Agent) {
  if (!agent) return;
  const form = byId("agent-settings-form") as HTMLFormElement;
  setFormField(form, "id", agent.id);
  setFormField(form, "type", agent.type);
  setFormField(form, "name", agent.name);
  setFormField(form, "cliPath", agent.cliPath || "");
  setFormField(form, "configPath", agent.configPath || "");
  setFormField(form, "workspacePath", agent.workspacePath || "");
  (form.elements.namedItem("regenerateToken") as HTMLInputElement).checked = false;
  setResult("agent-settings-result", `Editing ${agent.name}.`);
}

async function regenerateAgentToken(agent?: Agent) {
  if (!agent) return;
  try {
    const data = await api("/api/settings/agents", {
      method: "PATCH",
      body: JSON.stringify({ id: agent.id, type: agent.type, regenerateToken: true })
    });
    setResult("agent-settings-result", `Token regenerated for ${data.agent.name}.\nToken: ${data.token}`);
    await renderAgentsView();
  } catch (error) {
    setResult("agent-settings-result", errorMessage(error), false);
  }
}

async function uninstallAgent(agent?: Agent) {
  if (!agent) return;
  if (!confirm(`Uninstall ${agent.name} plugin and revoke its token?`)) return;
  try {
    const data = await api("/api/setup/agent/uninstall", {
      method: "POST",
      body: JSON.stringify({ id: agent.id, type: agent.type, workspacePath: agent.workspacePath, cliPath: agent.cliPath, runReload: false })
    });
    setResult("agent-settings-result", data.ok ? `Uninstalled ${agent.name}.` : `Uninstall finished with diagnostics for ${agent.name}.`, data.ok);
    await renderAgentsView();
  } catch (error) {
    setResult("agent-settings-result", errorMessage(error), false);
  }
}

async function onSaveGitHubSettings(event: Event) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  try {
    const data = await api("/api/settings/github", {
      method: "PATCH",
      body: JSON.stringify({
        enabled: (form.elements.namedItem("enabled") as HTMLInputElement).checked,
        autoCreateIssues: (form.elements.namedItem("autoCreateIssues") as HTMLInputElement).checked,
        autoUpdateTaskStatusFromGitHub: (form.elements.namedItem("autoUpdateTaskStatusFromGitHub") as HTMLInputElement).checked,
        autoCompleteClosedIssues: (form.elements.namedItem("autoCompleteClosedIssues") as HTMLInputElement).checked,
        labels: splitList(formField(form, "labels")),
        rules: parseGitHubRules(formField(form, "rules")),
        assigneesByOwner: parseKeyValueLines(formField(form, "assigneesByOwner"))
      })
    });
    setResult("github-settings-result", `Saved GitHub settings at ${data.github.updatedAt}.`);
    await renderIntegrationsView();
  } catch (error) {
    setResult("github-settings-result", errorMessage(error), false);
  }
}

async function runGitHubSyncNow() {
  try {
    const data = await api("/api/integrations/github/sync", { method: "POST", body: "{}" });
    setResult("github-settings-result", `Sync ${data.status}: ${JSON.stringify(data.summary)}`, data.status !== "error");
  } catch (error) {
    setResult("github-settings-result", errorMessage(error), false);
  }
}

function bindSettingsEvents(owners: OwnerMapping[], policies: ChannelPolicy[]) {
  byId("storage-check-dashboard").addEventListener("click", checkStorageFromDashboard);
  byId("permissions-review-dashboard").addEventListener("click", () => savePermissionsReview(true));
  byId("permissions-clear-dashboard").addEventListener("click", () => savePermissionsReview(false));
  byId("public-access-form").addEventListener("submit", onSavePublicAccess);
  byId("public-access-test").addEventListener("click", testPublicAccess);
  document.querySelectorAll("[data-copy-command]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = byId((button as HTMLElement).dataset.copyCommand || "");
      await navigator.clipboard.writeText(target.textContent || "");
      button.innerHTML = iconOnly("check", "Copied");
      setTimeout(() => {
        button.innerHTML = iconOnly("copy", "Copy");
      }, 1200);
    });
  });
  const ownerForm = byId("owner-form") as HTMLFormElement;
  ownerForm.addEventListener("submit", onSaveOwner);
  byId("owner-form-clear").addEventListener("click", () => ownerForm.reset());
  document.querySelectorAll("[data-owner-edit]").forEach((button) => {
    button.addEventListener("click", () => fillOwnerForm(owners.find((owner) => owner.id === (button as HTMLElement).dataset.ownerEdit)));
  });
  const channelForm = byId("channel-policy-form") as HTMLFormElement;
  channelForm.addEventListener("submit", onSaveChannelPolicy);
  document.querySelectorAll("[data-channel-edit]").forEach((button) => {
    button.addEventListener("click", () => fillChannelForm(policies.find((policy) => policy.channelId === (button as HTMLElement).dataset.channelEdit)));
  });
}

async function checkStorageFromDashboard() {
  try {
    const data = await api("/api/setup/storage/check", { method: "POST", body: "{}" });
    setResult("storage-dashboard-result", `Storage ready: ${data.storage.dataDir}`);
  } catch (error) {
    setResult("storage-dashboard-result", errorMessage(error), false);
  }
}

async function savePermissionsReview(reviewed: boolean) {
  try {
    const data = await api("/api/setup/review", { method: "PATCH", body: JSON.stringify({ slackPermissionsReviewed: reviewed }) });
    setResult("permissions-dashboard-result", data.review.slackPermissionsReviewedAt ? `Reviewed at ${data.review.slackPermissionsReviewedAt}.` : "Review cleared.");
    await renderSettingsView();
  } catch (error) {
    setResult("permissions-dashboard-result", errorMessage(error), false);
  }
}

async function onSavePublicAccess(event: Event) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  try {
    const data = await api("/api/setup/public-access", {
      method: "PATCH",
      body: JSON.stringify({
        mode: formField(form, "mode"),
        localServiceUrl: formField(form, "localServiceUrl"),
        publicUrl: formField(form, "publicUrl"),
        tunnelName: formField(form, "tunnelName"),
        tunnelToken: formField(form, "tunnelToken"),
        accessProtected: (form.elements.namedItem("accessProtected") as HTMLInputElement).checked,
        clearTunnelToken: (form.elements.namedItem("clearTunnelToken") as HTMLInputElement).checked
      })
    });
    setResult("public-access-result", data.publicAccess.publicUrl ? "Public access settings saved." : "Settings saved. Add the Cloudflare public hostname when ready.");
    await renderSettingsView();
  } catch (error) {
    setResult("public-access-result", errorMessage(error), false);
  }
}

async function testPublicAccess() {
  const form = byId("public-access-form") as HTMLFormElement;
  try {
    const data = await api("/api/setup/public-access/test", {
      method: "POST",
      body: JSON.stringify({ publicUrl: formField(form, "publicUrl") })
    });
    setResult("public-access-result", data.skipped ? "Add a public URL first." : `Health status: ${data.status}`, data.ok);
  } catch (error) {
    setResult("public-access-result", errorMessage(error), false);
  }
}

async function onSaveOwner(event: Event) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  try {
    const payload = formPayload(form);
    payload.aliases = splitList(formField(form, "aliases"));
    payload.active = (form.elements.namedItem("active") as HTMLInputElement).checked;
    const data = await api("/api/settings/owners", { method: "POST", body: JSON.stringify(payload) });
    setResult("owner-result", `Saved owner ${data.owner.ownerName}.`);
    await renderSettingsView();
  } catch (error) {
    setResult("owner-result", errorMessage(error), false);
  }
}

function fillOwnerForm(owner?: OwnerMapping) {
  if (!owner) return;
  const form = byId("owner-form") as HTMLFormElement;
  setFormField(form, "id", owner.id);
  setFormField(form, "ownerName", owner.ownerName);
  setFormField(form, "slackUserId", owner.slackUserId || "");
  setFormField(form, "aliases", owner.aliases.join(", "));
  (form.elements.namedItem("active") as HTMLInputElement).checked = owner.active;
  setResult("owner-result", `Editing ${owner.ownerName}.`);
}

async function onSaveChannelPolicy(event: Event) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  try {
    const payload = formPayload(form);
    const data = await api("/api/settings/channels", { method: "PATCH", body: JSON.stringify(payload) });
    setResult("channel-policy-result", `${data.policy.channelId} set to ${data.policy.mode}.`);
    await renderSettingsView();
  } catch (error) {
    setResult("channel-policy-result", errorMessage(error), false);
  }
}

function fillChannelForm(policy?: ChannelPolicy) {
  if (!policy) return;
  const form = byId("channel-policy-form") as HTMLFormElement;
  setFormField(form, "channelId", policy.channelId);
  setFormField(form, "mode", policy.mode);
  setResult("channel-policy-result", `Editing ${policy.channelId}.`);
}

function renderOwnerItem(owner: OwnerMapping) {
  return `<article class="compact-item"><div><strong>${escapeHtml(owner.ownerName)}</strong><span>${escapeHtml(owner.active ? "active" : "inactive")} · ${escapeHtml(owner.slackUserId || "no Slack user")} · ${escapeHtml(owner.aliases.join(", ") || "no aliases")}</span></div><button class="icon-button" type="button" data-owner-edit="${escapeAttr(owner.id)}" aria-label="Edit owner" title="Edit">${iconOnly("edit", "Edit")}</button></article>`;
}

function renderChannelPolicyItem(policy: ChannelPolicy) {
  return `<article class="compact-item"><div><strong>${escapeHtml(policy.channelId)}</strong><span>${escapeHtml(policy.mode)} · ${escapeHtml(relativeTime(policy.updatedAt))}</span></div><button class="icon-button" type="button" data-channel-edit="${escapeAttr(policy.channelId)}" aria-label="Edit channel policy" title="Edit">${iconOnly("edit", "Edit")}</button></article>`;
}

function ruleToLine(rule: GitHubRule) {
  return [rule.repo, rule.projectLabel || "", (rule.initiativeIncludes || []).join(","), (rule.codeIndicators || []).join(",")].join(" | ").replace(/\s+\|\s+\|\s+\|$/, "");
}

function parseGitHubRules(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [repo = "", projectLabel = "", initiativeIncludes = "", codeIndicators = ""] = line.split("|").map((part) => part.trim());
    return {
      repo,
      ...(projectLabel ? { projectLabel } : {}),
      ...(initiativeIncludes ? { initiativeIncludes: splitList(initiativeIncludes) } : {}),
      ...(codeIndicators ? { codeIndicators: splitList(codeIndicators) } : {})
    };
  }).filter((rule) => rule.repo);
}

function parseKeyValueLines(value: string) {
  return Object.fromEntries(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [key = "", ...rest] = line.split("=");
    return [key.trim(), rest.join("=").trim()];
  }).filter(([key, val]) => Boolean(key && val)));
}

function taskSource(task: Task) {
  if (task.githubRef) return "Issue";
  if (task.channelId || task.threadTs || task.sourceAgentName) return "Agent";
  return "Manual";
}
function taskSourceIcon(task: Task): IconName {
  if (task.githubRef) return "issue";
  if (task.channelId || task.threadTs || task.sourceAgentName) return "agents";
  return "edit";
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
function searchPlaceholder(view: string) {
  if (view === "tasks") return "Search all tasks...";
  if (view === "agents") return "Search agents...";
  if (view === "integrations") return "Search integrations...";
  if (view === "settings") return "Search settings...";
  return "Search tasks...";
}
function setResult(id: string, message: string, ok = true) {
  const node = byId(id);
  node.textContent = t(message);
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
function formPayload(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form).entries()) as Record<string, unknown>;
}
function formField(form: HTMLFormElement, name: string) {
  const item = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return item?.value ?? "";
}
function setFormField(form: HTMLFormElement, name: string, val: string) {
  const item = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (item) item.value = val;
}
function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
function filterRecords<T extends object>(items: T[], fields: string[]) {
  const query = state.search.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) => fields.some((field) => String((item as Record<string, unknown>)[field] ?? "").toLowerCase().includes(query)));
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
