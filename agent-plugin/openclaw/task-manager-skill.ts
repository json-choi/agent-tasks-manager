import {
  classifyTaskCommand,
  clientFromEnv,
  type SlackMessageContext,
  type TaskManagerClient
} from "../shared/task-manager-client";
import { fileURLToPath } from "node:url";

export interface OpenClawMessage {
  text: string;
  userId?: string;
  botId?: string;
  channelId?: string;
  channelName?: string;
  messageTs?: string;
  threadTs?: string;
  permalink?: string;
}

export interface OpenClawTaskManagerSkillOptions {
  client?: TaskManagerClient;
  agentName?: string;
}

export function createOpenClawTaskManagerSkill(options: OpenClawTaskManagerSkillOptions = {}) {
  const envFilePath = fileURLToPath(new URL("./task-manager.env", import.meta.url));
  const client = options.client ?? clientFromEnv(undefined, envFilePath);
  const agentName = options.agentName ?? "OpenClaw";

  return {
    name: "task-manager",

    async handleMessage(message: OpenClawMessage) {
      if (message.botId) return [];

      const command = classifyTaskCommand(message.text);
      if (command.type === "none") return [];

      const slackMessage: NonNullable<SlackMessageContext["messages"]>[number] = { text: message.text };
      if (message.userId) slackMessage.userId = message.userId;
      if (message.botId) slackMessage.botId = message.botId;
      if (message.messageTs) slackMessage.ts = message.messageTs;

      const context: SlackMessageContext = {
        channelId: message.channelId ?? null,
        channelName: message.channelName ?? null,
        threadTs: message.threadTs ?? message.messageTs ?? null,
        messageTs: message.messageTs ?? null,
        authorId: message.userId ?? null,
        permalink: message.permalink ?? null,
        agentName,
        messages: [slackMessage]
      };

      if (command.type === "propose") {
        const result = await client.proposeTask({ context });
        return result.actions ?? [];
      }

      if (command.type === "ask_assignee" && command.taskId) {
        const result = await client.askAssignee(command.taskId, command.assigneeId);
        return result.actions ?? [];
      }

      if (command.type === "status" && command.taskId) {
        const result = await client.statusSignal(command.taskId, command.signal, 0.85, false);
        return result.actions ?? [];
      }

      if (command.type === "today") {
        const result = await client.today(
          command.assigneeId ?? message.userId ?? null,
          message.channelId,
          message.threadTs ?? message.messageTs
        );
        return result.actions ?? [];
      }

      return [
        {
          kind: "thread_reply",
          channelId: message.channelId ?? null,
          threadTs: message.threadTs ?? message.messageTs ?? null,
          text: "I need a task id for that command."
        }
      ];
    }
  };
}
