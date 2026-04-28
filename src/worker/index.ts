import { adapterFor } from "../server/adapters/agent-adapter";
import { loadConfig } from "../server/config/app-config";
import { TaskStore } from "../server/repositories/task-store.repository";

const config = loadConfig();
const store = new TaskStore(config.dataDir);
const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? "60000");
const dailyDigestEnabled = process.env.DAILY_DIGEST_ENABLED === "1";
const dailyDigestHour = Number(process.env.DAILY_DIGEST_HOUR ?? "9");
let lastDailyDigestDate: string | null = null;

async function tick(): Promise<void> {
  let changed = 0;

  for (const task of store.getOpenAssignmentsOlderThan(60)) {
    const updated = store.updateTask(task.id, { status: "blocked" });
    if (updated?.sourceAgentId) {
      const agent = store.getAgent(updated.sourceAgentId);
      if (agent) {
        store.enqueueOutbox(agent.id, "slack.actions", {
          taskId: updated.id,
          actions: adapterFor(agent.type).postTaskUpdate(
            updated,
            `${updated.id} assignment has not been accepted yet and is now blocked.`
          )
        });
      }
    }
    changed += 1;
  }

  for (const request of store.getPendingAssignmentRequestsOlderThan(60)) {
    store.updateAssignmentRequest(request.id, { status: "expired" });
    changed += 1;
  }

  for (const task of store.getStaleInProgressOlderThan(7)) {
    const updated = store.updateTask(task.id, { status: "review_needed" });
    if (updated?.sourceAgentId) {
      const agent = store.getAgent(updated.sourceAgentId);
      if (agent) {
        store.enqueueOutbox(agent.id, "slack.actions", {
          taskId: updated.id,
          actions: adapterFor(agent.type).postTaskUpdate(
            updated,
            `${updated.id} has been in progress for more than seven days and needs review.`
          )
        });
      }
    }
    changed += 1;
  }

  if (shouldRunDailyDigest(new Date())) {
    changed += enqueueDailyDigests();
  }

  if (changed > 0) {
    console.log(`task-manager-worker processed ${changed} task(s)`);
  }
}

function shouldRunDailyDigest(now: Date): boolean {
  if (!dailyDigestEnabled) return false;
  if (Number.isNaN(dailyDigestHour) || now.getHours() !== dailyDigestHour) return false;
  const dateKey = now.toISOString().slice(0, 10);
  if (lastDailyDigestDate === dateKey) return false;
  lastDailyDigestDate = dateKey;
  return true;
}

function enqueueDailyDigests(): number {
  const agentId = process.env.DAILY_DIGEST_AGENT_ID;
  const agent = agentId
    ? store.getAgent(agentId)
    : store.listAgents().find((candidate) => candidate.status === "connected") ?? store.listAgents()[0] ?? null;
  if (!agent) return 0;

  let enqueued = 0;
  for (const owner of store.listOwners().filter((candidate) => candidate.active)) {
    const userId = owner.slackUserId;
    if (!userId) continue;
    const tasks = store
      .listTasks({ assignee: owner.ownerName })
      .filter((task) => !["proposed", "done", "cancelled"].includes(task.status))
      .slice(0, 10);
    if (tasks.length === 0) continue;

    store.enqueueOutbox(agent.id, "slack.actions", {
      actions: [
        {
          kind: "dm",
          userId,
          text: renderDailyDigest(owner.ownerName, tasks)
        }
      ]
    });
    enqueued += 1;
  }
  return enqueued;
}

function renderDailyDigest(ownerName: string, tasks: ReturnType<TaskStore["listTasks"]>): string {
  return [
    `Today's tasks for ${ownerName}:`,
    ...tasks.map((task) => {
      const next = task.nextAction ? ` - ${task.nextAction}` : "";
      return `- ${task.id} [${task.priority}/${task.status}] ${task.title}${next}`;
    })
  ].join("\n");
}

if (process.env.WORKER_ONCE === "1") {
  await tick();
  store.close();
} else {
  console.log(`task-manager-worker running every ${intervalMs}ms`);
  await tick();
  setInterval(() => {
    tick().catch((error) => {
      console.error("worker tick failed", error);
    });
  }, intervalMs);

  process.on("SIGINT", () => {
    store.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    store.close();
    process.exit(0);
  });
}
