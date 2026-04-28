import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ResultLine, SettingTile } from "../components/common";
import { errorMessage } from "../lib/format";
import { checked, formField, parseGitHubRules, parseKeyValueLines, ruleToLine, splitList } from "../lib/forms";
import type { ApiClient, GitHubSettings, ResultMessage, Translator } from "../types";

export function IntegrationsView({ api, refreshKey, t }: { api: ApiClient; refreshKey: number; t: Translator }) {
  const [github, setGitHub] = useState<GitHubSettings | null>(null);
  const [result, setResult] = useState<ResultMessage | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadGitHub = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await api<{ github: GitHubSettings }>("/api/settings/github");
      setGitHub(data.github);
    } catch (error) {
      setResult({ text: errorMessage(error), ok: false });
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadGitHub();
  }, [loadGitHub, refreshKey]);

  async function onSaveGitHubSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;

    try {
      const data = await api<{ github: GitHubSettings }>("/api/settings/github", {
        method: "PATCH",
        body: JSON.stringify({
          enabled: checked(form, "enabled"),
          autoCreateIssues: checked(form, "autoCreateIssues"),
          autoUpdateTaskStatusFromGitHub: checked(form, "autoUpdateTaskStatusFromGitHub"),
          autoCompleteClosedIssues: checked(form, "autoCompleteClosedIssues"),
          labels: splitList(formField(form, "labels")),
          rules: parseGitHubRules(formField(form, "rules")),
          assigneesByOwner: parseKeyValueLines(formField(form, "assigneesByOwner"))
        })
      });
      setGitHub(data.github);
      setResult({ text: `Saved GitHub settings at ${data.github.updatedAt}.`, ok: true });
    } catch (error) {
      setResult({ text: errorMessage(error), ok: false });
    }
  }

  async function runGitHubSyncNow() {
    try {
      const data = await api<{ status: string; summary: unknown }>("/api/integrations/github/sync", { method: "POST", body: "{}" });
      setResult({ text: `Sync ${data.status}: ${JSON.stringify(data.summary)}`, ok: data.status !== "error" });
    } catch (error) {
      setResult({ text: errorMessage(error), ok: false });
    }
  }

  return (
    <section className="secondary-view">
      <section className="panel secondary-panel">
        <div className="list-head">
          <div>
            <h2>{t("Integrations")}</h2>
            <p className="muted">{t("GitHub sync and external entry points.")}</p>
          </div>
          {github ? <span className="toggle-pill">{t(github.enabled ? "Enabled" : "Disabled")}</span> : null}
        </div>

        {isLoading || !github ? <p className="muted">{t("Loading...")}</p> : (
          <>
            <div className="settings-grid">
              <SettingTile label="GitHub token" t={t} tone={github.tokenConfigured ? "ok" : "warn"} value={github.tokenConfigured ? "Configured" : "Missing"} />
              <SettingTile label="Auto-create issues" t={t} tone={github.autoCreateIssues ? "ok" : "neutral"} value={github.autoCreateIssues ? "On" : "Off"} />
              <SettingTile label="Rules" t={t} tone="neutral" value={String((github.rules || []).length)} />
              <SettingTile label="Labels" t={t} tone="neutral" value={(github.labels || []).join(", ") || "None"} />
            </div>
            <form key={github.updatedAt || "github"} className="settings-form" onSubmit={onSaveGitHubSettings}>
              <div className="check-grid">
                <label className="check-row" htmlFor="github-enabled">
                  <input id="github-enabled" name="enabled" type="checkbox" defaultChecked={github.enabled} />
                  <span>{t("Enable GitHub sync")}</span>
                </label>
                <label className="check-row" htmlFor="github-auto-create">
                  <input id="github-auto-create" name="autoCreateIssues" type="checkbox" defaultChecked={github.autoCreateIssues} />
                  <span>{t("Auto-create issues")}</span>
                </label>
                <label className="check-row" htmlFor="github-auto-status">
                  <input id="github-auto-status" name="autoUpdateTaskStatusFromGitHub" type="checkbox" defaultChecked={github.autoUpdateTaskStatusFromGitHub} />
                  <span>{t("Update task status from GitHub")}</span>
                </label>
                <label className="check-row" htmlFor="github-auto-close">
                  <input id="github-auto-close" name="autoCompleteClosedIssues" type="checkbox" defaultChecked={github.autoCompleteClosedIssues} />
                  <span>{t("Complete closed issues")}</span>
                </label>
              </div>
              <label htmlFor="github-labels">
                {t("Labels")}
                <input id="github-labels" name="labels" defaultValue={(github.labels || []).join(", ")} placeholder="task-manager, agent" />
              </label>
              <label htmlFor="github-rules">
                {t("Rules")}
                <textarea id="github-rules" name="rules" rows={4} defaultValue={(github.rules || []).map(ruleToLine).join("\n")} placeholder="owner/repo | project-label | initiative words | code indicators" />
              </label>
              <label htmlFor="github-assignees">
                {t("Assignees by owner")}
                <textarea id="github-assignees" name="assigneesByOwner" rows={4} defaultValue={Object.entries(github.assigneesByOwner || {}).map(([owner, gh]) => `${owner}=${gh}`).join("\n")} placeholder="Alice=alice-gh" />
              </label>
              <div className="button-row">
                <button type="submit">{t("Save GitHub Settings")}</button>
                <button type="button" onClick={runGitHubSyncNow}>{t("Run Sync")}</button>
              </div>
              <ResultLine result={result} t={t} />
            </form>
          </>
        )}
      </section>
    </section>
  );
}
