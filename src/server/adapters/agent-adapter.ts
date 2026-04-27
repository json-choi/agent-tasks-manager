import { existsSync } from "node:fs";
import type { AgentSettings, AgentThreadContext, AgentType, Diagnostic, SlackAction, Task } from "../shared/types";
import { compactText } from "../shared/utils";

export interface AgentAdapter {
  readonly type: AgentType;
  diagnose(settings: Partial<AgentSettings>): Diagnostic[];
  installInstructions(settings: AgentSettings, apiBaseUrl: string, token?: string | null): string[];
  captureThread(context: AgentThreadContext): SlackAction[];
  createTask(task: Task, duplicate?: boolean): SlackAction[];
  askAssignee(task: Task, assigneeId?: string | null): SlackAction[];
  postTaskUpdate(task: Task, message?: string): SlackAction[];
  syncAgentRun(runId: string, task: Task): SlackAction[];
}

export class HermesAdapter implements AgentAdapter {
  readonly type = "hermes" as const;

  diagnose(settings: Partial<AgentSettings>): Diagnostic[] {
    const cliPath = settings.cliPath ?? "";
    return [
      diagnoseCli("Hermes CLI", cliPath),
      diagnosePath("Hermes config", settings.configPath),
      {
        ok: true,
        label: "Slack mode",
        message: "Verify the existing Hermes Slack manifest, Socket Mode, slash command, thread reply, and mention-gating settings in the Hermes workspace."
      },
      {
        ok: true,
        label: "Bot loop guard",
        message: "Keep Hermes configured to ignore bot-origin messages and this Task Manager agent's own replies."
      }
    ];
  }

  installInstructions(settings: AgentSettings, apiBaseUrl: string, token?: string | null): string[] {
    const pluginDir = settings.workspacePath
      ? `${settings.workspacePath}/plugins/task-manager`
      : "<hermes-workspace>/plugins/task-manager";
    const sharedDir = settings.workspacePath
      ? `${settings.workspacePath}/plugins/shared`
      : "<hermes-workspace>/plugins/shared";
    const cli = settings.cliPath || "hermes";
    return [
      `mkdir -p ${pluginDir}`,
      `cp -R agent-plugin/hermes/* ${pluginDir}/`,
      `mkdir -p ${sharedDir}`,
      `cp -R agent-plugin/shared/* ${sharedDir}/`,
      `printf '%s\n' 'TASK_MANAGER_API_URL=${apiBaseUrl}' 'TASK_MANAGER_AGENT_ID=${settings.id}' 'TASK_MANAGER_API_TOKEN=${token ?? "<token shown once>"}' > ${pluginDir}/task-manager.env`,
      `${cli} plugin enable task-manager`,
    ];
  }

  captureThread(context: AgentThreadContext): SlackAction[] {
    return [
      {
        kind: "thread_reply",
        channelId: context.channelId ?? null,
        threadTs: context.threadTs ?? null,
        text: "Thread context captured. I can turn this into a task when you confirm."
      }
    ];
  }

  createTask(task: Task, duplicate = false): SlackAction[] {
    return [
      {
        kind: "thread_reply",
        channelId: task.channelId,
        threadTs: task.threadTs,
        text: duplicate
          ? `This thread is already tracked as ${task.id}: ${task.title}`
          : `Proposed task ${task.id}: ${task.title}`
      }
    ];
  }

  askAssignee(task: Task, assigneeId?: string | null): SlackAction[] {
    const text = assigneeId
      ? `<@${assigneeId}> can you take ${task.id}: ${task.title}?`
      : `Who should own ${task.id}: ${task.title}?`;
    return [{ kind: "thread_reply", channelId: task.channelId, threadTs: task.threadTs, text }];
  }

  postTaskUpdate(task: Task, message?: string): SlackAction[] {
    return [
      {
        kind: "thread_reply",
        channelId: task.channelId,
        threadTs: task.threadTs,
        text: message ?? `${task.id} is now ${task.status}.`
      }
    ];
  }

  syncAgentRun(runId: string, task: Task): SlackAction[] {
    return [
      {
        kind: "thread_reply",
        channelId: task.channelId,
        threadTs: task.threadTs,
        text: `Linked agent run ${runId} to ${task.id}.`
      }
    ];
  }
}

export class OpenClawAdapter implements AgentAdapter {
  readonly type = "openclaw" as const;

