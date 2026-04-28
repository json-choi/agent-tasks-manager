# Agent Task Manager

Agent Task Manager, or ATM, is a self-hosted task layer for teams that already run an agent in Slack.

ATM does not add another Slack bot. Your existing Hermes/OpenClaw-style agent keeps Slack Socket Mode, message reads, thread replies, and DMs. ATM stores task state, serves the dashboard, manages plugin credentials, and returns Slack actions for the agent to execute.

## What It Does

- Captures Slack thread context through an existing agent plugin.
- Creates task proposals from explicit commands or low-token digest candidates.
- Stores tasks as Markdown files with a SQLite index.
- Supports owner mapping, assignment prompts, stale task checks, and daily digests.
- Installs and uninstalls Hermes/OpenClaw plugins from the setup flow.
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
agent-plugin/                       Hermes and OpenClaw plugin packages
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
3. Select Hermes Agent or OpenClaw.
4. Let ATM detect a local or mounted agent workspace.
5. Install the plugin and run a connection smoke test.
6. Review Slack permissions already owned by the agent.
7. Optionally configure channel automation mode.

Automatic plugin install only works for paths visible to the ATM process. If the agent runs elsewhere, expose that workspace to the ATM host or install the plugin manually.

## Hook Points

ATM is intentionally small around a few extension points.

### Agent Plugins

Use `agent-plugin/hermes` or `agent-plugin/openclaw` as the reference package. Plugins send Slack context to ATM and execute the returned Slack actions.

Primary agent endpoints:

- `POST /api/agent/connect/test`
- `POST /api/agent/thread/capture`
- `POST /api/agent/task/propose`
- `POST /api/agent/slack/digest/collect`
- `POST /api/agent/slack/digest/commit`
- `GET /api/agent/tasks/cards`
- `POST /api/agent/tasks/daily-digest`
- `POST /api/agent/task/:id/assignment-response`
- `POST /api/agent/task/:id/status-signal`
- `GET /api/agent/outbox`
- `POST /api/agent/outbox/:id/ack`

### Agent Adapters

Add or adjust agent-specific Slack action behavior in:

```text
src/server/adapters/agent-adapter.ts
```

The adapter contract covers:

- `captureThread`
- `createTask`
- `askAssignee`
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

- mark stale assignment requests as blocked
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
