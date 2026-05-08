export interface OpenClawTaskManagerConfig {
  name: "task-manager";
  runtime: "openclaw";
  apiBaseUrl: string;
  skill: "./task-manager-skill.ts";
  env: "./task-manager.env";
  authentication: {
    type: "bearer";
    tokenEnv: "TASK_MANAGER_API_TOKEN";
    agentIdHeader: "x-agent-id";
    agentIdEnv: "TASK_MANAGER_AGENT_ID";
  };
  intake: {
    slackTaskification: {
      method: "POST";
      endpoint: string;
      path: "/api/agent/task/propose";
      handler: "handleMessage";
      auth: "authentication";
      requiredHeaders: {
        "content-type": "application/json";
        "x-agent-id": "TASK_MANAGER_AGENT_ID";
        authorization: "Bearer ${TASK_MANAGER_API_TOKEN}";
      };
    };
  };
  handlers: {
    slackMessage: "handleMessage";
    slackInteraction: "handleInteraction";
    scheduledOutbox: "pollOutbox";
    scheduledSlackCollection: "runScheduledSlackCollection";
  };
  endpoints: {
    connectTest: string;
    threadCapture: string;
    taskPropose: string;
    slackInteraction: string;
    outbox: string;
  };
  schedule: {
    pollOutbox: {
      handler: "pollOutbox";
      intervalSeconds: number;
    };
    slackCollection: {
      handler: "runScheduledSlackCollection";
      intervalSeconds: number;
      scopeHandler: "getScheduledSlackCollectionScope";
      commitDigests: true;
      createTasks: true;
    };
  };
  requiredSlackCapabilities?: string[];
  smokeTests?: string[];
}

export function buildOpenClawTaskManagerConfig(
  apiBaseUrl: string,
  options: {
    includeDiagnostics?: boolean;
    outboxPollIntervalSeconds?: number;
    slackCollectionIntervalSeconds?: number;
  } = {}
): OpenClawTaskManagerConfig {
  const baseUrl = apiBaseUrl.replace(/\/+$/, "");
  const config: OpenClawTaskManagerConfig = {
    name: "task-manager",
    runtime: "openclaw",
    apiBaseUrl: baseUrl,
    skill: "./task-manager-skill.ts",
    env: "./task-manager.env",
    authentication: {
      type: "bearer",
      tokenEnv: "TASK_MANAGER_API_TOKEN",
      agentIdHeader: "x-agent-id",
      agentIdEnv: "TASK_MANAGER_AGENT_ID"
    },
    intake: {
      slackTaskification: {
        method: "POST",
        endpoint: `${baseUrl}/api/agent/task/propose`,
        path: "/api/agent/task/propose",
        handler: "handleMessage",
        auth: "authentication",
        requiredHeaders: {
          "content-type": "application/json",
          "x-agent-id": "TASK_MANAGER_AGENT_ID",
          authorization: "Bearer ${TASK_MANAGER_API_TOKEN}"
        }
      }
    },
    handlers: {
      slackMessage: "handleMessage",
      slackInteraction: "handleInteraction",
      scheduledOutbox: "pollOutbox",
      scheduledSlackCollection: "runScheduledSlackCollection"
    },
    endpoints: {
      connectTest: `${baseUrl}/api/agent/connect/test`,
      threadCapture: `${baseUrl}/api/agent/thread/capture`,
      taskPropose: `${baseUrl}/api/agent/task/propose`,
      slackInteraction: `${baseUrl}/api/agent/slack/interaction`,
      outbox: `${baseUrl}/api/agent/outbox`
    },
    schedule: {
      pollOutbox: {
        handler: "pollOutbox",
        intervalSeconds: options.outboxPollIntervalSeconds ?? 30
      },
      slackCollection: {
        handler: "runScheduledSlackCollection",
        intervalSeconds: options.slackCollectionIntervalSeconds ?? 300,
        scopeHandler: "getScheduledSlackCollectionScope",
        commitDigests: true,
        createTasks: true
      }
    }
  };

  if (options.includeDiagnostics) {
    config.requiredSlackCapabilities = [
      "read channel messages",
      "read thread replies",
      "post thread replies",
      "send DMs",
      "receive block action interactions"
    ];
    config.smokeTests = [
      "connect-test",
      "thread-reply-action",
      "dm-assignment-action",
      "interaction-forwarding",
      "outbox-polling",
      "scheduled-slack-collection"
    ];
  }

  return config;
}