  diagnose(settings: Partial<AgentSettings>): Diagnostic[] {
    const cliPath = settings.cliPath ?? "";
    return [
      diagnoseCli("OpenClaw CLI", cliPath),
      diagnosePath("OpenClaw config", settings.configPath),
      diagnosePath("OpenClaw workspace", settings.workspacePath),
      {
        ok: true,
        label: "Slack action permissions",
        message: "Verify the existing OpenClaw Slack app can post thread replies, DMs, and read the target channels."
      },
      {
        ok: true,
        label: "Mention gating",
        message: "Keep OpenClaw configured to ignore bot replies and only react to explicit commands in manual-only channels."
      }
    ];
  }

  installInstructions(settings: AgentSettings, apiBaseUrl: string, token?: string | null): string[] {
    const skillDir = settings.workspacePath
      ? `${settings.workspacePath}/skills/task-manager`
      : "<openclaw-workspace>/skills/task-manager";
    const sharedDir = settings.workspacePath
      ? `${settings.workspacePath}/skills/shared`
      : "<openclaw-workspace>/skills/shared";
    const cli = settings.cliPath || "openclaw";
    return [
      `mkdir -p ${skillDir}`,
      `cp -R agent-plugin/openclaw/* ${skillDir}/`,
      `mkdir -p ${sharedDir}`,
      `cp -R agent-plugin/shared/* ${sharedDir}/`,
      `printf '%s\n' 'TASK_MANAGER_API_URL=${apiBaseUrl}' 'TASK_MANAGER_AGENT_ID=${settings.id}' 'TASK_MANAGER_API_TOKEN=${token ?? "<token shown once>"}' > ${skillDir}/task-manager.env`,
      `${cli} skills reload`
    ];
  }

  captureThread(context: AgentThreadContext): SlackAction[] {
    return [
      {
        kind: "thread_reply",
        channelId: context.channelId ?? null,
        threadTs: context.threadTs ?? null,
        text: "Captured the thread for task review."
      }
    ];
  }

  createTask(task: Task, duplicate = false): SlackAction[] {
    return [
      {
        kind: "thread_reply",
        channelId: task.channelId,
        threadTs: task.threadTs,
        text: duplicate
          ? `Already tracking this Slack thread as ${task.id}.`
          : `Task proposal created: ${task.id} - ${compactText(task.title, 96)}`
      }
    ];
  }

  askAssignee(task: Task, assigneeId?: string | null): SlackAction[] {
    return [
      {
        kind: assigneeId ? "dm" : "thread_reply",
        channelId: task.channelId,
        threadTs: task.threadTs,
        userId: assigneeId ?? null,
        text: assigneeId
          ? `Can you take ${task.id}: ${task.title}? Reply accepted or blocked.`
          : `Assignment needed for ${task.id}: ${task.title}`
      }
    ];
  }

  postTaskUpdate(task: Task, message?: string): SlackAction[] {
    return [
      {
        kind: "thread_reply",
        channelId: task.channelId,
        threadTs: task.threadTs,
        text: message ?? `${task.id} moved to ${task.status}.`
      }
    ];
  }

  syncAgentRun(runId: string, task: Task): SlackAction[] {
    return [
      {
        kind: "thread_reply",
        channelId: task.channelId,
        threadTs: task.threadTs,
        text: `OpenClaw run ${runId} synced to ${task.id}.`
      }
    ];
  }
}

export function adapterFor(type: AgentType): AgentAdapter {
  return type === "hermes" ? new HermesAdapter() : new OpenClawAdapter();
}

function diagnosePath(label: string, value?: string | null): Diagnostic {
  if (!value) {
    return { ok: true, label, message: "Skipped in quick setup. Add a path only when running local diagnostics." };
  }

  return existsSync(value)
    ? { ok: true, label, message: value }
    : { ok: false, label, message: `${value} was not found on this host.` };
}

function diagnoseCli(label: string, value: string): Diagnostic {
  if (!value) {
    return { ok: true, label, message: "Skipped in quick setup. Add a CLI path only when running local diagnostics." };
  }

  if (value.includes("/") || value.startsWith(".")) {
    return existsSync(value)
      ? { ok: true, label, message: value }
      : { ok: false, label, message: `${value} was not found.` };
  }

  const result = Bun.spawnSync(["which", value]);
  if (result.exitCode === 0) {
    return { ok: true, label, message: new TextDecoder().decode(result.stdout).trim() };
  }

  return { ok: false, label, message: `${value} was not found in PATH.` };
}
