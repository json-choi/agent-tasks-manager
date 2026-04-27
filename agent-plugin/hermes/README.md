# Hermes Task Manager Plugin

Install this helper into the existing Hermes Agent runtime. It expects Hermes to keep handling Slack Socket Mode, slash commands, thread replies, and mention gating.

Required environment:

```bash
export TASK_MANAGER_API_URL=http://localhost:3011
export TASK_MANAGER_AGENT_ID=<agent id from setup>
export TASK_MANAGER_API_TOKEN=<token shown once>
```

The plugin recognizes:

- `/task`
- `태스크로 만들어줘`
- `이 스레드 태스크로 정리해줘`
- `담당자 물어봐`
- `이 태스크 상태 업데이트해줘`
- `오늘 내 할 일 보여줘`

The returned `actions` are Slack action payloads. Wire them to the Hermes Slack posting helper already used by your bot.
