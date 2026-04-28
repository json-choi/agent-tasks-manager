# Agent Task Manager

Agent Task Manager, or ATM, is a self-hosted task layer for teams that already run an agent in Slack.

ATM does not add another Slack bot. Your existing OpenClaw agent keeps Slack Socket Mode, message reads, thread replies, DMs, and interactions. ATM stores task state, serves the dashboard, manages OpenClaw credentials, and returns Slack actions for OpenClaw to execute.

## What It Does

- Captures Slack thread context through an existing agent plugin.
- Creates task proposals from explicit commands or low-token digest candidates.
- Stores tasks as Markdown files with a SQLite index.
- Supports owner mapping, assignment prompts, stale task checks, and daily digests.
- Installs and uninstalls the OpenClaw integration from the setup flow.
- Uses Better Auth-backed admin sessions.
- Classifies coding tasks and optionally creates linked GitHub issues.
- Syncs linked task status from GitHub issue webhooks.

## What It Does Not Do

- It does not run a separate Slack bot.
- It does not scan every Slack message with an LLM.
- It does not require a hosted database.
- It does not make GitHub, Linear, or Slack the source of truth.

## Architecture

```text
Slack thread
  -> existing Slack agent
  -> ATM agent plugin
  -> ATM API
  -> task proposal / assignment / status update
  -> Markdown + SQLite
  -> optional GitHub issue sync
```

Agent plugins call the ATM HTTP API instead of shelling out to the CLI. The CLI is kept for install/start/admin workflows; runtime Slack and webhook integrations stay in the API server so credentials, auth checks, idempotency, and GitHub synchronization live in one service boundary.

Runtime layout:

```text
src/server/index.ts                 server process entry
src/server/app.ts                   Elysia composition root
src/server/modules/*/controller.ts  MVC controllers
src/server/services/*               domain and integration services
src/server/repositories/*           SQLite + Markdown persistence
src/server/shared/*                 shared types, parsers, and HTTP utilities
src/client/dashboard.ts             dashboard source
public/                             static dashboard shell
src/worker/index.ts                 background worker process
agent-plugin/                       OpenClaw integration package
```

## Quick Start

```bash
npx @jaesong/agent-task-manager setup --open
```

Open:

```text
http://localhost:3011/setup
```

Use a different port when needed:

```bash
npx @jaesong/agent-task-manager setup --port auto --open
```

To hand installation to an existing Slack-connected OpenClaw agent before ATM is running, send OpenClaw the GitHub install guide:

```text
https://github.com/json-choi/agent-task-manager/blob/main/docs/install/openclaw-agent-install.md
```

OpenClaw can fetch the raw Markdown and adjacent manifest, ask for approval through Slack, request `gh auth login` or `cloudflared tunnel login` locally when optional integrations are needed, then run the ATM installer with bootstrap values so it installs its own Task Manager skill. The same guide includes a clean uninstall path that prefers the ATM API for token revocation and falls back to file-only removal only when the server cannot be started.

### Unattended OpenClaw Bootstrap

For a first-run install that does not require clicking through setup, pass the bootstrap values up front. ATM creates the first admin, generates the OpenClaw agent token, writes `task-manager.env` into the OpenClaw workspace, installs the skill files, and optionally reloads OpenClaw.

```bash
npx @jaesong/agent-task-manager setup \
  --bootstrap \
  --admin-email admin@example.com \
  --admin-password "replace-with-a-long-password" \
  --openclaw-workspace "$HOME/.openclaw" \
  --open
```

Equivalent `.env` values:

```bash
TASK_MANAGER_BOOTSTRAP=true
TASK_MANAGER_ADMIN_EMAIL=admin@example.com
TASK_MANAGER_ADMIN_PASSWORD=replace-with-a-long-password
TASK_MANAGER_OPENCLAW_WORKSPACE=/Users/me/.openclaw
TASK_MANAGER_OPENCLAW_RUN_RELOAD=true
```

Useful optional bootstrap values:

```bash
TASK_MANAGER_OPENCLAW_CLI=openclaw
TASK_MANAGER_OPENCLAW_FORCE_INSTALL=false
TASK_MANAGER_OPENCLAW_REGENERATE_TOKEN=true
TASK_MANAGER_SLACK_PERMISSIONS_REVIEWED=true
TASK_MANAGER_CLOUDFLARE_TUNNEL_TOKEN=
TASK_MANAGER_PUBLIC_ACCESS_MODE=remote
TASK_MANAGER_PUBLIC_URL=https://tasks.example.com
GITHUB_TOKEN=
GITHUB_WEBHOOK_SECRET=
```

Bootstrap is idempotent: after the OpenClaw skill env file exists, later starts keep the existing agent token unless `TASK_MANAGER_OPENCLAW_FORCE_INSTALL=true` is set. Because `.env` can contain bootstrap credentials, keep file permissions tight and remove one-time admin password values after the first successful run if your deployment process does not need them again.

## Updates

Installed ATM copies update themselves before `atm start` and `atm run`. The CLI checks the latest npm release, preserves the install directory data and `.env`, rebuilds the dashboard, then starts the service. Running processes are not hot-swapped; the update applies on the next start.

Run an update explicitly:

```bash
atm update
```

Disable the startup check for one run:

