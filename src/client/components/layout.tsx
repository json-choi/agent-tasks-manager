import {
  Bot,
  LayoutDashboard,
  ListTodo,
  LogIn,
  LogOut,
  PlugZap,
  RefreshCcw,
  Search,
  Settings,
  Wrench,
  type LucideIcon
} from "lucide-react";
import type { FormEvent } from "react";
import type { UiLanguage } from "../../shared/i18n";
import { searchPlaceholder } from "../lib/tasks";
import type { ResultMessage, Translator, View } from "../types";
import { LanguageSelect, ResultLine } from "./common";

const navViews: Array<{ view: View; label: string; Icon: LucideIcon }> = [
  { view: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { view: "tasks", label: "Tasks", Icon: ListTodo },
  { view: "agents", label: "Agents", Icon: Bot },
  { view: "integrations", label: "Integrations", Icon: PlugZap },
  { view: "settings", label: "Settings", Icon: Settings }
];

export function LoginScreen({
  isBooting,
  language,
  result,
  t,
  onLanguageChange,
  onLogin
}: {
  isBooting: boolean;
  language: UiLanguage;
  result: ResultMessage | null;
  t: Translator;
  onLanguageChange: (language: UiLanguage) => void;
  onLogin: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <main className="dashboard-shell">
      <section className="login-screen">
        <div className="login-brand">
          <div className="brand-lockup-inline">
            <img className="brand-avatar" src="/assets/brand/atm-persona.svg" alt="" />
            <div>
              <p className="eyebrow">{t("Agent Task Manager")}</p>
              <h1>{t("Task Console")}</h1>
            </div>
          </div>
          <LanguageSelect id="login-language" language={language} t={t} onChange={onLanguageChange} />
        </div>
        <form className="panel login" onSubmit={onLogin}>
          <p className="eyebrow">{t("Account")}</p>
          <h2>{t("Sign in")}</h2>
          <label htmlFor="login-email">
            {t("Email")}
            <input id="login-email" name="email" type="email" autoComplete="email" required />
          </label>
          <label htmlFor="login-password">
            {t("Password")}
            <input id="login-password" name="password" type="password" autoComplete="current-password" required />
          </label>
          <button type="submit" disabled={isBooting}>
            <LogIn className="icon" aria-hidden="true" />
            <span>{t("Login")}</span>
          </button>
          <ResultLine result={isBooting ? { text: "Checking session...", ok: true } : result} t={t} />
        </form>
      </section>
    </main>
  );
}

export function Sidebar({
  activeView,
  isOwner,
  t,
  onLogout,
  onViewChange
}: {
  activeView: View;
  isOwner: boolean;
  t: Translator;
  onLogout: () => void;
  onViewChange: (view: View) => void;
}) {
  const visibleNavViews = isOwner ? navViews : navViews.filter((item) => item.view === "dashboard" || item.view === "tasks");

  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <img className="app-nav-mark" src="/assets/brand/atm-persona.svg" alt="" />
        <div>
          <strong>ATM</strong>
          <span>{t("Agent Task Manager")}</span>
        </div>
      </div>
      <nav className="app-nav-left" aria-label="Primary">
        {visibleNavViews.map(({ view, label, Icon }) => (
          <button
            key={view}
            className={`app-tab${activeView === view ? " active" : ""}`}
            type="button"
            aria-current={activeView === view ? "page" : undefined}
            aria-label={t(label)}
            title={t(label)}
            onClick={() => onViewChange(view)}
          >
            <Icon className="icon" aria-hidden="true" />
            <span className="sr-only">{t(label)}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-actions">
        {isOwner ? <a className="link-button secondary-button icon-button" href="/setup" aria-label={t("Setup")} title={t("Setup")}>
          <Wrench className="icon" aria-hidden="true" />
          <span className="sr-only">{t("Setup")}</span>
        </a> : null}
        <button className="icon-button" type="button" aria-label={t("Logout")} title={t("Logout")} onClick={onLogout}>
          <LogOut className="icon" aria-hidden="true" />
          <span className="sr-only">{t("Logout")}</span>
        </button>
      </div>
    </aside>
  );
}

export function Topbar({
  language,
  search,
  view,
  t,
  onLanguageChange,
  onRefresh,
  onSearchChange
}: {
  language: UiLanguage;
  search: string;
  view: View;
  t: Translator;
  onLanguageChange: (language: UiLanguage) => void;
  onRefresh: () => void;
  onSearchChange: (value: string) => void;
}) {
  return (
    <header className="app-topbar">
      <div>
        <p className="eyebrow">{t("Workspace")}</p>
        <h1>{t("Task Console")}</h1>
      </div>
      <div className="toolbar-actions">
        <label className="search-box" htmlFor="task-search">
          <Search className="icon" aria-hidden="true" />
          <input
            id="task-search"
            aria-label={t("Search tasks...")}
            placeholder={t(searchPlaceholder(view))}
            value={search}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
          />
        </label>
        <LanguageSelect id="app-language" language={language} t={t} onChange={onLanguageChange} />
        <button className="icon-button" type="button" aria-label={t("Refresh")} title={t("Refresh")} onClick={onRefresh}>
          <RefreshCcw className="icon" aria-hidden="true" />
          <span className="sr-only">{t("Refresh")}</span>
        </button>
      </div>
    </header>
  );
}
