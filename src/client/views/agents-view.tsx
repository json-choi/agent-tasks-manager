import { CheckCircle2, Pencil, Plus, RefreshCcw, RotateCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ResultLine } from "../components/common";
import { errorMessage, relativeTime } from "../lib/format";
import { formPayload } from "../lib/forms";
import { filterRecords } from "../lib/tasks";
import type { Agent, ApiClient, ResultMessage, Translator } from "../types";

export function AgentsView({ api, refreshKey, search, t }: { api: ApiClient; refreshKey: number; search: string; t: Translator }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [result, setResult] = useState<ResultMessage | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadAgents = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await api<{ agents: Agent[] }>("/api/settings/agents");
      setAgents(data.agents || []);
    } catch (error) {
      setResult({ text: errorMessage(error), ok: false });
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents, refreshKey]);

  async function onSaveAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = formPayload(form);
    payload.regenerateToken = (form.elements.namedItem("regenerateToken") as HTMLInputElement).checked;

    try {
      const data = await api<{ agent: Agent; token?: string }>("/api/settings/agents", {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      const tokenLine = data.token ? `\nToken: ${data.token}` : "";
      setResult({ text: `Saved ${data.agent.name}.${tokenLine}`, ok: true });
      setEditingAgent(null);
      await loadAgents();
    } catch (error) {
      setResult({ text: errorMessage(error), ok: false });
    }
  }

  async function regenerateAgentToken(agent: Agent) {
    try {
      const data = await api<{ agent: Agent; token?: string }>("/api/settings/agents", {
        method: "PATCH",
        body: JSON.stringify({ id: agent.id, type: agent.type, regenerateToken: true })
      });
      setResult({ text: `Token regenerated for ${data.agent.name}.\nToken: ${data.token || ""}`, ok: true });
      await loadAgents();
    } catch (error) {
      setResult({ text: errorMessage(error), ok: false });
    }
  }

  async function uninstallAgent(agent: Agent) {
    if (!confirm(`Uninstall ${agent.name} plugin and revoke its token?`)) return;
    try {
      const data = await api<{ ok: boolean }>("/api/setup/agent/uninstall", {
        method: "POST",
        body: JSON.stringify({
          id: agent.id,
          type: agent.type,
          workspacePath: agent.workspacePath,
          cliPath: agent.cliPath,
          runReload: false
        })
      });
      setResult({
        text: data.ok ? `Uninstalled ${agent.name}.` : `Uninstall finished with diagnostics for ${agent.name}.`,
        ok: data.ok
      });
      await loadAgents();
    } catch (error) {
      setResult({ text: errorMessage(error), ok: false });
    }
  }

  const filteredAgents = filterRecords(agents, ["id", "name", "type", "status", "workspacePath", "apiTokenPreview"], search);

  return (
    <section className="secondary-view">
      <section className="panel secondary-panel">
        <div className="list-head">
          <div>
            <h2>{t("Agents")}</h2>
            <p className="muted">{t("Installed agent plugins and API credentials.")}</p>
          </div>
          <a className="link-button" href="/setup">
            <Plus className="icon" aria-hidden="true" />
            <span>{t("Install plugin")}</span>
          </a>
        </div>

        <form key={editingAgent?.id || "new-agent"} className="settings-form" onSubmit={onSaveAgent}>
          <input type="hidden" name="id" defaultValue={editingAgent?.id || ""} />
          <div className="form-grid">
            <label htmlFor="agent-type">
              {t("Type")}
              <select id="agent-type" name="type" defaultValue={editingAgent?.type || "hermes"}>
                <option value="hermes">hermes</option>
                <option value="openclaw">openclaw</option>
              </select>
            </label>
            <label htmlFor="agent-name">
              {t("Name")}
              <input id="agent-name" name="name" defaultValue={editingAgent?.name || ""} placeholder={t("Agent name")} />
            </label>
            <label htmlFor="agent-cli-path">
              {t("CLI path")}
              <input id="agent-cli-path" name="cliPath" defaultValue={editingAgent?.cliPath || ""} placeholder="hermes" />
            </label>
            <label htmlFor="agent-config-path">
              {t("Config path")}
              <input id="agent-config-path" name="configPath" defaultValue={editingAgent?.configPath || ""} placeholder="/opt/agent/config.yml" />
            </label>
            <label htmlFor="agent-workspace-path">
              {t("Workspace path")}
              <input id="agent-workspace-path" name="workspacePath" defaultValue={editingAgent?.workspacePath || ""} placeholder="/opt/agent" />
            </label>
            <label className="check-row" htmlFor="agent-regenerate-token">
              <input id="agent-regenerate-token" name="regenerateToken" type="checkbox" />
              <span>{t("Regenerate token")}</span>
            </label>
          </div>
          <div className="button-row">
            <button type="submit">
              <CheckCircle2 className="icon" aria-hidden="true" />
              <span>{t("Save Agent")}</span>
            </button>
            <button className="icon-button secondary-button" type="button" aria-label={t("Clear")} title={t("Clear")} onClick={() => setEditingAgent(null)}>
              <RefreshCcw className="icon" aria-hidden="true" />
              <span className="sr-only">{t("Clear")}</span>
            </button>
          </div>
          <ResultLine result={result} t={t} />
        </form>

        {isLoading ? <p className="muted">{t("Loading...")}</p> : null}
        <div className="card-grid">
          {filteredAgents.length ? filteredAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              t={t}
              onEdit={setEditingAgent}
              onRegenerate={regenerateAgentToken}
              onUninstall={uninstallAgent}
            />
          )) : <div className="empty-card">{t("No agents match this view.")}</div>}
        </div>
      </section>
    </section>
  );
}

function AgentCard({
  agent,
  t,
  onEdit,
  onRegenerate,
  onUninstall
}: {
  agent: Agent;
  t: Translator;
  onEdit: (agent: Agent) => void;
  onRegenerate: (agent: Agent) => void;
  onUninstall: (agent: Agent) => void;
}) {
  return (
    <article className="entity-card">
      <h3>{agent.name || agent.type}</h3>
      <p>{agent.type} · {agent.status}</p>
      <dl>
        <dt>{t("ID")}</dt>
        <dd>{agent.id}</dd>
        <dt>{t("Token")}</dt>
        <dd>{agent.apiTokenPreview || t("not generated")}</dd>
        <dt>{t("Workspace")}</dt>
        <dd>{agent.workspacePath || t("not set")}</dd>
        <dt>{t("Updated")}</dt>
        <dd>{relativeTime(agent.updatedAt)}</dd>
      </dl>
      <div className="card-actions">
        <button className="icon-button" type="button" aria-label={t("Edit")} title={t("Edit")} onClick={() => onEdit(agent)}>
          <Pencil className="icon" aria-hidden="true" />
          <span className="sr-only">{t("Edit")}</span>
        </button>
        <button className="icon-button" type="button" aria-label={t("Regenerate token")} title={t("Regenerate token")} onClick={() => onRegenerate(agent)}>
          <RotateCw className="icon" aria-hidden="true" />
          <span className="sr-only">{t("Regenerate token")}</span>
        </button>
        <button className="icon-button danger-button" type="button" aria-label={t("Uninstall")} title={t("Uninstall")} onClick={() => onUninstall(agent)}>
          <Trash2 className="icon" aria-hidden="true" />
          <span className="sr-only">{t("Uninstall")}</span>
        </button>
      </div>
    </article>
  );
}
