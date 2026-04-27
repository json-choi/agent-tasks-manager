import type { AgentSettings } from "../shared/types";

export function buildAgentQuickStart(agent: AgentSettings, apiBaseUrl: string, token: string | null) {
  const displayToken = token ?? "<existing token>";
  const pluginSource =
    agent.type === "hermes" ? "agent-plugin/hermes" : "agent-plugin/openclaw";
  const sharedSource = "agent-plugin/shared";
  const pluginTarget =
    agent.type === "hermes"
      ? "<hermes-server>/plugins/task-manager"
      : "<openclaw-workspace>/skills/task-manager";
  const sharedTarget =
    agent.type === "hermes"
      ? "<hermes-server>/plugins/shared"
      : "<openclaw-workspace>/skills/shared";
  const reload =
    agent.type === "hermes"
      ? "hermes plugin enable task-manager"
      : "openclaw skills reload";

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
      reload
    ],
    smokeTest: [
      `curl -s -X POST ${apiBaseUrl}/api/agent/connect/test \\`,
      '  -H "content-type: application/json" \\',
      `  -H "x-agent-id: ${agent.id}" \\`,
      `  -H "authorization: Bearer ${displayToken}" \\`,
      `  -d '{"source":"setup"}'`
    ],
    checks:
      agent.type === "hermes"
        ? [
            "Hermes Slack bot is already running.",
            "Hermes can read target channels and Slack thread replies.",
            "Hermes can post thread replies.",
            "Hermes can send DMs if assignment prompts use DM.",
            "Hermes ignores bot-origin messages.",
            "Hermes command or mention gating is enabled for manual channels."
          ]
        : [
            "OpenClaw Slack bot is already running.",
            "OpenClaw can read target channels and Slack thread replies.",
            "OpenClaw can post thread replies.",
            "OpenClaw can send DMs if assignment prompts use DM.",
            "OpenClaw ignores bot-origin messages.",
            "OpenClaw command or mention gating is enabled for manual channels."
          ]
  };
}
