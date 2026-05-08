# Changelog

## [0.5.0](https://github.com/json-choi/agent-task-manager/compare/agent-task-manager-v0.4.0...agent-task-manager-v0.5.0) (2026-05-08)


### Features

* add member kanban task board ([#14](https://github.com/json-choi/agent-task-manager/issues/14)) ([2079f6a](https://github.com/json-choi/agent-task-manager/commit/2079f6a7db66c45c04a3ce3fafdad8add272c11b))
* add Slack taskification workflow ([#15](https://github.com/json-choi/agent-task-manager/issues/15)) ([9491d90](https://github.com/json-choi/agent-task-manager/commit/9491d906403376a3fe576430d388a9d024da326d))


### Bug Fixes

* recognize Korean task creation commands ([#12](https://github.com/json-choi/agent-task-manager/issues/12)) ([4e39dc3](https://github.com/json-choi/agent-task-manager/commit/4e39dc30cb59957028702c9e0b3ab98b44adc964))

## [0.4.0](https://github.com/json-choi/agent-task-manager/compare/agent-task-manager-v0.3.0...agent-task-manager-v0.4.0) (2026-04-29)


### Features

* add Slack member invitations ([a931c2a](https://github.com/json-choi/agent-task-manager/commit/a931c2a5d251ad17919c743d38d60a8f5a47f58f))

## [0.3.0](https://github.com/json-choi/agent-task-manager/compare/agent-task-manager-v0.2.0...agent-task-manager-v0.3.0) (2026-04-28)


### Features

* add OpenClaw guided install flow ([#8](https://github.com/json-choi/agent-task-manager/issues/8)) ([2172121](https://github.com/json-choi/agent-task-manager/commit/2172121fb6d37c7bb4fee43da5698580142bb397))

## [0.2.0](https://github.com/json-choi/agent-task-manager/compare/agent-task-manager-v0.1.0...agent-task-manager-v0.2.0) (2026-04-28)


### Features

* add one-command setup ([#2](https://github.com/json-choi/agent-task-manager/issues/2)) ([6ca0086](https://github.com/json-choi/agent-task-manager/commit/6ca008640c565e6818f5cea4b8e1ccfbb59a7bae))

## 0.1.1

- Removed the secondary agent integration surface and focused setup, APIs, and docs on OpenClaw.
- Added OpenClaw assignment request DMs with accept, decline, and delegate interaction handling.
- Added OpenClaw installation manifest generation, outbox polling hooks, owner lookup, and legacy plugin cleanup.

## 0.1.0

- Initial public release of Agent Task Manager.
- Added the Elysia server, dashboard shell, setup flow, worker, Markdown and SQLite task storage, Better Auth admin login, OpenClaw integration references, and npm CLI installer.
