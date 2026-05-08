import { Pencil, Plus, Send, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { CommandBlock, ResultLine, SettingTile } from "../components/common";
import { display, displayBoolean, errorMessage, relativeTime } from "../lib/format";
import { checked, formField, formPayload, splitList } from "../lib/forms";
import { filterRecords } from "../lib/tasks";
import type { ApiClient, ChannelPolicy, MemberInvitation, OwnerMapping, PublicAccessPayload, ResultMessage, SetupStatus, SlackCollectionScopeSettings, SlackCollectionScopeValidation, SlackWorkspaceChannel, SlackWorkspaceConnection, Translator } from "../types";

type SlackThreadCollectionMode = SlackCollectionScopeSettings["channelThreadScopes"][string];

const threadCollectionModeOptions: Array<{ value: SlackThreadCollectionMode; label: string }> = [
  { value: "parent_messages", label: "Parent messages only" },
  { value: "active_threads", label: "Active threads" },
  { value: "full_thread_history", label: "Full thread history" }
];

export function SettingsView({ api, refreshKey, search, t }: { api: ApiClient; refreshKey: number; search: string; t: Translator }) {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [publicAccessPayload, setPublicAccessPayload] = useState<PublicAccessPayload | null>(null);
  const [owners, setOwners] = useState<OwnerMapping[]>([]);
  const [invitations, setInvitations] = useState<MemberInvitation[]>([]);
  const [policies, setPolicies] = useState<ChannelPolicy[]>([]);
  const [collectionScope, setCollectionScope] = useState<SlackCollectionScopeSettings | null>(null);
  const [slackWorkspaces, setSlackWorkspaces] = useState<SlackWorkspaceConnection[]>([]);
  const [selectedCollectionWorkspaceId, setSelectedCollectionWorkspaceId] = useState("");
  const [selectedCollectionChannelIds, setSelectedCollectionChannelIds] = useState<string[]>([]);
  const [mentionFilters, setMentionFilters] = useState<string[]>([]);
  const [keywordFilters, setKeywordFilters] = useState<string[]>([]);
  const [newMentionFilter, setNewMentionFilter] = useState("");
  const [newKeywordFilter, setNewKeywordFilter] = useState("");
  const [selectedMentionOwner, setSelectedMentionOwner] = useState("");
  const [editingOwner, setEditingOwner] = useState<OwnerMapping | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<ChannelPolicy | null>(null);
  const [result, setResult] = useState<Record<string, ResultMessage | null>>({});
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const publicAccessFormRef = useRef<HTMLFormElement | null>(null);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const [setupData, publicAccessData, ownersData, invitesData, channelsData, collectionScopeData, workspaceData] = await Promise.all([
        api<SetupStatus>("/api/setup/status"),
        api<PublicAccessPayload>("/api/setup/public-access"),
        api<{ owners: OwnerMapping[] }>("/api/settings/owners"),
        api<{ invitations: MemberInvitation[] }>("/api/settings/member-invites"),
        api<{ policies: ChannelPolicy[] }>("/api/settings/channels"),
        api<{ collectionScope: SlackCollectionScopeSettings }>("/api/settings/slack/collection-scope"),
        api<{ workspaces: SlackWorkspaceConnection[] }>("/api/settings/slack/workspaces")
      ]);
      setSetup(setupData);
      setPublicAccessPayload(publicAccessData);
      setOwners(ownersData.owners || []);
      setInvitations(invitesData.invitations || []);
      setPolicies(channelsData.policies || []);
      setCollectionScope(collectionScopeData.collectionScope);
      setSlackWorkspaces(workspaceData.workspaces || []);
    } catch (error) {
      setResult((current) => ({ ...current, settings: { text: errorMessage(error), ok: false } }));
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings, refreshKey]);

  useEffect(() => {
    if (!collectionScope) return;
    setSelectedCollectionChannelIds(collectionScope.channels);
    setMentionFilters(collectionScope.mentions);
    setKeywordFilters(collectionScope.keywords);
    setNewMentionFilter("");
    setNewKeywordFilter("");
    setSelectedMentionOwner("");
    setSelectedCollectionWorkspaceId((current) => {
      if (current && collectionScope.workspaces.includes(current)) return current;
      return collectionScope.workspaces[0] || slackWorkspaces[0]?.workspaceId || "";
    });
  }, [collectionScope, slackWorkspaces]);

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

  async function onSaveCollectionScope(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;

    try {
      const channels = selectedChannelIds(form, selectedCollectionChannelIds);
      const data = await api<{ collectionScope: SlackCollectionScopeSettings; validation?: SlackCollectionScopeValidation }>("/api/settings/slack/collection-scope", {
        method: "PATCH",
        body: JSON.stringify({
          workspaces: selectedWorkspaceIds(form),
          channels,
          channelThreadScopes: selectedChannelThreadScopes(form, channels),
          threads: splitList(formField(form, "threads")),
          mentions: mentionFilters,
          keywords: keywordFilters
        })
      });
      setCollectionScope(data.collectionScope);
      setResultMessage("collectionScope", {
        text: collectionScopeValidationMessage(data.validation),
        ok: !data.validation?.hasInvalid
      });
      await loadSettings();
    } catch (error) {
      setResultMessage("collectionScope", { text: errorMessage(error), ok: false });
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

  function onCollectionWorkspaceSelectionsChange(event: ChangeEvent<HTMLSelectElement>) {
    const selected = selectedOptions(event.currentTarget);
    if (!selected.length) {
      setSelectedCollectionWorkspaceId("");
      return;
    }
    setSelectedCollectionWorkspaceId((current) => selected.includes(current) ? current : selected[0] ?? "");
  }

  function onCollectionChannelSelectionsChange(event: ChangeEvent<HTMLSelectElement>) {
    setSelectedCollectionChannelIds(selectedOptions(event.currentTarget));
  }

  function addMentionFilter(value: string) {
    const nextMentions = splitList(value);
    if (!nextMentions.length) return;
    const invalidMentions = nextMentions.filter((item) => !isSlackMentionFilter(item));
    if (invalidMentions.length) {
      setResultMessage("collectionScope", { text: `Invalid mention filter: ${invalidMentions.join(", ")}`, ok: false });
      return;
    }
    const duplicateMentions = nextMentions.filter((item) => mentionFilters.includes(item));
    setMentionFilters((current) => Array.from(new Set([...current, ...nextMentions])));
    setNewMentionFilter("");
    setSelectedMentionOwner("");
    setResultMessage("collectionScope", {
      text: duplicateMentions.length ? `Duplicate mention ignored: ${Array.from(new Set(duplicateMentions)).join(", ")}` : "Mention filter added.",
      ok: true
    });
  }

  function removeMentionFilter(value: string) {
    setMentionFilters((current) => current.filter((item) => item !== value));
  }

  function addKeywordFilter(value: string) {
    const nextKeywords = splitList(value);
    if (!nextKeywords.length) return;
    const invalidKeywords = nextKeywords.filter((item) => !isSlackKeywordFilter(item));
    if (invalidKeywords.length) {
      setResultMessage("collectionScope", { text: `Invalid keyword filter: ${invalidKeywords.join(", ")}`, ok: false });
      return;
    }
    const duplicateKeywords = nextKeywords.filter((item) => keywordFilters.includes(item));
    setKeywordFilters((current) => Array.from(new Set([...current, ...nextKeywords])));
    setNewKeywordFilter("");
    setResultMessage("collectionScope", {
      text: duplicateKeywords.length ? `Duplicate keyword ignored: ${Array.from(new Set(duplicateKeywords)).join(", ")}` : "Keyword filter added.",
      ok: true
    });
  }

  function removeKeywordFilter(value: string) {
    setKeywordFilters((current) => current.filter((item) => item !== value));
  }

  const publicAccess = publicAccessPayload?.publicAccess;
  const storage = setup?.storage || {};
  const filteredOwners = filterRecords(owners, ["ownerName", "slackUserId", "aliases"], search);
  const filteredInvitations = filterRecords(invitations, ["ownerName", "slackUserId", "status", "email"], search);
  const filteredPolicies = filterRecords(policies, ["channelId", "mode"], search);
  const workspaceOptions = mergeWorkspaceOptions(slackWorkspaces, collectionScope?.workspaces || []);
  const selectedCollectionWorkspace = workspaceOptions.find((workspace) => workspace.workspaceId === selectedCollectionWorkspaceId) ?? workspaceOptions[0] ?? null;
  const channelOptions = mergeChannelOptions(selectedCollectionWorkspace?.channels || [], collectionScope?.channels || []);
  const mentionOwnerOptions = owners
    .filter((owner) => owner.active && owner.slackUserId)
    .sort((a, b) => a.ownerName.localeCompare(b.ownerName));

  return (
    <section className="secondary-view">
      {isLoading || !setup || !publicAccess || !collectionScope ? <section className="panel secondary-panel"><p className="muted">{t("Loading...")}</p><ResultLine result={result.settings} t={t} /></section> : (
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

          <section className="panel wide-panel slack-collection-panel">
            <div className="list-head">
              <div>
                <h2>{t("Slack Collection Scope")}</h2>
                <p className="muted">{t("Select the Slack workspaces, channels, threads, mentions, and keywords ATM should collect.")}</p>
              </div>
              <span className="toggle-pill">{collectionScope.updatedAt ? t("Configured") : t("Not configured")}</span>
            </div>
            <form key={collectionScope.updatedAt || "new-collection-scope"} className="settings-form" onSubmit={onSaveCollectionScope}>
              <div className="form-grid">
                <label htmlFor="collection-workspaces">
                  {t("Workspaces")}
                  <select id="collection-workspaces" name="workspaceSelections" multiple defaultValue={collectionScope.workspaces} onChange={onCollectionWorkspaceSelectionsChange}>
                    {workspaceOptions.length ? workspaceOptions.map((workspace) => (
                      <option key={workspace.workspaceId} value={workspace.workspaceId}>
                        {workspaceLabel(workspace)}
                      </option>
                    )) : <option value="" disabled>{t("No Slack workspaces connected")}</option>}
                  </select>
                  <input name="workspaces" defaultValue="" placeholder={t("Add workspace IDs manually")} />
                </label>
                <label htmlFor="collection-channel-workspace">
                  {t("Channel workspace")}
                  <select
                    id="collection-channel-workspace"
                    value={selectedCollectionWorkspace?.workspaceId || ""}
                    onChange={(event) => setSelectedCollectionWorkspaceId(event.currentTarget.value)}
                    disabled={!workspaceOptions.length}
                  >
                    {workspaceOptions.length ? workspaceOptions.map((workspace) => (
                      <option key={workspace.workspaceId} value={workspace.workspaceId}>
                        {workspaceLabel(workspace)}
                      </option>
                    )) : <option value="">{t("No Slack workspaces connected")}</option>}
                  </select>
                </label>
                <label htmlFor="collection-channels">
                  {t("Channels")}
                  <select
                    id="collection-channels"
                    name="channelSelections"
                    multiple
                    value={selectedCollectionChannelIds}
                    onChange={onCollectionChannelSelectionsChange}
                    disabled={!channelOptions.length}
                  >
                    {channelOptions.length ? channelOptions.map((channel) => (
                      <option key={channel.channelId} value={channel.channelId}>
                        {channelLabel(channel)}
                      </option>
                    )) : <option value="" disabled>{t("No observed channels for this workspace")}</option>}
                  </select>
                  <input name="channels" defaultValue="" placeholder={t("Add channel IDs manually")} />
                </label>
                <label htmlFor="collection-threads">
                  {t("Threads")}
                  <input id="collection-threads" name="threads" defaultValue={collectionScope.threads.join(", ")} placeholder="1710000000.000400" />
                </label>
                <div className="thread-scope-field">
                  <span>{t("Thread collection")}</span>
                  {selectedCollectionChannelIds.length ? (
                    <div className="thread-scope-list">
                      {selectedCollectionChannelIds.map((channelId) => (
                        <label key={channelId} htmlFor={`thread-scope-${channelId}`}>
                          {threadScopeChannelLabel(channelId, channelOptions)}
                          <select
                            id={`thread-scope-${channelId}`}
                            name={`threadScope:${channelId}`}
                            defaultValue={collectionScope.channelThreadScopes?.[channelId] ?? "active_threads"}
                          >
                            {threadCollectionModeOptions.map((option) => (
                              <option key={option.value} value={option.value}>{t(option.label)}</option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                  ) : <p className="muted">{t("Select channels to configure thread collection.")}</p>}
                </div>
                <div className="mention-filter-field">
                  <div className="field-head">
                    <span>{t("Mention filters")}</span>
                    <span className="toggle-pill">{String(mentionFilters.length)}</span>
                  </div>
                  <input type="hidden" name="mentions" value={mentionFilters.join(", ")} readOnly />
                  <div className="mention-filter-list" aria-live="polite">
                    {mentionFilters.length ? mentionFilters.map((mention) => (
                      <div key={mention} className="mention-filter-row">
                        <span>{mentionLabel(mention, owners)}</span>
                        <button className="icon-button danger-button" type="button" aria-label={`${t("Remove mention filter")} ${mention}`} title={t("Remove mention filter")} onClick={() => removeMentionFilter(mention)}>
                          <Trash2 className="icon" aria-hidden="true" />
                          <span className="sr-only">{t("Remove mention filter")}</span>
                        </button>
                      </div>
                    )) : <div className="empty-card">{t("No mention filters configured.")}</div>}
                  </div>
                  <div className="mention-filter-controls">
                    <label htmlFor="collection-mention-owner">
                      {t("Known Slack users")}
                      <select
                        id="collection-mention-owner"
                        value={selectedMentionOwner}
                        onChange={(event) => setSelectedMentionOwner(event.currentTarget.value)}
                        disabled={!mentionOwnerOptions.length}
                      >
                        <option value="">{mentionOwnerOptions.length ? t("Select a user") : t("No mapped Slack users")}</option>
                        {mentionOwnerOptions.map((owner) => (
                          <option key={owner.id} value={owner.slackUserId ?? ""}>
                            {owner.ownerName} ({owner.slackUserId})
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" onClick={() => addMentionFilter(selectedMentionOwner)} disabled={!selectedMentionOwner}>
                      <Plus className="icon" aria-hidden="true" />
                      <span>{t("Add user")}</span>
                    </button>
                    <label htmlFor="collection-mention-manual">
                      {t("Manual mention")}
                      <input
                        id="collection-mention-manual"
                        value={newMentionFilter}
                        onChange={(event) => setNewMentionFilter(event.currentTarget.value)}
                        placeholder="U0123456789, @alice"
                      />
                    </label>
                    <button type="button" onClick={() => addMentionFilter(newMentionFilter)} disabled={!newMentionFilter.trim()}>
                      <Plus className="icon" aria-hidden="true" />
                      <span>{t("Add mention")}</span>
                    </button>
                  </div>
                </div>
                <div className="keyword-filter-field">
                  <div className="field-head">
                    <span>{t("Keyword filters")}</span>
                    <span className="toggle-pill">{String(keywordFilters.length)}</span>
                  </div>
                  <input type="hidden" name="keywords" value={keywordFilters.join(", ")} readOnly />
                  <div className="keyword-filter-list" aria-live="polite">
                    {keywordFilters.length ? keywordFilters.map((keyword) => (
                      <div key={keyword} className="keyword-filter-row">
                        <span>{keyword}</span>
                        <button className="icon-button danger-button" type="button" aria-label={`${t("Remove keyword filter")} ${keyword}`} title={t("Remove keyword filter")} onClick={() => removeKeywordFilter(keyword)}>
                          <Trash2 className="icon" aria-hidden="true" />
                          <span className="sr-only">{t("Remove keyword filter")}</span>
                        </button>
                      </div>
                    )) : <div className="empty-card">{t("No keyword filters configured.")}</div>}
                  </div>
                  <div className="keyword-filter-controls">
                    <label htmlFor="collection-keyword-manual">
                      {t("Manual keyword")}
                      <input
                        id="collection-keyword-manual"
                        value={newKeywordFilter}
                        onChange={(event) => setNewKeywordFilter(event.currentTarget.value)}
                        placeholder="ship, incident, 고객, 배포"
                      />
                    </label>
                    <button type="button" onClick={() => addKeywordFilter(newKeywordFilter)} disabled={!newKeywordFilter.trim()}>
                      <Plus className="icon" aria-hidden="true" />
                      <span>{t("Add keyword")}</span>
                    </button>
                  </div>
                </div>
              </div>
              <button type="submit">{t("Save Collection Scope")}</button>
              <ResultLine result={result.collectionScope} t={t} />
            </form>
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

function selectedWorkspaceIds(form: HTMLFormElement): string[] {
  const formData = new FormData(form);
  const selected = formData
    .getAll("workspaceSelections")
    .map((value) => String(value))
    .filter(Boolean);
  return Array.from(new Set([...selected, ...splitList(formField(form, "workspaces"))]));
}

function selectedChannelIds(form: HTMLFormElement, selectedChannels: string[]): string[] {
  return Array.from(new Set([...selectedChannels, ...splitList(formField(form, "channels"))]));
}

function selectedChannelThreadScopes(
  form: HTMLFormElement,
  selectedChannels: string[]
): SlackCollectionScopeSettings["channelThreadScopes"] {
  return Object.fromEntries(
    selectedChannels.map((channelId) => {
      const mode = formField(form, `threadScope:${channelId}`);
      return [channelId, isThreadCollectionMode(mode) ? mode : "active_threads"];
    })
  );
}

function isThreadCollectionMode(value: string): value is SlackThreadCollectionMode {
  return threadCollectionModeOptions.some((option) => option.value === value);
}

function selectedOptions(select: HTMLSelectElement): string[] {
  return Array.from(select.selectedOptions).map((option) => option.value).filter(Boolean);
}

function mergeWorkspaceOptions(
  connections: SlackWorkspaceConnection[],
  selectedWorkspaceIds: string[]
): SlackWorkspaceConnection[] {
  const byWorkspace = new Map<string, SlackWorkspaceConnection>();
  for (const connection of connections) {
    byWorkspace.set(connection.workspaceId, connection);
  }
  for (const workspaceId of selectedWorkspaceIds) {
    if (byWorkspace.has(workspaceId)) continue;
    byWorkspace.set(workspaceId, {
      workspaceId,
      workspaceName: null,
      agentId: null,
      agentName: null,
      channels: [],
      status: "configured"
    });
  }
  return Array.from(byWorkspace.values()).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
}

function mergeChannelOptions(channels: SlackWorkspaceChannel[], selectedChannelIds: string[]): SlackWorkspaceChannel[] {
  const byChannel = new Map<string, SlackWorkspaceChannel>();
  for (const channel of channels) {
    byChannel.set(channel.channelId, channel);
  }
  for (const channelId of selectedChannelIds) {
    if (byChannel.has(channelId)) continue;
    byChannel.set(channelId, {
      channelId,
      channelName: null,
      lastSeenAt: null
    });
  }
  return Array.from(byChannel.values()).sort((a, b) => {
    const aSeen = a.lastSeenAt ?? "";
    const bSeen = b.lastSeenAt ?? "";
    if (aSeen !== bSeen) return bSeen.localeCompare(aSeen);
    return a.channelId.localeCompare(b.channelId);
  });
}

function workspaceLabel(workspace: SlackWorkspaceConnection): string {
  const name = workspace.workspaceName ? `${workspace.workspaceName} ` : "";
  const agent = workspace.agentName ? ` · ${workspace.agentName}` : "";
  return `${name}(${workspace.workspaceId}) · ${workspace.status}${agent}`;
}

function channelLabel(channel: SlackWorkspaceChannel): string {
  const name = channel.channelName ? `#${channel.channelName} ` : "";
  const seen = channel.lastSeenAt ? ` · seen ${relativeTime(channel.lastSeenAt)}` : "";
  return `${name}(${channel.channelId})${seen}`;
}

function threadScopeChannelLabel(channelId: string, channels: SlackWorkspaceChannel[]): string {
  const channel = channels.find((item) => item.channelId === channelId);
  return channel?.channelName ? `#${channel.channelName} (${channelId})` : channelId;
}

function mentionLabel(mention: string, owners: OwnerMapping[]): string {
  const owner = owners.find((item) => item.slackUserId === mention);
  return owner ? `${owner.ownerName} (${mention})` : mention;
}

function collectionScopeValidationMessage(validation: SlackCollectionScopeValidation | undefined): string {
  if (!validation) return "Slack collection scope saved.";
  const savedCount = Object.values(validation.saved).reduce((total, items) => total + items.length, 0);
  const parts = [`Slack collection scope saved (${savedCount} filter${savedCount === 1 ? "" : "s"}).`];
  if (validation.hasDuplicates) {
    parts.push(`Duplicates ignored: ${formatValidationItems(validation.duplicates)}.`);
  }
  if (validation.hasInvalid) {
    parts.push(`Invalid filters ignored: ${formatValidationItems(validation.invalid)}.`);
  }
  return parts.join(" ");
}

function formatValidationItems(itemsByField: Record<string, string[]>): string {
  return Object.entries(itemsByField)
    .filter(([, items]) => items.length > 0)
    .map(([field, items]) => `${field} (${items.join(", ")})`)
    .join("; ");
}

function isSlackMentionFilter(value: string): boolean {
  return /^[UW][A-Z0-9]{2,}$/.test(value) || /^@[A-Za-z0-9._-]{1,80}$/.test(value);
}

function isSlackKeywordFilter(value: string): boolean {
  return value.length <= 120;
}
