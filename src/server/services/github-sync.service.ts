import { createHmac, timingSafeEqual } from "node:crypto";
import type { TaskStore } from "../repositories/task-store.repository";
import { parseTaskState } from "../shared/parsers";
import type { GitHubSettings, Task, TaskState } from "../shared/types";
import { asRecord, stringValue } from "../shared/utils";

export type GitHubTaskSyncResult =
  | { status: "skipped"; reason: string; taskId: string }
  | { status: "created"; taskId: string; githubRef: string; issueUrl: string | null }
  | { status: "linked"; taskId: string; githubRef: string }
  | { status: "error"; taskId: string; error: string };

export type GitHubWebhookSyncResult =
  | { status: "skipped"; reason: string }
  | { status: "ignored"; reason: string; taskId?: string; githubRef?: string }
  | { status: "updated"; task: Task; previousStatus: TaskState; githubRef: string };

export function verifyGitHubSignature(body: string, signature: string, secret: string): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  return expectedBuffer.length === signatureBuffer.length && timingSafeEqual(expectedBuffer, signatureBuffer);
}

export async function runGitHubSync(store: TaskStore) {
  const settings = store.getGitHubSettings();
  if (!settings.enabled) {
    return store.recordGitHubSyncRun({ status: "skipped", summary: { reason: "disabled" } });
  }

  const tasks = store.listTasks().filter((task) => !["done", "cancelled"].includes(task.status));
  let created = 0;
  let skipped = 0;
  let linked = 0;

  for (const task of tasks) {
    const result = await syncTaskToGitHub(store, task, settings);
    if (result.status === "created") {
      created += 1;
      continue;
    }
    if (result.status === "linked") {
      linked += 1;
      continue;
    }
    if (result.status === "skipped") {
      skipped += 1;
      continue;
    }
    return store.recordGitHubSyncRun({
      status: "error",
      summary: { created, linked, skipped, taskId: task.id },
      error: result.error
    });
  }

  return store.recordGitHubSyncRun({ status: "completed", summary: { created, linked, skipped } });
}

export async function syncTaskToGitHub(
  store: TaskStore,
  task: Task,
  settings: GitHubSettings = store.getGitHubSettings()
): Promise<GitHubTaskSyncResult> {
  if (!settings.enabled) return { status: "skipped", reason: "disabled", taskId: task.id };
  if (task.category !== "coding") return { status: "skipped", reason: "not-coding", taskId: task.id };

  const existingRef = parseGitHubRef(task.githubRef);
  if (existingRef) {
    store.upsertGitHubTaskLink({
      taskId: task.id,
      repo: existingRef.repo,
      issueNumber: existingRef.issueNumber,
      state: null
    });
    return { status: "linked", taskId: task.id, githubRef: task.githubRef ?? `${existingRef.repo}#${existingRef.issueNumber}` };
  }

  if (!settings.autoCreateIssues) return { status: "skipped", reason: "auto-create-disabled", taskId: task.id };
  const rule = selectGitHubRule(settings, task);
  if (!rule?.repo) return { status: "skipped", reason: "no-rule", taskId: task.id };

  const token = process.env.GITHUB_TOKEN;
  if (!token) return { status: "error", taskId: task.id, error: "GITHUB_TOKEN is not configured" };

  try {
    const response = await fetch(`https://api.github.com/repos/${rule.repo}/issues`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28"
      },
      body: JSON.stringify({
        title: task.title,
        body: githubIssueBody(task),
        labels: issueLabels(settings, rule, task),
        assignees: task.assignee && settings.assigneesByOwner[task.assignee] ? [settings.assigneesByOwner[task.assignee]] : []
      })
    });
    if (!response.ok) throw new Error(`GitHub issue create failed: ${response.status}`);
    const issue = await response.json() as { number?: number; html_url?: string | null; state?: string | null };
    if (!issue.number) throw new Error("GitHub issue create response did not include an issue number");

    const githubRef = `${rule.repo}#${issue.number}`;
    const updated = store.updateTask(task.id, { githubRef });
    store.upsertGitHubTaskLink({
      taskId: task.id,
      repo: rule.repo,
      issueNumber: issue.number,
      issueUrl: issue.html_url ?? null,
      state: issue.state ?? "open"
    });
    return {
      status: "created",
      taskId: updated?.id ?? task.id,
      githubRef,
      issueUrl: issue.html_url ?? null
    };
  } catch (error) {
    return {
      status: "error",
      taskId: task.id,
      error: error instanceof Error ? error.message : "GitHub sync failed"
    };
  }
}

