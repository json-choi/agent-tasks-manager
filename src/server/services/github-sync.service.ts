import { createHmac, timingSafeEqual } from "node:crypto";
import type { TaskStore } from "../repositories/task-store.repository";
import type { Task } from "../shared/types";
import { asRecord, stringValue } from "../shared/utils";

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

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return store.recordGitHubSyncRun({
      status: "error",
      summary: { reason: "missing-token" },
      error: "GITHUB_TOKEN is not configured"
    });
  }

  const tasks = store.listTasks().filter((task) => !["done", "cancelled"].includes(task.status));
  let created = 0;
  let skipped = 0;

  for (const task of tasks) {
    if (task.githubRef || !settings.autoCreateIssues) {
      skipped += 1;
      continue;
    }
    const rule = settings.rules.find((candidate) => candidate.repo);
    if (!rule) {
      skipped += 1;
      continue;
    }

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
          labels: [...settings.labels, `priority:${task.priority}`, `status:${task.status}`],
          assignees: task.assignee && settings.assigneesByOwner[task.assignee] ? [settings.assigneesByOwner[task.assignee]] : []
        })
      });
      if (!response.ok) throw new Error(`GitHub issue create failed: ${response.status}`);
      const issue = await response.json() as { number?: number; html_url?: string };
      if (issue.number) {
        store.updateTask(task.id, { githubRef: `${rule.repo}#${issue.number}` });
        created += 1;
      }
    } catch (error) {
      return store.recordGitHubSyncRun({
        status: "error",
        summary: { created, skipped, taskId: task.id },
        error: error instanceof Error ? error.message : "GitHub sync failed"
      });
    }
  }

  return store.recordGitHubSyncRun({ status: "completed", summary: { created, skipped } });
}

export function summarizeGitHubWebhook(payload: unknown) {
  const record = asRecord(payload);
  return {
    action: stringValue(record.action),
    repository: stringValue(asRecord(record.repository).full_name)
  };
}

function githubIssueBody(task: Task): string {
  return [
    `Task Manager ID: ${task.id}`,
    "",
    task.description,
    "",
    `Priority: ${task.priority}`,
    `Status: ${task.status}`,
    task.assignee ? `Assignee: ${task.assignee}` : "",
    task.sourceUrl ? `Source: ${task.sourceUrl}` : "",
    task.nextAction ? `Next: ${task.nextAction}` : ""
  ].filter(Boolean).join("\n");
}
