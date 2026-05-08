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
- Treat explicit Korean requests like `태스크로 만들어줘`, `태스크에 넣어줘`, `태스크 추가해줘`, `태스크 등록해줘`, `할 일로 넣어줘`, and `업무로 넣어줘` as task creation commands.
- Use `GET /api/agent/owners` when owner mappings are needed for automatic assignment.
- Ask assignees through `POST /api/agent/task/:id/ask-assignee`.
- Forward Slack block actions through `POST /api/agent/slack/interaction`.
- Send completion/status signals through `POST /api/agent/task/:id/status-signal`.
- Fetch `GET /api/agent/slack/collection-scope` before manual or scheduled Slack collection so both flows use the dashboard-selected workspace, channel, thread, mention, and keyword scope.
- Schedule `runScheduledSlackCollection` and pass an OpenClaw Slack collector callback; it will collect each configured target through ATM's digest endpoint and commit digests for confirmation-backed task candidates.
- Poll `GET /api/agent/outbox` if the OpenClaw runtime supports scheduled plugin work.

Safety:

- Ignore bot-origin Slack messages.
- Keep manual-only as the default channel mode.
- Only call the configured Task Manager API URL.
