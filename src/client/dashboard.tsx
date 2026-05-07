import { StrictMode, useCallback, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { parseUiLanguage, translateText, uiLanguageStorageKey, type UiLanguage } from "../shared/i18n";
import { LoginScreen, Sidebar, Topbar } from "./components/layout";
import { apiRequest } from "./lib/api";
import { errorMessage } from "./lib/format";
import { formPayload } from "./lib/forms";
import { insertTaskIntoBoardState, reconcileTaskBoardDropState, taskViews } from "./lib/tasks";
import type { ApiClient, AuthSessionPayload, OwnerMapping, ResultMessage, Task, View } from "./types";
import { AgentsView } from "./views/agents-view";
import { IntegrationsView } from "./views/integrations-view";
import { SettingsView } from "./views/settings-view";
import { TaskWorkspace } from "./views/tasks-view";

function DashboardApp() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const [session, setSession] = useState<AuthSessionPayload | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [people, setPeople] = useState<OwnerMapping[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("dashboard");
  const [language, setLanguage] = useState<UiLanguage>(initialUiLanguage);
  const [loginResult, setLoginResult] = useState<ResultMessage | null>(null);
  const [secondaryRefreshKey, setSecondaryRefreshKey] = useState(0);

  const t = useCallback((value: string) => translateText(value, language), [language]);
  const api = useCallback<ApiClient>((path, options) => apiRequest(path, options), []);

  const loadTasks = useCallback(async () => {
    const sessionData = await apiRequest<AuthSessionPayload>("/api/auth/session");
    const [tasksData, ownersData] = await Promise.all([
      apiRequest<{ tasks: Task[] }>("/api/tasks"),
      sessionData.role === "owner"
        ? apiRequest<{ owners: OwnerMapping[] }>("/api/settings/owners")
        : Promise.resolve({ owners: sessionData.owner ? [sessionData.owner] : [] })
    ]);
    setSession(sessionData);
    setTasks(tasksData.tasks || []);
    setPeople(ownersData.owners || []);
    setIsAuthenticated(true);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    localStorage.setItem(uiLanguageStorageKey, language);
  }, [language]);

  useEffect(() => {
    let cancelled = false;

    async function bootSession() {
      setIsBooting(true);
      try {
        await loadTasks();
      } catch (error) {
        if (cancelled) return;
        setIsAuthenticated(false);
        setLoginResult({ text: errorMessage(error), ok: false });
      } finally {
        if (!cancelled) setIsBooting(false);
      }
    }

    void bootSession();
    return () => {
      cancelled = true;
    };
  }, [loadTasks]);

  useEffect(() => {
    if (selectedId && !tasks.some((task) => task.id === selectedId)) {
      setSelectedId(null);
      setSelectedMemberId(null);
    }
  }, [selectedId, tasks]);

  const onSelectTask = useCallback((id: string | null, memberId?: string | null) => {
    setSelectedId(id);
    setSelectedMemberId((currentMemberId) => {
      if (!id) return null;
      return memberId === undefined ? currentMemberId : memberId;
    });
  }, []);

  const onTaskUpdated = useCallback((updatedTask: Task) => {
    setTasks((currentTasks) => reconcileTaskBoardDropState(currentTasks, updatedTask));
  }, []);

  useEffect(() => {
    if (session?.role === "member" && !taskViews.includes(view)) {
      setView("dashboard");
    }
  }, [session?.role, view]);

  async function onLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginResult(null);
    const form = event.currentTarget;

    try {
      const data = await apiRequest<AuthSessionPayload>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(formPayload(form))
      });

      setSession(data);
      setLoginResult({ text: "Logged in.", ok: true });
      await loadTasks();
    } catch (error) {
      setLoginResult({ text: errorMessage(error), ok: false });
    }
  }

  async function onLogout() {
    await apiRequest("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => null);
    setSession(null);
    setTasks([]);
    setPeople([]);
    onSelectTask(null);
    setIsAuthenticated(false);
  }

  async function onRefresh() {
    if (taskViews.includes(view)) {
      await loadTasks();
      return;
    }
    setSecondaryRefreshKey((key) => key + 1);
  }

  async function onCreateTask(event: FormEvent<HTMLFormElement>): Promise<Task | null> {
    event.preventDefault();
    const form = event.currentTarget;

    try {
      const data = await api<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(formPayload(form)) });
      form.reset();
      setTasks((currentTasks) => insertTaskIntoBoardState(currentTasks, data.task));
      return data.task;
    } catch (error) {
      throw error;
    }
  }

  if (!isAuthenticated) {
    return (
      <LoginScreen
        isBooting={isBooting}
        language={language}
        result={loginResult}
        t={t}
        onLanguageChange={setLanguage}
        onLogin={onLogin}
      />
    );
  }

  const selectedTask = selectedId ? tasks.find((task) => task.id === selectedId) ?? null : null;
  const isOwner = session?.role === "owner";

  return (
    <main className="dashboard-shell">
      <section className={`app-shell-frame view-${view}`}>
        <Sidebar activeView={view} isOwner={isOwner} t={t} onLogout={onLogout} onViewChange={setView} />
        <section className="app-main">
          <Topbar
            language={language}
            search={search}
            view={view}
            t={t}
            onLanguageChange={setLanguage}
            onRefresh={onRefresh}
            onSearchChange={setSearch}
          />
          {taskViews.includes(view) ? (
            <TaskWorkspace
              api={api}
              isOwner={isOwner}
              people={people}
              search={search}
              selectedMemberId={selectedMemberId}
              selectedTask={selectedTask}
              tasks={tasks}
              t={t}
              view={view}
              onCreateTask={onCreateTask}
              onReloadTasks={loadTasks}
              onSelectTask={onSelectTask}
              onTaskUpdated={onTaskUpdated}
            />
          ) : (
            <SecondaryView api={api} refreshKey={secondaryRefreshKey} search={search} t={t} view={view} />
          )}
        </section>
      </section>
    </main>
  );
}

function SecondaryView({
  api,
  refreshKey,
  search,
  t,
  view
}: {
  api: ApiClient;
  refreshKey: number;
  search: string;
  t: (value: string) => string;
  view: View;
}) {
  if (view === "agents") return <AgentsView api={api} refreshKey={refreshKey} search={search} t={t} />;
  if (view === "integrations") return <IntegrationsView api={api} refreshKey={refreshKey} t={t} />;
  return <SettingsView api={api} refreshKey={refreshKey} search={search} t={t} />;
}

function initialUiLanguage(): UiLanguage {
  const storedLanguage = localStorage.getItem(uiLanguageStorageKey);
  if (storedLanguage) return parseUiLanguage(storedLanguage);
  return parseUiLanguage(navigator.language?.split("-")[0]);
}

const root = document.getElementById("app");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <DashboardApp />
    </StrictMode>
  );
}
