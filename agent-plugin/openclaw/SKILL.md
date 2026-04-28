---
name: task-manager
description: Connect OpenClaw Slack commands to the self-hosted Task Manager API.
---

Use the existing OpenClaw Slack bot. Do not start a separate Slack bot for Task Manager.

Required environment:

```bash
TASK_MANAGER_API_URL=http://localhost:3011
TASK_MANAGER_AGENT_ID=<agent id from setup>
TASK_MANAGER_API_TOKEN=<token shown once>
```

Behavior:

- Convert explicit task commands into `POST /api/agent/task/propose`.
- Use `GET /api/agent/owners` when owner mappings are needed for automatic assignment.
- Ask assignees through `POST /api/agent/task/:id/ask-assignee`.
- Forward Slack block actions through `POST /api/agent/slack/interaction`.
- Send completion/status signals through `POST /api/agent/task/:id/status-signal`.
- Poll `GET /api/agent/outbox` if the OpenClaw runtime supports scheduled plugin work.

Safety:

- Ignore bot-origin Slack messages.
- Keep manual-only as the default channel mode.
- Only call the configured Task Manager API URL.
