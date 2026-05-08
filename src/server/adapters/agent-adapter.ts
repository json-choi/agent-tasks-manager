import { existsSync } from "node:fs";
import type { AgentSettings, AgentThreadContext, AgentType, Diagnostic, OwnerMapping, SlackAction, Task } from "../shared/types";
import { slackConfirmationActionId, slackConfirmationCallbackId } from "../shared/types";
import { compactText } from "../shared/utils";
import { buildOpenClawTaskManagerConfig } from "../services/openclaw-config.service";

export interface AgentAdapter {
  readonly type: AgentType;
  diagnose(settings: Partial<AgentSettings>): Diagnostic[];
  installInstructions(settings: AgentSettings, apiBaseUrl: string, token?: string | null): string[];
  captureThread(context: AgentThreadContext): SlackAction[];
  createTask(task: Task, duplicate?: boolean): SlackAction[];
  askAssignee(task: Task, assigneeId?: string | null): SlackAction[];
  requestAssignment(task: Task, assignee: OwnerMapping, requestId: string, owners: OwnerMapping[]): SlackAction[];
  postTaskUpdate(task: Task, message?: string): SlackAction[];
  syncAgentRun(runId: string, task: Task): SlackAction[];
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
      },
      {
        ok: true,
        label: "Scheduled collection",
        message: "Run task-manager.runScheduledSlackCollection on the installed cadence for configured Slack scopes."
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
      `cat > ${skillDir}/openclaw-task-manager.json <<'JSON'\n${JSON.stringify(buildOpenClawTaskManagerConfig(apiBaseUrl), null, 2)}\nJSON`,
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

  requestAssignment(task: Task, assignee: OwnerMapping, requestId: string, owners: OwnerMapping[]): SlackAction[] {
    const ownerOptions = owners
      .filter((owner) => owner.active && owner.slackUserId && owner.id !== assignee.id)
      .slice(0, 25)
      .map((owner) => ({
        text: { type: "plain_text", text: owner.ownerName },
        value: owner.id
      }));
    const actionElements: unknown[] = [
      {
        type: "button",
        text: { type: "plain_text", text: "Accept" },
        style: "primary",
        action_id: slackConfirmationActionId.assignmentAccept,
        value: requestId
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Decline" },
        style: "danger",
        action_id: slackConfirmationActionId.assignmentDecline,
        value: requestId
      }
    ];
    if (ownerOptions.length > 0) {
      actionElements.unshift({
        type: "static_select",
        action_id: slackConfirmationActionId.assignmentDelegateSelect,
        placeholder: { type: "plain_text", text: "Delegate to" },
        options: ownerOptions
      });
    }

    const blocks: unknown[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${task.title}*\n${compactText(task.description || task.nextAction || "No description provided.", 220)}`
        }
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `${task.id} · ${task.priority}/${task.status}` },
          { type: "mrkdwn", text: task.nextAction ? `Next: ${task.nextAction}` : "Please confirm ownership." }
        ]
      },
      {
        type: "actions",
        block_id: `atm_assignment_${requestId}`,
        elements: actionElements
      }
    ];

    return [
      {
        kind: "dm",
        userId: assignee.slackUserId,
        text: `Can you take ${task.id}: ${task.title}?`,
        blocks,
        metadata: {
          type: slackConfirmationCallbackId.assignmentConfirmation,
          requestId,
          taskId: task.id
        }
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
  if (type !== "openclaw") {
    throw new Error(`Unsupported agent type: ${type}`);
  }
  return new OpenClawAdapter();
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
