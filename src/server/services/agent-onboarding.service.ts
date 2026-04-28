import type { AgentSettings } from "../shared/types";

export function buildAgentQuickStart(agent: AgentSettings, apiBaseUrl: string, token: string | null) {
  const displayToken = token ?? "<existing token>";
  const pluginSource = "agent-plugin/openclaw";
  const sharedSource = "agent-plugin/shared";
  const pluginTarget = "<openclaw-workspace>/skills/task-manager";
  const sharedTarget = "<openclaw-workspace>/skills/shared";
  const reload = "openclaw skills reload";

  return {
    env: [
      `export TASK_MANAGER_API_URL=${apiBaseUrl}`,
      `export TASK_MANAGER_AGENT_ID=${agent.id}`,
      `export TASK_MANAGER_API_TOKEN=${displayToken}`
    ],
    install: [
      `mkdir -p ${pluginTarget}`,
      `cp -R ${pluginSource}/* ${pluginTarget}/`,
      `mkdir -p ${sharedTarget}`,
      `cp -R ${sharedSource}/* ${sharedTarget}/`,
      `printf '%s\n' '${`TASK_MANAGER_API_URL=${apiBaseUrl}`}' '${`TASK_MANAGER_AGENT_ID=${agent.id}`}' '${`TASK_MANAGER_API_TOKEN=${displayToken}`}' > ${pluginTarget}/task-manager.env`,
      `cat > ${pluginTarget}/openclaw-task-manager.json <<'JSON'\n${JSON.stringify(openClawQuickStartManifest(apiBaseUrl), null, 2)}\nJSON`,
      reload
    ],
    smokeTest: [
      `curl -s -X POST ${apiBaseUrl}/api/agent/connect/test \\`,
      '  -H "content-type: application/json" \\',
      `  -H "x-agent-id: ${agent.id}" \\`,
      `  -H "authorization: Bearer ${displayToken}" \\`,
      `  -d '{"source":"setup"}'`
    ],
    checks: [
      "OpenClaw Slack bot is already running.",
      "OpenClaw can read target channels and Slack thread replies.",
      "OpenClaw can post thread replies.",
      "OpenClaw can send assignment DMs.",
      "OpenClaw forwards Slack block action interactions to Task Manager.",
      "OpenClaw polls Task Manager outbox on a schedule.",
      "OpenClaw ignores bot-origin messages.",
      "OpenClaw command or mention gating is enabled for manual channels."
    ]
  };
}

function openClawQuickStartManifest(apiBaseUrl: string) {
  return {
    name: "task-manager",
    runtime: "openclaw",
    apiBaseUrl,
    skill: "./task-manager-skill.ts",
    env: "./task-manager.env",
    handlers: {
      slackMessage: "handleMessage",
      slackInteraction: "handleInteraction",
      scheduledOutbox: "pollOutbox"
    }
  };
}