```bash
atm run --no-update
```

Set `ATM_AUTO_UPDATE=false` to disable startup update checks for that environment.

Repository development:

```bash
bun install
bun run dev
```

## Configuration

Create a `.env` file or export environment variables:

```bash
DATA_DIR=./data
PORT=3011
PUBLIC_BASE_URL=http://localhost:3011
BETTER_AUTH_SECRET=replace-with-a-random-secret-at-least-32-characters
GITHUB_TOKEN=github_pat_or_app_token_for_issue_creation
GITHUB_WEBHOOK_SECRET=shared_secret_configured_on_the_github_webhook
```

For unattended setup, also set `TASK_MANAGER_BOOTSTRAP=true`, `TASK_MANAGER_ADMIN_EMAIL`, `TASK_MANAGER_ADMIN_PASSWORD`, and `TASK_MANAGER_OPENCLAW_WORKSPACE`. The generated OpenClaw API token is not stored in the ATM database in plaintext; it is written once to `<openclaw-workspace>/skills/task-manager/task-manager.env`.

Storage defaults to `./data`:

```text
data/tasks/YYYY/MM/task_<id>.md
data/events/agent-YYYY-MM-DD.ndjson
data/audit/audit-YYYY-MM.ndjson
data/index.sqlite
data/config/app.yml
```

## Setup Flow

1. Create the first admin.
2. Verify local storage.
3. Connect OpenClaw.
4. Let ATM detect a local or mounted agent workspace.
5. Install the plugin and run a connection smoke test.
6. Review Slack permissions already owned by the agent.
7. Optionally configure channel automation mode.

Automatic plugin install only works for paths visible to the ATM process. If the agent runs elsewhere, expose that workspace to the ATM host or install the plugin manually.

## Hook Points

ATM is intentionally small around a few extension points.

### OpenClaw Integration

Use `agent-plugin/openclaw` as the reference package. OpenClaw sends Slack context and interaction payloads to ATM, polls the outbox, and executes the returned Slack actions.

Primary agent endpoints:

- `POST /api/agent/connect/test`
- `POST /api/agent/thread/capture`
- `POST /api/agent/task/propose`
- `POST /api/agent/task/:id/assignment-request`
- `POST /api/agent/slack/interaction`
- `GET /api/agent/owners`
- `POST /api/agent/slack/digest/collect`
- `POST /api/agent/slack/digest/commit`
- `GET /api/agent/tasks/cards`
- `POST /api/agent/tasks/daily-digest`
- `POST /api/agent/task/:id/assignment-response`
- `POST /api/agent/task/:id/status-signal`
- `GET /api/agent/outbox`
- `POST /api/agent/outbox/:id/ack`

### OpenClaw Adapter

Add or adjust OpenClaw Slack action behavior in:

```text
src/server/adapters/agent-adapter.ts
```

The adapter contract covers:

- `captureThread`
- `createTask`
- `askAssignee`
- `requestAssignment`
- `postTaskUpdate`
- `syncAgentRun`

### Plugin Installer

Workspace detection, file copy, environment file writing, reload commands, and clean uninstall live in:

```text
src/server/services/agent-plugin-installer.service.ts
```

### Task Storage

SQLite indexing and Markdown task file sync live in:

```text
src/server/repositories/task-store.repository.ts
```

### Auth

Admin auth is wrapped in:

```text
src/server/services/auth.service.ts
src/server/modules/auth/controller.ts
```

ATM keeps its public API stable with `/api/setup/admin`, `/api/auth/login`, and `/api/auth/logout` while Better Auth owns the user/session tables.

### Worker Jobs

Background checks live in:

```text
src/worker/index.ts
```

Current jobs:

- expire stale assignment requests and block stale assignments
- move stale in-progress tasks to review
- enqueue optional daily digests

### Dashboard

Dashboard source lives in:

```text
src/client/dashboard.ts
public/styles/app.css
```

The dashboard is deliberately an app shell, not a landing page.

## Admin API

- `GET /health`
- `GET /ready`
- `POST /api/setup/admin`
- `GET /api/setup/status`
- `POST /api/setup/storage/check`
- `GET /api/setup/agent/workspaces`
- `POST /api/setup/agent/install`
- `POST /api/setup/agent/uninstall`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/tasks`
- `POST /api/tasks`
- `GET /api/tasks/:id`
- `PATCH /api/tasks/:id`
- `GET /api/settings/agents`
- `PATCH /api/settings/agents`
- `GET /api/settings/owners`
- `POST /api/settings/owners`
- `GET /api/settings/github`
- `PATCH /api/settings/github`
- `GET /api/settings/channels`
- `PATCH /api/settings/channels`
- `POST /api/integrations/github/sync`
- `POST /api/integrations/github/webhook`

## Development

```bash
bun install
bun run build
bun run typecheck
bun test
bun run cli:check
```

The dashboard bundle is generated from `src/client/dashboard.ts` into `public/src/main.js`. It is ignored in git and rebuilt by `bun run build` and `npm pack`.

Release automation is documented in:

```text
docs/releasing.md
```

## Roadmap Docs

Landing pages and longer guides are tracked separately in:

```text
docs/roadmap/landing-and-guides.md
```

Runtime UI should stay focused on setup and task operations.

## License

MIT
