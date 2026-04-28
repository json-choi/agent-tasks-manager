# OpenClaw Task Manager Skill

Install this helper through the Agent Task Manager setup flow. OpenClaw remains responsible for Slack message receipt, Slack replies, DMs, and block action interactions.

Required environment:

```bash
export TASK_MANAGER_API_URL=http://localhost:3011
export TASK_MANAGER_AGENT_ID=<agent id from setup>
export TASK_MANAGER_API_TOKEN=<token shown once>
```

The setup flow installs:

- `skills/task-manager/task-manager-skill.ts`
- `skills/task-manager/task-manager.env`
- `skills/task-manager/openclaw-task-manager.json`
- `skills/shared/task-manager-client.ts`

OpenClaw should wire Slack messages to `handleMessage`, Slack block actions to `handleInteraction`, and a short scheduled job to `pollOutbox`.

When OpenClaw infers an owner from a Slack mention or planning context, pass the owner name, owner id, or Slack user id as `assignee`. Task Manager resolves it against active owner mappings, sends the owner a DM with Accept, Decline, and Delegate controls, and repeats the same flow for the delegated owner.
