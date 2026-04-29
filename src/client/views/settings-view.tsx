import { Pencil, Send, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CommandBlock, ResultLine, SettingTile } from "../components/common";
import { display, displayBoolean, errorMessage, relativeTime } from "../lib/format";
import { checked, formField, formPayload, splitList } from "../lib/forms";
import { filterRecords } from "../lib/tasks";
import type { ApiClient, ChannelPolicy, MemberInvitation, OwnerMapping, PublicAccessPayload, ResultMessage, SetupStatus, Translator } from "../types";

export function SettingsView({ api, refreshKey, search, t }: { api: ApiClient; refreshKey: number; search: string; t: Translator }) {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [publicAccessPayload, setPublicAccessPayload] = useState<PublicAccessPayload | null>(null);
  const [owners, setOwners] = useState<OwnerMapping[]>([]);
  const [invitations, setInvitations] = useState<MemberInvitation[]>([]);
  const [policies, setPolicies] = useState<ChannelPolicy[]>([]);
  const [editingOwner, setEditingOwner] = useState<OwnerMapping | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<ChannelPolicy | null>(null);
  const [result, setResult] = useState<Record<string, ResultMessage | null>>({});
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const publicAccessFormRef = useRef<HTMLFormElement | null>(null);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const [setupData, publicAccessData, ownersData, invitesData, channelsData] = await Promise.all([
        api<SetupStatus>("/api/setup/status"),
        api<PublicAccessPayload>("/api/setup/public-access"),
        api<{ owners: OwnerMapping[] }>("/api/settings/owners"),
        api<{ invitations: MemberInvitation[] }>("/api/settings/member-invites"),
        api<{ policies: ChannelPolicy[] }>("/api/settings/channels")
      ]);
      setSetup(setupData);
      setPublicAccessPayload(publicAccessData);
      setOwners(ownersData.owners || []);
      setInvitations(invitesData.invitations || []);
      setPolicies(channelsData.policies || []);
    } catch (error) {
      setResult((current) => ({ ...current, settings: { text: errorMessage(error), ok: false } }));
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings, refreshKey]);

  async function checkStorageFromDashboard() {
    try {
      const data = await api<{ storage: Record<string, unknown> }>("/api/setup/storage/check", { method: "POST", body: "{}" });
      setResultMessage("storage", { text: `Storage ready: ${display(data.storage.dataDir)}`, ok: true });
    } catch (error) {
      setResultMessage("storage", { text: errorMessage(error), ok: false });
    }
  }

  async function savePermissionsReview(reviewed: boolean) {
    try {
      const data = await api<{ review: { slackPermissionsReviewedAt?: string | null } }>("/api/setup/review", {
        method: "PATCH",
        body: JSON.stringify({ slackPermissionsReviewed: reviewed })
      });
      setResultMessage("permissions", {
        text: data.review.slackPermissionsReviewedAt ? `Reviewed at ${data.review.slackPermissionsReviewedAt}.` : "Review cleared.",
        ok: true
      });
      await loadSettings();
    } catch (error) {
      setResultMessage("permissions", { text: errorMessage(error), ok: false });
    }
  }

  async function onSavePublicAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;

    try {
      const data = await api<PublicAccessPayload>("/api/setup/public-access", {
        method: "PATCH",
        body: JSON.stringify({
          mode: formField(form, "mode"),
          localServiceUrl: formField(form, "localServiceUrl"),
          publicUrl: formField(form, "publicUrl"),
          tunnelName: formField(form, "tunnelName"),
          tunnelToken: formField(form, "tunnelToken"),
          accessProtected: checked(form, "accessProtected"),
          clearTunnelToken: checked(form, "clearTunnelToken")
        })
      });
      setPublicAccessPayload(data);
      setResultMessage("publicAccess", {
        text: data.publicAccess.publicUrl ? "Public access settings saved." : "Settings saved. Add the Cloudflare public hostname when ready.",
        ok: true
      });
      await loadSettings();
    } catch (error) {
      setResultMessage("publicAccess", { text: errorMessage(error), ok: false });
    }
  }

  async function testPublicAccess() {
    const form = publicAccessFormRef.current;
    if (!form) return;
    try {
      const data = await api<{ skipped?: boolean; ok: boolean; status?: string }>("/api/setup/public-access/test", {
        method: "POST",
        body: JSON.stringify({ publicUrl: formField(form, "publicUrl") })
      });
      setResultMessage("publicAccess", {
        text: data.skipped ? "Add a public URL first." : `Health status: ${data.status}`,
        ok: data.ok
      });
    } catch (error) {
      setResultMessage("publicAccess", { text: errorMessage(error), ok: false });
    }
  }

  async function onSaveOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = formPayload(form);
    payload.aliases = splitList(formField(form, "aliases"));
    payload.active = checked(form, "active");

    try {
      const data = await api<{ owner: OwnerMapping }>("/api/settings/owners", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setResultMessage("owner", { text: `Saved owner ${data.owner.ownerName}.`, ok: true });
      setEditingOwner(null);
      await loadSettings();
    } catch (error) {
      setResultMessage("owner", { text: errorMessage(error), ok: false });
    }
  }

  async function sendMemberInvites(resend: boolean) {
    try {
      const data = await api<{ invitations: MemberInvitation[]; outbox: unknown[]; skipped: Array<{ reason: string }> }>("/api/settings/member-invites", {
        method: "POST",
        body: JSON.stringify({ resend })
      });
      setResultMessage("invites", {
        text: `${data.invitations.length} invitation DM${data.invitations.length === 1 ? "" : "s"} queued. ${data.skipped.length} skipped.`,
        ok: true
      });
      await loadSettings();
    } catch (error) {
      setResultMessage("invites", { text: errorMessage(error), ok: false });
    }
  }

  async function revokeInvite(id: string) {
    try {
      await api<{ invitation: MemberInvitation }>(`/api/settings/member-invites/${id}/revoke`, {
        method: "POST",
        body: "{}"
      });
      setResultMessage("invites", { text: "Invitation revoked.", ok: true });
      await loadSettings();
    } catch (error) {
      setResultMessage("invites", { text: errorMessage(error), ok: false });
    }
  }

  async function onSaveChannelPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;

    try {
      const data = await api<{ policy: ChannelPolicy }>("/api/settings/channels", {
        method: "PATCH",
        body: JSON.stringify(formPayload(form))
      });
      setResultMessage("channel", { text: `${data.policy.channelId} set to ${data.policy.mode}.`, ok: true });
      setEditingPolicy(null);
      await loadSettings();
    } catch (error) {
      setResultMessage("channel", { text: errorMessage(error), ok: false });
    }
  }

  async function copyCommand(id: string, command: string) {
    await navigator.clipboard.writeText(command);
    setCopiedCommand(id);
    window.setTimeout(() => setCopiedCommand((current) => current === id ? null : current), 1200);
  }

  function setResultMessage(id: string, message: ResultMessage) {
    setResult((current) => ({ ...current, [id]: message }));
  }

  const publicAccess = publicAccessPayload?.publicAccess;
  const storage = setup?.storage || {};
  const filteredOwners = filterRecords(owners, ["ownerName", "slackUserId", "aliases"], search);
  const filteredInvitations = filterRecords(invitations, ["ownerName", "slackUserId", "status", "email"], search);
  const filteredPolicies = filterRecords(policies, ["channelId", "mode"], search);

  return (
    <section className="secondary-view">
      {isLoading || !setup || !publicAccess ? <section className="panel secondary-panel"><p className="muted">{t("Loading...")}</p><ResultLine result={result.settings} t={t} /></section> : (
        <div className="settings-page">
          <section className="panel runtime-panel">
            <div className="list-head">
              <div>
                <h2>{t("Runtime")}</h2>
                <p className="muted">{t("Local storage and setup state.")}</p>
              </div>
              <a className="link-button secondary-button" href="/setup">{t("Open setup")}</a>
            </div>
            <dl className="kv settings-kv">
              <dt>{t("Setup locked")}</dt>
              <dd>{displayBoolean(setup.setupLocked)}</dd>
              <dt>{t("Data dir")}</dt>
              <dd>{display(storage.dataDir)}</dd>
              <dt>{t("Tasks dir")}</dt>
              <dd>{display(storage.tasksDir)}</dd>
              <dt>{t("SQLite")}</dt>
              <dd>{display(storage.sqlitePath)}</dd>
              <dt>{t("Agents")}</dt>
              <dd>{String((setup.agents || []).length)}</dd>
              <dt>{t("Policies")}</dt>
              <dd>{String((setup.channelPolicies || []).length)}</dd>
            </dl>
            <div className="button-row">
              <button type="button" onClick={checkStorageFromDashboard}>{t("Check Storage")}</button>
            </div>
            <ResultLine result={result.storage} t={t} />
          </section>

          <section className="panel permissions-panel">
            <h2>{t("Slack Permissions")}</h2>
            <p className="muted">
              {setup.review?.slackPermissionsReviewedAt ? `Reviewed at ${setup.review.slackPermissionsReviewedAt}` : t("Not reviewed yet.")}
            </p>
            <div className="button-row">
              <button type="button" onClick={() => savePermissionsReview(true)}>{t("Mark Reviewed")}</button>
              <button type="button" onClick={() => savePermissionsReview(false)}>{t("Clear Review")}</button>
            </div>
            <ResultLine result={result.permissions} t={t} />
          </section>

          <section className="panel wide-panel public-access-panel">
            <div className="list-head">
              <div>
                <h2>{t("Public Access")}</h2>
                <p className="muted">{t("Cloudflare Tunnel access for the local dashboard.")}</p>
              </div>
              <span className="toggle-pill">{t(publicAccess.publicUrl ? "Configured" : "Not configured")}</span>
            </div>
            <div className="settings-grid public-status-grid">
              <SettingTile label="Provider" t={t} tone="neutral" value="Cloudflare" />
              <SettingTile label="Mode" t={t} tone="neutral" value={publicAccess.mode === "remote" ? "Production" : "Quick preview"} />
              <SettingTile label="Access" t={t} tone={publicAccess.accessProtected ? "ok" : "warn"} value={publicAccess.accessProtected ? "Protected" : "Needs Access"} />
              <SettingTile label="cloudflared" t={t} tone={publicAccessPayload?.diagnostics?.installed ? "ok" : "warn"} value={publicAccessPayload?.diagnostics?.installed ? "Installed" : "Missing"} />
              <SettingTile label="Tunnel token" t={t} tone={publicAccess.tunnelTokenConfigured ? "ok" : "warn"} value={publicAccess.tunnelTokenConfigured ? publicAccess.tunnelTokenPreview || "Provided" : "Missing"} />
              <SettingTile label="Public URL" t={t} tone={publicAccess.publicUrl ? "ok" : "neutral"} value={publicAccess.publicUrl || "Not set"} />
            </div>
            <form id="public-access-form" ref={publicAccessFormRef} key={publicAccess.updatedAt || "public-access"} className="settings-form" onSubmit={onSavePublicAccess}>
              <div className="form-grid">
                <label htmlFor="public-mode">
                  {t("Mode")}
                  <select id="public-mode" name="mode" defaultValue={publicAccess.mode}>
                    <option value="quick">{t("Quick Tunnel preview")}</option>
                    <option value="remote">{t("Production tunnel token")}</option>
                  </select>
                </label>
                <label htmlFor="local-service-url">
                  {t("Local service URL")}
                  <input id="local-service-url" name="localServiceUrl" defaultValue={publicAccess.localServiceUrl || ""} placeholder="http://localhost:3011" />
                </label>
                <label htmlFor="public-url">
                  {t("Public URL")}
                  <input id="public-url" name="publicUrl" defaultValue={publicAccess.publicUrl || ""} placeholder="https://tasks.example.com" />
                </label>
                <label htmlFor="tunnel-name">
                  {t("Tunnel name")}
                  <input id="tunnel-name" name="tunnelName" defaultValue={publicAccess.tunnelName || ""} placeholder="agent-task-manager" />
                </label>
                <label className="check-row" htmlFor="access-protected">
                  <input id="access-protected" name="accessProtected" type="checkbox" defaultChecked={publicAccess.accessProtected} />
                  <span>{t("Cloudflare Access protects this hostname")}</span>
                </label>
                <label className="check-row" htmlFor="clear-tunnel-token">
                  <input id="clear-tunnel-token" name="clearTunnelToken" type="checkbox" />
                  <span>{t("Clear token status")}</span>
                </label>
              </div>
              <label htmlFor="tunnel-token">
                {t("Cloudflare install command or tunnel token")}
                <textarea id="tunnel-token" name="tunnelToken" rows={3} autoComplete="off" spellCheck={false} placeholder={t("Paste a Cloudflare tunnel token or install command, then save.")} />
              </label>
              <div className="button-row">
                <button type="submit">{t("Save Public Access")}</button>
                <button type="button" onClick={testPublicAccess}>{t("Check Public URL")}</button>
              </div>
              <ResultLine result={result.publicAccess} t={t} />
            </form>
            <div className="command-grid">
              <CommandBlock command={publicAccessPayload?.guide?.quickTunnelCommand || ""} copied={copiedCommand === "public-quick-command"} id="public-quick-command" t={t} title="Quick Tunnel" onCopy={copyCommand} />
              <CommandBlock command={publicAccessPayload?.guide?.remoteRunCommand || "Paste a token and save to generate this command."} copied={copiedCommand === "public-run-command"} id="public-run-command" t={t} title="Production Run" onCopy={copyCommand} />
              <CommandBlock command={publicAccessPayload?.guide?.serviceInstallCommand || "Paste a token and save to generate this command."} copied={copiedCommand === "public-service-command"} id="public-service-command" t={t} title="Install Service" onCopy={copyCommand} />
            </div>
          </section>

          <section className="panel wide-panel owners-panel">
            <div className="list-head">
              <div>
                <h2>{t("Owners")}</h2>
                <p className="muted">{t("Map human owners to Slack users and aliases.")}</p>
              </div>
              <button type="button" onClick={() => sendMemberInvites(false)}>
                <Send className="icon" aria-hidden="true" />
                <span>{t("Send Invites")}</span>
              </button>
            </div>
            <form key={editingOwner?.id || "new-owner"} className="settings-form" onSubmit={onSaveOwner}>
              <input type="hidden" name="id" defaultValue={editingOwner?.id || ""} />
              <div className="form-grid">
                <label htmlFor="owner-name">
                  {t("Owner name")}
                  <input id="owner-name" name="ownerName" defaultValue={editingOwner?.ownerName || ""} required />
                </label>
                <label htmlFor="owner-slack">
                  {t("Slack user ID")}
                  <input id="owner-slack" name="slackUserId" defaultValue={editingOwner?.slackUserId || ""} placeholder="U0123456789" />
                </label>
                <label htmlFor="owner-aliases">
                  {t("Aliases")}
                  <input id="owner-aliases" name="aliases" defaultValue={editingOwner?.aliases.join(", ") || ""} placeholder="alice, ali" />
                </label>
                <label className="check-row" htmlFor="owner-active">
                  <input id="owner-active" name="active" type="checkbox" defaultChecked={editingOwner?.active ?? true} />
                  <span>{t("Active")}</span>
                </label>
              </div>
              <div className="button-row">
                <button type="submit">{t("Save Owner")}</button>
                <button type="button" onClick={() => setEditingOwner(null)}>{t("Clear")}</button>
              </div>
              <ResultLine result={result.owner} t={t} />
            </form>
            <div className="compact-list">
              {filteredOwners.length ? filteredOwners.map((owner) => (
                <article key={owner.id} className="compact-item">
                  <div>
                    <strong>{owner.ownerName}</strong>
                    <span>{t(owner.active ? "active" : "inactive")} · {owner.slackUserId || t("no Slack user")} · {owner.aliases.join(", ") || t("no aliases")}</span>
                  </div>
                  <button className="icon-button" type="button" aria-label={t("Edit")} title={t("Edit")} onClick={() => setEditingOwner(owner)}>
                    <Pencil className="icon" aria-hidden="true" />
                    <span className="sr-only">{t("Edit")}</span>
                  </button>
                </article>
              )) : <div className="empty-card">{t("No owners match this view.")}</div>}
            </div>
          </section>

          <section className="panel wide-panel invites-panel">
            <div className="list-head">
              <div>
                <h2>{t("Member Invitations")}</h2>
                <p className="muted">{t("Slack DMs with one-time account links for approved owners.")}</p>
              </div>
              <button type="button" onClick={() => sendMemberInvites(true)}>
                <Send className="icon" aria-hidden="true" />
                <span>{t("Resend")}</span>
              </button>
            </div>
            <ResultLine result={result.invites} t={t} />
            <div className="compact-list">
              {filteredInvitations.length ? filteredInvitations.map((invite) => (
                <article key={invite.id} className="compact-item">
                  <div>
                    <strong>{invite.ownerName || invite.ownerId}</strong>
                    <span>{invite.status} · {invite.slackUserId} · {invite.email || t("no email yet")} · {relativeTime(invite.updatedAt)}</span>
                  </div>
                  {invite.status === "pending" ? (
                    <button className="icon-button" type="button" aria-label={t("Revoke")} title={t("Revoke")} onClick={() => revokeInvite(invite.id)}>
                      <XCircle className="icon" aria-hidden="true" />
                      <span className="sr-only">{t("Revoke")}</span>
                    </button>
                  ) : null}
                </article>
              )) : <div className="empty-card">{t("No invitations match this view.")}</div>}
            </div>
          </section>

          <section className="panel wide-panel channel-policy-panel">
            <h2>{t("Channel Policies")}</h2>
            <p className="muted">{t("Manual by default; suggestions only where expected.")}</p>
            <form key={editingPolicy?.channelId || "new-channel-policy"} className="settings-form" onSubmit={onSaveChannelPolicy}>
              <div className="form-grid">
                <label htmlFor="channel-id">
                  {t("Slack channel ID")}
                  <input id="channel-id" name="channelId" defaultValue={editingPolicy?.channelId || ""} required placeholder="C0123456789" />
                </label>
                <label htmlFor="channel-mode">
                  {t("Mode")}
                  <select id="channel-mode" name="mode" defaultValue={editingPolicy?.mode || "manual_only"}>
                    <option value="manual_only">manual_only</option>
                    <option value="suggest_only">suggest_only</option>
                  </select>
                </label>
              </div>
              <button type="submit">{t("Save Policy")}</button>
              <ResultLine result={result.channel} t={t} />
            </form>
            <div className="compact-list">
              {filteredPolicies.length ? filteredPolicies.map((policy) => (
                <article key={policy.channelId} className="compact-item">
                  <div>
                    <strong>{policy.channelId}</strong>
                    <span>{policy.mode} · {relativeTime(policy.updatedAt)}</span>
                  </div>
                  <button className="icon-button" type="button" aria-label={t("Edit")} title={t("Edit")} onClick={() => setEditingPolicy(policy)}>
                    <Pencil className="icon" aria-hidden="true" />
                    <span className="sr-only">{t("Edit")}</span>
                  </button>
                </article>
              )) : <div className="empty-card">{t("No channel policies match this view.")}</div>}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
