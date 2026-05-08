# Agent Task Manager Install Guide for OpenClaw

You are OpenClaw acting as the install assistant for Agent Task Manager, before Agent Task Manager is running.

The user may send you only this GitHub document link. Fetch this guide, fetch the manifest next to it, ask the user for approval through Slack, then install and start ATM locally.

Manifest:

```text
https://raw.githubusercontent.com/json-choi/agent-task-manager/main/docs/install/openclaw-agent-install.manifest.json
```

## Rules

- Do not require the ATM server to already be running.
- Ask for explicit install approval in Slack before writing files or running install commands.
- Prefer local CLI login flows over asking users to paste long-lived tokens.
- Use a Slack DM, modal, or the safest private surface OpenClaw supports for credentials.
- Never echo GitHub, Cloudflare, ATM admin, or agent API tokens back into Slack.
- Report final status with paths and checks only, not secrets.
- For uninstall, prefer the ATM uninstall API so the OpenClaw agent token is revoked before local files are removed.

## Target Outcome

By the end of this flow:

- ATM is installed locally.
- ATM has a `.env` containing required runtime settings.
- The first local admin is created through unattended bootstrap or the first-run setup UI.
- The OpenClaw Task Manager skill is installed into the OpenClaw workspace.
- The generated agent API token is written by ATM to `<openclaw-workspace>/skills/task-manager/task-manager.env`.
- OpenClaw has reloaded skills and can call `task-manager.handleMessage`, `task-manager.handleInteraction`, `task-manager.pollOutbox`, and `task-manager.runScheduledSlackCollection`.

## Slack Approval Flow

Use this private Slack interaction shape when your runtime supports buttons/modals:

```json
{
  "callback_id": "atm_install.approval",
  "text": "Install Agent Task Manager on this machine and connect it to this OpenClaw workspace?",
  "actions": [
    { "action_id": "atm_install.approve", "text": "Approve install", "style": "primary" },
    { "action_id": "atm_install.cancel", "text": "Cancel", "style": "danger" }
  ]
}
```

If buttons/modals are unavailable, ask for a clear text confirmation in a DM.

Use this private Slack interaction shape for uninstall:

```json
{
  "callback_id": "atm_uninstall.approval",
  "text": "Remove the Agent Task Manager integration from this OpenClaw workspace?",
  "actions": [
    { "action_id": "atm_uninstall.disconnect_openclaw", "text": "Disconnect OpenClaw", "style": "danger" },
    { "action_id": "atm_uninstall.remove_all", "text": "Remove ATM too", "style": "danger" },
    { "action_id": "atm_uninstall.cancel", "text": "Cancel" }
  ]
}
```

Before uninstalling, report what will be removed:

- `<openclaw-workspace>/skills/task-manager`
- `<openclaw-workspace>/skills/shared/task-manager-client.ts`
- legacy `<openclaw-workspace>/plugins/task-manager`, if present
- the saved OpenClaw agent API token hash in ATM, when the ATM API is reachable
- optionally the ATM install directory and data, only if the user chooses "Remove ATM too"

## Preflight

1. Identify the host where OpenClaw is running.
2. Detect the OpenClaw workspace:
   - `TASK_MANAGER_OPENCLAW_WORKSPACE`
   - `OPENCLAW_WORKSPACE`
   - `OPENCLAW_HOME`
   - `OPENCLAW_AGENT_HOME`
   - `~/.openclaw`
   - `~/.config/openclaw`
3. Check local tools:

```bash
node --version
npm --version
bun --version
openclaw --version || true
```

If Bun is missing, ask the user for approval to install Bun or switch to a documented manual install path.

## Required User Inputs

Ask privately for:

- Admin email for the first ATM admin.
- Admin password for the first ATM admin, at least 8 characters.
- OpenClaw workspace path, only if detection is uncertain.

Do not ask for the generated OpenClaw agent token. ATM creates it during plugin install.

## Optional CLI Login Requests

GitHub issue sync:

```bash
gh auth status || gh auth login
gh auth token
```

Only run this if the user wants GitHub issue creation or webhook sync. Store the resulting token as `GITHUB_TOKEN` in ATM's `.env`; do not send it to Slack.

Cloudflare public access:

```bash
cloudflared --version
cloudflared tunnel login
```

For preview, Quick Tunnel can be configured later from the ATM UI. For production, prefer a remotely managed Cloudflare Tunnel and store the tunnel token or install command through ATM setup once the server is running.

## Install Command

After approval and private inputs, install ATM with bootstrap values:

```bash
npx @jaesong/agent-task-manager setup \
  --bootstrap \
  --admin-email "$ATM_ADMIN_EMAIL" \
  --admin-password "$ATM_ADMIN_PASSWORD" \
  --openclaw-workspace "$OPENCLAW_WORKSPACE" \
  --no-openclaw-reload
```

Use `--port auto` if port `3011` is unavailable. Use `--public-url` only when the user already knows the externally reachable URL.

After ATM starts and bootstrap finishes, reload OpenClaw:

```bash
openclaw skills reload
```

If OpenClaw uses a custom CLI path, pass `--openclaw-cli <path>` or set `TASK_MANAGER_OPENCLAW_CLI`.

