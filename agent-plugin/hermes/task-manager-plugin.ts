import {
  classifyTaskCommand,
  clientFromEnv,
  type SlackMessageContext,
  type TaskManagerClient
} from "../shared/task-manager-client";
import { fileURLToPath } from "node:url";

export interface HermesSlackEvent {
  text?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  permalink?: string;
}

export interface HermesTaskManagerPluginOptions {
  client?: TaskManagerClient;
  agentName?: string;
}

export function createHermesTaskManagerPlugin(options: HermesTaskManagerPluginOptions = {}) {
  const envFilePath = fileURLToPath(new URL("./task-manager.env", import.meta.url));
  const client = options.client ?? clientFromEnv(undefined, envFilePath);
  const agentName = options.agentName ?? "Hermes Agent";

  return {
    name: "task-manager",

    async onSlackMessage(event: HermesSlackEvent) {
      if (!event.text || event.bot_id) return [];

      const command = classifyTaskCommand(event.text);
      if (command.type === "none") return [];

      const message: NonNullable<SlackMessageContext["messages"]>[number] = { text: event.text };
      if (event.user) message.userId = event.user;
      if (event.ts) message.ts = event.ts;

      const context: SlackMessageContext = {
        channelId: event.channel ?? null,
        threadTs: event.thread_ts ?? event.ts ?? null,
        messageTs: event.ts ?? null,
        authorId: event.user ?? null,
        permalink: event.permalink ?? null,
        agentName,
        messages: [message]
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
        const result = await client.today(command.assigneeId ?? event.user ?? null, event.channel, event.thread_ts ?? event.ts);
        return result.actions ?? [];
      }

      return [
        {
          kind: "thread_reply",
          channelId: event.channel ?? null,
          threadTs: event.thread_ts ?? event.ts ?? null,
          text: "I need a task id for that command."
        }
      ];
    },

    async pollOutbox(postActions: (actions: unknown[]) => Promise<void>) {
      const result = await client.getOutbox();
      for (const item of result.outbox ?? []) {
        if (Array.isArray(item.payload?.actions)) {
          await postActions(item.payload.actions);
        }
        await client.ackOutbox(item.id);
      }
    }
  };
}