export function summarizeGitHubWebhook(payload: unknown) {
  const record = asRecord(payload);
  const issue = asRecord(record.issue);
  return {
    action: stringValue(record.action),
    repository: stringValue(asRecord(record.repository).full_name),
    issueNumber: Number(issue.number) || null,
    issueState: stringValue(issue.state)
  };
}

export function handleGitHubWebhook(store: TaskStore, event: string, payload: unknown): GitHubWebhookSyncResult {
  const settings = store.getGitHubSettings();
  if (!settings.enabled) return { status: "skipped", reason: "disabled" };
  if (event !== "issues") return { status: "ignored", reason: "unsupported-event" };

  const record = asRecord(payload);
  const repo = stringValue(asRecord(record.repository).full_name);
  const issue = asRecord(record.issue);
  const issueNumber = Number(issue.number);
  if (!repo || !Number.isInteger(issueNumber)) return { status: "ignored", reason: "invalid-issue-payload" };

  const githubRef = `${repo}#${issueNumber}`;
  const task = store.findTaskByGitHubIssue(repo, issueNumber);
  if (!task) return { status: "ignored", reason: "task-not-found", githubRef };

  const issueUrl = stringValue(issue.html_url);
  const issueState = stringValue(issue.state);
  store.upsertGitHubTaskLink({
    taskId: task.id,
    repo,
    issueNumber,
    issueUrl,
    state: issueState
  });

  const nextStatus = statusFromIssueWebhook(record, settings);
  if (!nextStatus) {
    return { status: "ignored", reason: "no-status-change", taskId: task.id, githubRef };
  }

  const updated = store.updateTask(task.id, { status: nextStatus, githubRef });
  if (!updated) return { status: "ignored", reason: "task-not-found", githubRef };
  return { status: "updated", task: updated, previousStatus: task.status, githubRef };
}

function githubIssueBody(task: Task): string {
  return [
    `Task Manager ID: ${task.id}`,
    "",
    task.description,
    "",
    `Priority: ${task.priority}`,
    `Status: ${task.status}`,
    `Category: ${task.category}`,
    task.assignee ? `Assignee: ${task.assignee}` : "",
    task.sourceUrl ? `Source: ${task.sourceUrl}` : "",
    task.nextAction ? `Next: ${task.nextAction}` : ""
  ].filter(Boolean).join("\n");
}

function selectGitHubRule(settings: GitHubSettings, task: Task): GitHubSettings["rules"][number] | null {
  const rules = settings.rules.filter((rule) => rule.repo);
  if (rules.length === 0) return null;

  const text = `${task.title} ${task.description} ${task.initiative ?? ""}`.toLowerCase();
  const initiative = task.initiative?.toLowerCase() ?? "";

  return (
    rules.find((rule) =>
      rule.initiativeIncludes?.some((needle) => initiative.includes(needle.toLowerCase()))
    ) ??
    rules.find((rule) =>
      rule.codeIndicators?.some((needle) => text.includes(needle.toLowerCase()))
    ) ??
    rules[0] ??
    null
  );
}

function issueLabels(settings: GitHubSettings, rule: GitHubSettings["rules"][number], task: Task): string[] {
  return [
    ...settings.labels,
    rule.projectLabel,
    "category:coding",
    `priority:${task.priority}`,
    `status:${task.status}`
  ].filter((label): label is string => Boolean(label));
}

function parseGitHubRef(value: string | null): { repo: string; issueNumber: number } | null {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const [, repo, issueNumber] = match;
  if (!repo || !issueNumber) return null;
  return { repo, issueNumber: Number(issueNumber) };
}

function statusFromIssueWebhook(payload: Record<string, unknown>, settings: GitHubSettings): TaskState | null {
  const action = stringValue(payload.action);
  if (action === "closed" && settings.autoCompleteClosedIssues) return "done";
  if (!settings.autoUpdateTaskStatusFromGitHub) return null;
  if (action === "reopened") return "in_progress";

  const rawLabels = asRecord(payload.issue).labels;
  const labels: unknown[] = Array.isArray(rawLabels) ? rawLabels : [];
  for (const label of labels) {
    const name = typeof label === "string" ? label : stringValue(asRecord(label).name);
    const match = /^status[:/](.+)$/i.exec(name ?? "");
    const status = parseTaskState(match?.[1]?.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_"));
    if (status) return status;
  }

  return null;
}