## Verification

1. Confirm the skill files exist:

```bash
test -f "$OPENCLAW_WORKSPACE/skills/task-manager/task-manager-skill.ts"
test -f "$OPENCLAW_WORKSPACE/skills/task-manager/task-manager.env"
test -f "$OPENCLAW_WORKSPACE/skills/task-manager/openclaw-task-manager.json"
test -f "$OPENCLAW_WORKSPACE/skills/shared/task-manager-client.ts"
```

2. Read `task-manager.env` locally and call the connect test without printing secrets:

```bash
set -a
. "$OPENCLAW_WORKSPACE/skills/task-manager/task-manager.env"
set +a
curl -s -X POST "$TASK_MANAGER_API_URL/api/agent/connect/test" \
  -H "content-type: application/json" \
  -H "x-agent-id: $TASK_MANAGER_AGENT_ID" \
  -H "authorization: Bearer $TASK_MANAGER_API_TOKEN" \
  -d '{"source":"openclaw-github-install-guide"}'
```

3. Confirm Slack routing:
   - Slack messages route to `task-manager.handleMessage`.
   - Slack block actions route to `task-manager.handleInteraction`.
   - Scheduled polling calls `task-manager.pollOutbox`.
   - Scheduled Slack collection calls `task-manager.runScheduledSlackCollection`.

## Clean Uninstall Flow

Use this flow when the user asks to remove Agent Task Manager or disconnect OpenClaw.

### Preferred: ATM API Uninstall

This is the clean path because it revokes the saved OpenClaw agent token and removes plugin files.

1. Ask for uninstall approval in a Slack DM/modal.
2. Start or locate the ATM server:

```bash
atm run --dir "${TASK_MANAGER_DIR:-$HOME/.agent-task-manager}" --no-update
```

If `atm` is not on PATH, use:

```bash
npx @jaesong/agent-task-manager run --dir "${TASK_MANAGER_DIR:-$HOME/.agent-task-manager}" --no-update
```

3. Ask an ATM admin to approve login privately, then call:

```bash
curl -s -X POST "$TASK_MANAGER_API_URL/api/auth/login" \
  -H "content-type: application/json" \
  -d '{"email":"<private admin email>","password":"<private admin password>"}'
```

Do not print the returned admin bearer token.

4. Revoke the OpenClaw agent token and remove skill files:

```bash
curl -s -X POST "$TASK_MANAGER_API_URL/api/setup/agent/uninstall" \
  -H "content-type: application/json" \
  -H "authorization: Bearer <admin bearer token>" \
  -d '{
    "type": "openclaw",
    "workspacePath": "'"$OPENCLAW_WORKSPACE"'",
    "runReload": false
  }'
```

5. Reload OpenClaw:

```bash
openclaw skills reload
```

6. Verify:

```bash
test ! -e "$OPENCLAW_WORKSPACE/skills/task-manager"
test ! -e "$OPENCLAW_WORKSPACE/skills/task-manager/task-manager.env"
test ! -e "$OPENCLAW_WORKSPACE/skills/task-manager/openclaw-task-manager.json"
test ! -e "$OPENCLAW_WORKSPACE/skills/shared/task-manager-client.ts" || true
```

### Fallback: File-Only Uninstall

Use this only if ATM cannot be started. This removes local OpenClaw files but cannot revoke a token stored in ATM's database. Tell the user this limitation in the final Slack report.

```bash
rm -rf "$OPENCLAW_WORKSPACE/skills/task-manager"
rm -f "$OPENCLAW_WORKSPACE/skills/shared/task-manager-client.ts"
rmdir "$OPENCLAW_WORKSPACE/skills/shared" 2>/dev/null || true
rm -rf "$OPENCLAW_WORKSPACE/plugins/task-manager"
rm -f "$OPENCLAW_WORKSPACE/plugins/shared/task-manager-client.ts"
rmdir "$OPENCLAW_WORKSPACE/plugins/shared" 2>/dev/null || true
openclaw skills reload
```

### Optional: Remove ATM App and Data

Only do this after explicit approval. This deletes local ATM data, tasks, audit logs, and the token database.

```bash
atm uninstall --dir "${TASK_MANAGER_DIR:-$HOME/.agent-task-manager}" --remove-data
```

If `atm` is unavailable:

```bash
npx @jaesong/agent-task-manager uninstall --dir "${TASK_MANAGER_DIR:-$HOME/.agent-task-manager}" --remove-data
```

## Final Slack Report

Send a private completion report like:

```text
Agent Task Manager installed.
ATM URL: http://localhost:<port>/setup
OpenClaw workspace: <path>
Skill: <path>/skills/task-manager
Connect test: ok
Secrets were written locally and not posted to Slack.
```

Do not include `TASK_MANAGER_API_TOKEN`, `GITHUB_TOKEN`, Cloudflare tokens, admin password, or bearer sessions.

For uninstall, send:

```text
Agent Task Manager disconnected from OpenClaw.
OpenClaw workspace: <path>
Removed skill files: yes
Agent token revoked: yes|not verified
OpenClaw reload: ok|skipped|failed
ATM app/data removed: yes|no
Secrets were not posted to Slack.
```
