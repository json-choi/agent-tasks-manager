# OpenClaw Task Manager Skill

Install this helper into the existing OpenClaw workspace or skill directory. OpenClaw remains responsible for Slack message receipt and Slack replies.

Required environment:

```bash
export TASK_MANAGER_API_URL=http://localhost:3011
export TASK_MANAGER_AGENT_ID=<agent id from setup>
export TASK_MANAGER_API_TOKEN=<token shown once>
```

Because OpenClaw deployments vary, the MVP treats this as a config/CLI adapter. Verify the workspace path, Slack action permissions, mention gating, and bot-loop prevention in `/setup`.
