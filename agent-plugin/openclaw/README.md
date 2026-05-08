# OpenClaw Task Manager Skill

Install this helper through the Agent Task Manager setup flow. OpenClaw remains responsible for Slack message receipt, Slack replies, DMs, and block action interactions.

Required environment:

```bash
export TASK_MANAGER_API_URL=http://localhost:3011
export TASK_MANAGER_AGENT_ID=<agent id from setup>
export TASK_MANAGER_API_TOKEN=<token shown once>
export TASK_MANAGER_SLACK_TASKIFICATION_PATH=/api/agent/task/propose
```

The setup flow installs:

- `skills/task-manager/task-manager-skill.ts`
- `skills/task-manager/task-manager.env`
- `skills/task-manager/openclaw-task-manager.json`
- `skills/shared/task-manager-client.ts`

OpenClaw should wire Slack messages to `handleMessage`, Slack block actions to `handleInteraction`, a short scheduled job to `pollOutbox`, and a periodic scheduled job to `runScheduledSlackCollection`.
Manual Slack collection jobs should call `getSlackCollectionScope` first, then collect the returned targets with the target `workspaceId`, `channelId`, and `threadCollectionMode`. Scheduled collection should call `runScheduledSlackCollection` with an OpenClaw Slack collector callback; the helper posts each target through ATM digest collection and commits the digest so work messages become approval-backed task candidates.

When OpenClaw infers an owner from a Slack mention or planning context, pass the owner name, owner id, or Slack user id as `assignee`. Task Manager resolves it against active owner mappings, sends the owner a DM with Accept, Decline, and Delegate controls, and repeats the same flow for the delegated owner.
