import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOpenClawTaskManagerSkill } from "../agent-plugin/openclaw/task-manager-skill";
import {
  TaskManagerClient,
  TaskManagerApiError,
  classifyTaskCommand,
  normalizeSlackTaskificationRequest,
  parseSlackTaskificationRequest,
  type TaskManagerClient as TaskManagerClientShape
} from "../agent-plugin/shared/task-manager-client";

function readJsonFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

type SlackTaskificationExtractionExample = {
  name: string;
  input: Parameters<typeof parseSlackTaskificationRequest>[0];
  options?: Parameters<typeof parseSlackTaskificationRequest>[1];
  expected: {
    title: string;
    intent: Record<string, unknown>;
    context: Record<string, unknown>;
    candidates: Array<
      Record<string, unknown> & {
        taskification?: Record<string, unknown>;
        taskDescriptionIncludes?: string[];
      }
    >;
  };
};

const slackTaskificationExtractionExamples = readJsonFixture<{
  examples: SlackTaskificationExtractionExample[];
}>("tests/fixtures/slack-taskification/extraction-examples.json").examples;

function comparableSlackTaskCandidateOutput(actual: unknown, expected: unknown): unknown {
  if (expected === null || typeof expected !== "object") return actual;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return actual;
    return expected.map((expectedItem, index) => comparableSlackTaskCandidateOutput(actual[index], expectedItem));
  }

  const actualRecord = actual && typeof actual === "object" ? (actual as Record<string, unknown>) : {};
  const expectedRecord = expected as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(expectedRecord)
      .filter(([key]) => key !== "taskDescriptionIncludes")
      .map(([key, expectedValue]) => [key, comparableSlackTaskCandidateOutput(actualRecord[key], expectedValue)])
  );
}

describe("OpenClaw task manager skill", () => {
  test("classifies app mention taskification and skips the addressed bot mention", () => {
    expect(
      classifyTaskCommand("<@UOPENCLAW> taskify this for <@UALICE>", {
        eventType: "app_mention",
        agentUserId: "UOPENCLAW"
      })
    ).toEqual({ type: "propose", assigneeId: "UALICE" });
  });

  test("does not treat a generic app mention about tasks as taskification", () => {
    expect(
      classifyTaskCommand("<@UOPENCLAW> what tasks do I have?", {
        eventType: "app_mention",
        agentUserId: "UOPENCLAW"
      })
    ).toEqual({ type: "none" });
  });

  test("classifies conversational work asks as Slack taskification candidates", () => {
    expect(classifyTaskCommand("<@UALICE> can you ship the billing fix before 3pm?")).toEqual({
      type: "propose",
      assigneeId: "UALICE"
    });
    expect(classifyTaskCommand("Can someone review the launch checklist by EOD?")).toEqual({
      type: "propose",
      assigneeId: null
    });
  });

  test("does not classify casual Slack chatter as taskification intent", () => {
    expect(classifyTaskCommand("thanks <@UALICE>, sounds good")).toEqual({ type: "none" });
    expect(classifyTaskCommand("lol this deploy meme is great")).toEqual({ type: "none" });
    expect(classifyTaskCommand("thanks for fixing the billing bug, great work")).toEqual({ type: "none" });
    expect(classifyTaskCommand("the deploy bug discussion was useful")).toEqual({ type: "none" });
  });

  test("qualifies work messages only when they carry assignment or commitment signals", () => {
    expect(classifyTaskCommand("<@UALICE> please review the billing fix before EOD")).toEqual({
      type: "propose",
      assigneeId: "UALICE"
    });
    expect(classifyTaskCommand("Need an owner to investigate the checkout regression")).toEqual({
      type: "propose",
      assigneeId: null
    });
    expect(classifyTaskCommand("I'll update the incident notes by tomorrow")).toEqual({
      type: "propose",
      assigneeId: null
    });
    expect(classifyTaskCommand("The checkout regression is annoying")).toEqual({ type: "none" });
  });

  test("parses app mention payloads into structured taskification requests", () => {
    const request = parseSlackTaskificationRequest(
      {
        eventType: "app_mention",
        workspaceId: "T_WORK",
        text: "<@UOPENCLAW> taskify this for <@UALICE>: ship the billing fix",
        userId: "UREPORTER",
        userName: "Reporter",
        channelId: "C_WORK",
        channelName: "eng",
        messageTs: "1710000000.000900",
        threadTs: "1710000000.000800",
        permalink: "https://example.slack.com/archives/C_WORK/p1710000000000900"
      },
      { agentUserId: "UOPENCLAW" }
    );

    expect(request).toMatchObject({
      source: "app_mention",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      channelName: "eng",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      reporterId: "UREPORTER",
      reporterName: "Reporter",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000900",
      assigneeCandidates: ["UALICE"],
      primaryAssigneeId: "UALICE",
      command: { type: "propose", assigneeId: "UALICE" }
    });
    expect(request?.context).toMatchObject({
      channelId: "C_WORK",
      authorId: "UREPORTER",
      authorName: "Reporter",
      messages: [{ userId: "UREPORTER", ts: "1710000000.000900" }]
    });
  });

  test("parses conversational Slack messages into structured taskification requests", () => {
    const request = parseSlackTaskificationRequest({
      eventType: "message",
      workspaceId: "T_WORK",
      text: "<@UALICE> can you ship the billing fix before 3pm?",
      userId: "UREPORTER",
      channelId: "C_WORK",
      messageTs: "1710000000.000902"
    });

    expect(request).toMatchObject({
      source: "message",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000902",
      messageTs: "1710000000.000902",
      assigneeCandidates: ["UALICE"],
      primaryAssigneeId: "UALICE",
      command: { type: "propose", assigneeId: "UALICE" }
    });
  });

  test("parses slash command payloads and keeps all non-bot assignee candidates", () => {
    const request = parseSlackTaskificationRequest({
      eventType: "slash_command",
      teamId: "T_TEAM",
      text: "/task follow up with <@UALICE> and <@UBOB>",
      userId: "UREPORTER",
      channelId: "C_WORK",
      messageTs: "1710000000.000901"
    });

    expect(request).toMatchObject({
      source: "slash_command",
      workspaceId: "T_TEAM",
      threadTs: "1710000000.000901",
      assigneeCandidates: ["UALICE", "UBOB"],
      primaryAssigneeId: "UALICE",
      command: { type: "propose", assigneeId: "UALICE" }
    });
  });

  test("normalizes structured Slack taskification requests into ATM propose payloads", () => {
    const request = parseSlackTaskificationRequest(
      {
        eventType: "app_mention",
        workspaceId: "T_WORK",
        text: "<@UOPENCLAW> taskify this for <@UALICE>: ship the billing fix by 3pm",
        userId: "UREPORTER",
        channelId: "C_WORK",
        channelName: "eng",
        messageTs: "1710000000.000900",
        threadTs: "1710000000.000800",
        permalink: "https://example.slack.com/archives/C_WORK/p1710000000000900"
      },
      { agentUserId: "UOPENCLAW" }
    );

    expect(request).not.toBeNull();
    const normalized = normalizeSlackTaskificationRequest(request!);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      source: "app_mention",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      messageText: "<@UOPENCLAW> taskify this for <@UALICE>: ship the billing fix by 3pm",
      title: "Ship the billing fix by 3pm",
      assignee: "UALICE",
      assigneeCandidates: ["UALICE"],
      assigneeResolution: "assigned",
      requiresAssigneeConfirmation: false,
      reporter: "UREPORTER",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000900",
      priority: "P2",
      dueAt: "3pm",
      confirmationState: "proposed",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:UALICE",
      confirmed: false,
      automatic: false,
      taskification: {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        threadTs: "1710000000.000800",
        messageTs: "1710000000.000900",
        messageText: "<@UOPENCLAW> taskify this for <@UALICE>: ship the billing fix by 3pm",
        source: "app_mention",
        isWorkRelated: true,
        taskTitle: "Ship the billing fix by 3pm",
        assignee: "UALICE",
        assigneeCandidates: ["UALICE"],
        assigneeResolution: "assigned",
        requiresAssigneeConfirmation: false,
        leaderReviewer: "UREPORTER",
        confirmationTarget: "UREPORTER",
        confirmationState: "proposed",
        confirmationAction: null,
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:UALICE",
        dueAt: "3pm",
        nextAction: null,
        sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000900",
        markdownPath: null
      },
      context: {
        channelId: "C_WORK",
        threadTs: "1710000000.000800",
        messageTs: "1710000000.000900"
      }
    });
    expect(normalized[0]?.taskification.taskDescription).toContain("Slack taskification request:");
    expect(normalized[0]?.taskificationMetadata).toBe(normalized[0]?.taskification);
    expect(normalized[0]?.description).toContain("Original message:");
    expect(normalized[0]?.description).toContain("Source: https://example.slack.com/archives/C_WORK/p1710000000000900");
  });

  test("normalizes multi-mention taskification into one ATM request per assignee", () => {
    const request = parseSlackTaskificationRequest({
      eventType: "slash_command",
      teamId: "T_TEAM",
      text: "/task follow up with <@UALICE> and <@UBOB>: prep p1 launch checklist before tomorrow",
      userId: "UREPORTER",
      channelId: "C_WORK",
      messageTs: "1710000000.000901"
    });

    expect(request).not.toBeNull();
    const normalized = normalizeSlackTaskificationRequest(request!);

    expect(normalized.map((item) => item.assignee)).toEqual(["UALICE", "UBOB"]);
    expect(normalized.map((item) => item.assigneeResolution)).toEqual(["ambiguous", "ambiguous"]);
    expect(normalized.every((item) => item.requiresAssigneeConfirmation)).toBe(true);
    expect(normalized.map((item) => item.dedupeKey)).toEqual([
      "slack:T_TEAM:C_WORK:1710000000.000901:UALICE",
      "slack:T_TEAM:C_WORK:1710000000.000901:UBOB"
    ]);
    expect(normalized.map((item) => item.title)).toEqual([
      "Prep p1 launch checklist before tomorrow",
      "Prep p1 launch checklist before tomorrow"
    ]);
    expect(normalized.every((item) => item.priority === "P1")).toBe(true);
    expect(normalized.every((item) => item.dueAt === "tomorrow")).toBe(true);
  });

  test("normalizes unassigned Slack work messages for leader assignee confirmation", () => {
    const request = parseSlackTaskificationRequest({
      eventType: "message",
      workspaceId: "T_WORK",
      text: "Need an owner to investigate the checkout regression by EOD",
      userId: "ULEADER",
      channelId: "C_WORK",
      messageTs: "1710000000.000902",
      permalink: "https://example.slack.com/archives/C_WORK/p1710000000000902"
    });

    expect(request).not.toBeNull();
    const normalized = normalizeSlackTaskificationRequest(request!);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      title: "Need an owner to investigate the checkout regression by EOD",
      assigneeCandidates: [],
      assigneeResolution: "ambiguous",
      requiresAssigneeConfirmation: true,
      reporter: "ULEADER",
      dueAt: "EOD",
      confirmationState: "assigning",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000902:unassigned",
      automatic: true,
      taskification: {
        isWorkRelated: true,
        assignee: null,
        assigneeResolution: "ambiguous",
        requiresAssigneeConfirmation: true,
        leaderReviewer: "ULEADER",
        confirmationTarget: "ULEADER",
        confirmationState: "assigning",
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000902:unassigned",
        dueAt: "EOD",
        markdownPath: null
      }
    });
    expect(normalized[0]?.assignee).toBeUndefined();
  });

  test("normalizes conversational mention requests into concise candidate title and due context", () => {
    const request = parseSlackTaskificationRequest({
      eventType: "message",
      workspaceId: "T_WORK",
      text: "Can <@UALICE> document and share the TTS setup steps before demo?",
      userId: "UREPORTER",
      userName: "Reporter",
      channelId: "C_WORK",
      channelName: "eng",
      messageTs: "1710000000.000903",
      permalink: "https://example.slack.com/archives/C_WORK/p1710000000000903"
    });

    expect(request).toMatchObject({
      source: "message",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      channelName: "eng",
      reporterId: "UREPORTER",
      reporterName: "Reporter",
      assigneeCandidates: ["UALICE"],
      primaryAssigneeId: "UALICE",
      assigneeResolution: "assigned",
      requiresAssigneeConfirmation: false,
      context: {
        channelId: "C_WORK",
        threadTs: "1710000000.000903",
        messageTs: "1710000000.000903",
        authorId: "UREPORTER",
        authorName: "Reporter"
      }
    });

    const normalized = normalizeSlackTaskificationRequest(request!);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      title: "Document and share the TTS setup steps before demo?",
      dueAt: "demo",
      assignee: "UALICE",
      assigneeCandidates: ["UALICE"],
      confirmationState: "proposed",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000903:UALICE",
      taskification: {
        taskTitle: "Document and share the TTS setup steps before demo?",
        dueAt: "demo",
        sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000903"
      }
    });
    expect(normalized[0]?.description).toContain("Original message:");
    expect(normalized[0]?.description).toContain("Can <@UALICE> document and share the TTS setup steps before demo?");
  });

  test("matches Slack taskification extraction example fixtures", () => {
    for (const example of slackTaskificationExtractionExamples) {
      const request = parseSlackTaskificationRequest(example.input, example.options);
      expect(request, example.name).not.toBeNull();
      expect(request, example.name).toMatchObject({
        ...example.expected.intent,
        ...example.expected.context
      });

      const normalized = normalizeSlackTaskificationRequest(request!);
      expect(normalized, example.name).toHaveLength(example.expected.candidates.length);

      for (const [index, expectedCandidate] of example.expected.candidates.entries()) {
        const { taskDescriptionIncludes, ...expectedCandidateFields } = expectedCandidate;
        expect(normalized[index], `${example.name}:${index}`).toMatchObject(expectedCandidateFields);
        expect(normalized[index]?.taskificationMetadata, `${example.name}:${index}`).toBe(normalized[index]?.taskification);
        expect(normalized[index]?.taskification.taskDescription, `${example.name}:${index}`).toContain(example.expected.title);
        for (const expectedText of taskDescriptionIncludes ?? []) {
          expect(normalized[index]?.description, `${example.name}:${index}`).toContain(expectedText);
        }
      }
    }
  });

  for (const example of slackTaskificationExtractionExamples) {
    test(`exactly maps Slack taskification example candidate output: ${example.name}`, () => {
      const request = parseSlackTaskificationRequest(example.input, example.options);
      expect(request, example.name).not.toBeNull();

      const normalized = normalizeSlackTaskificationRequest(request!);
      expect(normalized, example.name).toHaveLength(example.expected.candidates.length);

      const expectedCandidates = example.expected.candidates.map(({ taskDescriptionIncludes, ...candidate }) => candidate);
      expect(
        normalized.map((candidate, index) => comparableSlackTaskCandidateOutput(candidate, example.expected.candidates[index])),
        example.name
      ).toEqual(expectedCandidates);

      for (const [index, expectedCandidate] of example.expected.candidates.entries()) {
        expect(normalized[index]?.taskificationMetadata, `${example.name}:${index}`).toBe(normalized[index]?.taskification);
        for (const expectedText of expectedCandidate.taskDescriptionIncludes ?? []) {
          expect(normalized[index]?.description, `${example.name}:${index}`).toContain(expectedText);
        }
      }
    });
  }

  test("routes Slack taskification HTTP to the configured ATM intake with agent authentication", async () => {
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const fetchImpl = Object.assign(async (input: URL | RequestInfo, init: RequestInit = {}) => {
      requests.push({
        url: String(input),
        init,
        body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>
      });
      return Response.json({ ok: true, actions: [{ kind: "thread_reply" }] });
    }, { preconnect: fetch.preconnect }) as typeof fetch;
    const client = new TaskManagerClient({
      apiUrl: "https://atm.example.com/",
      agentId: "agent_openclaw",
      token: "token_secret",
      slackTaskificationPath: "/custom/intake/slack-taskification",
      fetchImpl
    });

    const response = await client.proposeTask({
      context: {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        threadTs: "1710000000.000800",
        messageTs: "1710000000.000900",
        messages: [{ userId: "U_LEADER", text: "taskify this for <@U_ALICE>" }]
      },
      source: "app_mention",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      messageText: "taskify this for <@U_ALICE>",
      title: "Taskify this",
      description: "Slack taskification request",
      assignee: "U_ALICE",
      assigneeCandidates: ["U_ALICE"],
      confirmationState: "proposed",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE",
      confirmed: false,
      automatic: false
    });

    expect(response).toMatchObject({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://atm.example.com/custom/intake/slack-taskification");
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.headers).toMatchObject({
      "content-type": "application/json",
      "x-agent-id": "agent_openclaw",
      "x-atm-intake-trace-id": requests[0]?.body.intakeTraceId,
      authorization: "Bearer token_secret"
    });
    expect(requests[0]?.body).toMatchObject({
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE"
    });
    expect(String(requests[0]?.body.intakeTraceId)).toContain("slack_T_WORK_C_WORK_1710000000_000800_U_ALICE");
  });

  test("raises ATM intake failures with status, path, response body, and trace id", async () => {
    const fetchImpl = Object.assign(async () => {
      return Response.json({ ok: false, error: "intake exploded", intakeTraceId: "trace_from_atm" }, { status: 503 });
    }, { preconnect: fetch.preconnect }) as typeof fetch;
    const client = new TaskManagerClient({
      apiUrl: "https://atm.example.com",
      agentId: "agent_openclaw",
      token: "token_secret",
      fetchImpl
    });

    await expect(
      client.proposeTask({
        context: { channelId: "C_WORK", messageTs: "1710000000.000900" },
        title: "Ship billing fix",
        description: "Slack taskification request",
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000900:U_ALICE",
        confirmationState: "proposed",
        confirmed: false,
        automatic: false
      })
    ).rejects.toMatchObject({
      name: "TaskManagerApiError",
      status: 503,
      path: "/api/agent/task/propose",
      traceId: "trace_from_atm",
      responseBody: { ok: false, error: "intake exploded", intakeTraceId: "trace_from_atm" }
    });
  });

  test("does not parse bot-origin payloads into taskification requests", () => {
    expect(
      parseSlackTaskificationRequest({
        eventType: "app_mention",
        text: "<@UOPENCLAW> taskify this",
        botId: "BOPENCLAW",
        channelId: "C_WORK"
      })
    ).toBe(null);
  });

  test("detects app mention taskification through the Slack event handler", async () => {
    const proposeCalls: Array<Parameters<TaskManagerClient["proposeTask"]>[0]> = [];
    const client = {
      async proposeTask(input: Parameters<TaskManagerClient["proposeTask"]>[0]) {
        proposeCalls.push(input);
        return {
          actions: [
            {
              kind: "thread_reply",
              channelId: input.context.channelId,
              threadTs: input.context.threadTs,
              text: "Task proposed."
            }
          ]
        };
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({ client, agentUserId: "UOPENCLAW" });

    const actions = await skill.handleMessage({
      eventType: "app_mention",
      text: "<@UOPENCLAW> taskify this for <@UALICE>: ship the billing fix",
      userId: "UREPORTER",
      channelId: "C_WORK",
      messageTs: "1710000000.000900",
      threadTs: "1710000000.000800",
      permalink: "https://example.slack.com/archives/C_WORK/p1710000000000900"
    });

    expect(actions).toHaveLength(1);
    expect(proposeCalls).toHaveLength(1);
    expect(proposeCalls[0]?.assignee).toBe("UALICE");
    expect(proposeCalls[0]?.reporter).toBe("UREPORTER");
    expect(proposeCalls[0]?.title).toBe("Ship the billing fix");
    expect(proposeCalls[0]?.description).toContain("Slack taskification request:");
    expect(proposeCalls[0]?.context).toMatchObject({
      channelId: "C_WORK",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      authorId: "UREPORTER"
    });
  });

  test("keeps Slack taskification traceability when ATM intake routing fails", async () => {
    const logs: Array<{ level: "error" | "info"; args: unknown[] }> = [];
    const client = {
      async proposeTask(input: Parameters<TaskManagerClient["proposeTask"]>[0]) {
        throw new TaskManagerApiError("Task Manager API failed: unavailable", {
          status: 503,
          path: "/api/agent/task/propose",
          traceId: "trace_failed_123",
          responseBody: { error: "unavailable" }
        });
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({
      client,
      agentUserId: "UOPENCLAW",
      logger: {
        error: (...args: unknown[]) => logs.push({ level: "error", args }),
        info: (...args: unknown[]) => logs.push({ level: "info", args })
      }
    });

    const actions = await skill.handleMessage({
      eventType: "app_mention",
      text: "<@UOPENCLAW> taskify this for <@UALICE>: ship the billing fix",
      userId: "UREPORTER",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      messageTs: "1710000000.000900",
      threadTs: "1710000000.000800",
      permalink: "https://example.slack.com/archives/C_WORK/p1710000000000900"
    });

    expect(actions).toEqual([
      {
        kind: "thread_reply",
        channelId: "C_WORK",
        threadTs: "1710000000.000800",
        text: "ATM could not intake this task candidate because the service is temporarily unavailable. It is safe to retry later. Trace: trace_failed_123.",
        metadata: {
          type: "atm_slack_taskification_route_failure",
          traceId: "trace_failed_123",
          dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:UALICE",
          actionable: false
        }
      }
    ]);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.args[0]).toBe("atm.slack_taskification.route_failed");
    expect(logs[0]?.args[1]).toMatchObject({
      intakeTraceId: "trace_failed_123",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:UALICE",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      messageTs: "1710000000.000900",
      assignee: "UALICE",
      route: {
        agentName: "OpenClaw",
        source: "app_mention",
        confirmationState: "proposed",
        automatic: false,
        confirmed: false
      },
      slack: {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        threadTs: "1710000000.000800",
        messageTs: "1710000000.000900",
        sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000900",
        reporterId: "UREPORTER",
        messageText: "<@UOPENCLAW> taskify this for <@UALICE>: ship the billing fix"
      },
      taskCandidate: {
        title: "Ship the billing fix",
        assignee: "UALICE",
        assigneeCandidates: ["UALICE"],
        isWorkRelated: true
      },
      failureCause: {
        type: "atm_api_error",
        message: "Task Manager API failed: unavailable",
        status: 503,
        path: "/api/agent/task/propose",
        traceId: "trace_failed_123",
        responseBody: { error: "unavailable" }
      }
    });
  });

  test("gives actionable Slack feedback for ATM auth routing failures", async () => {
    const client = {
      async proposeTask() {
        throw new TaskManagerApiError("Task Manager API failed: unauthorized", {
          status: 401,
          path: "/api/agent/task/propose",
          traceId: "trace_auth_123",
          responseBody: { error: "unauthorized" }
        });
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({ client, agentUserId: "UOPENCLAW" });

    const actions = await skill.handleMessage({
      eventType: "app_mention",
      text: "<@UOPENCLAW> taskify this for <@UALICE>: ship the billing fix",
      userId: "UREPORTER",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      messageTs: "1710000000.000900",
      threadTs: "1710000000.000800"
    });

    expect(actions).toEqual([
      {
        kind: "thread_reply",
        channelId: "C_WORK",
        threadTs: "1710000000.000800",
        text: "ATM rejected this task candidate because OpenClaw is not authorized. Ask an ATM admin to refresh the OpenClaw agent token. Trace: trace_auth_123.",
        metadata: {
          type: "atm_slack_taskification_route_failure",
          traceId: "trace_auth_123",
          dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:UALICE",
          actionable: true
        }
      }
    ]);
  });

  test("does not attempt Slack feedback when a routing failure has no thread target", async () => {
    const client = {
      async proposeTask() {
        throw new TaskManagerApiError("Task Manager API failed: invalid payload", {
          status: 422,
          path: "/api/agent/task/propose",
          traceId: "trace_invalid_123",
          responseBody: { error: "invalid payload" }
        });
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({ client, agentUserId: "UOPENCLAW" });

    const actions = await skill.handleMessage({
      eventType: "app_mention",
      text: "<@UOPENCLAW> taskify this for <@UALICE>: ship the billing fix",
      userId: "UREPORTER",
      workspaceId: "T_WORK",
      messageTs: "1710000000.000900"
    });

    expect(actions).toEqual([]);
  });

  test("ignores bot-origin Slack taskification mentions", async () => {
    let proposed = false;
    const client = {
      async proposeTask(input: Parameters<TaskManagerClient["proposeTask"]>[0]) {
        proposed = Boolean(input);
        return { actions: [] };
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({ client, agentUserId: "UOPENCLAW" });

    const actions = await skill.handleMessage({
      eventType: "app_mention",
      text: "<@UOPENCLAW> taskify this",
      botId: "BOPENCLAW",
      channelId: "C_WORK"
    });

    expect(actions).toEqual([]);
    expect(proposed).toBe(false);
  });

  test("sends one propose request per mentioned assignee through the Slack event handler", async () => {
    const proposeCalls: Array<Parameters<TaskManagerClient["proposeTask"]>[0]> = [];
    const client = {
      async proposeTask(input: Parameters<TaskManagerClient["proposeTask"]>[0]) {
        proposeCalls.push(input);
        return { actions: [{ kind: "thread_reply", channelId: input.context.channelId, threadTs: input.context.threadTs }] };
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({ client, agentUserId: "UOPENCLAW" });

    const actions = await skill.handleMessage({
      eventType: "app_mention",
      text: "<@UOPENCLAW> taskify this for <@UALICE> and <@UBOB>: prep launch checklist",
      userId: "UREPORTER",
      channelId: "C_WORK",
      messageTs: "1710000000.000900"
    });

    expect(actions).toHaveLength(2);
    expect(proposeCalls.map((input) => input.assignee)).toEqual(["UALICE", "UBOB"]);
    expect(proposeCalls.every((input) => input.title === "Prep launch checklist")).toBe(true);
  });

  test("surfaces the configured Slack collection scope through the OpenClaw skill", async () => {
    const client = {
      async slackCollectionScope() {
        return {
          ok: true,
          collectionScope: {
            workspace: "TWORK",
            workspaces: ["TWORK"],
            channels: ["CENG"],
            channelThreadScopes: { CENG: "full_thread_history" },
            threads: ["1710000000.000400"],
            mentions: ["U111"],
            keywords: ["deploy"],
            updatedAt: "2026-05-08T00:00:00.000Z"
          },
          targets: [
            {
              workspaceId: "TWORK",
              channelId: "CENG",
              threadCollectionMode: "full_thread_history",
              cursor: null
            }
          ]
        };
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({ client });

    await expect(skill.getSlackCollectionScope()).resolves.toMatchObject({
      collectionScope: {
        workspaces: ["TWORK"],
        channels: ["CENG"],
        mentions: ["U111"],
        keywords: ["deploy"]
      },
      targets: [
        {
          workspaceId: "TWORK",
          channelId: "CENG",
          threadCollectionMode: "full_thread_history"
        }
      ]
    });
  });

  test("loads and validates saved Slack collection scope before scheduled collection starts", async () => {
    const client = {
      async slackCollectionScope() {
        return {
          ok: true,
          collectionScope: {
            workspace: null,
            workspaces: [],
            channels: [],
            channelThreadScopes: {},
            threads: [],
            mentions: [],
            keywords: [],
            updatedAt: null
          },
          validation: {
            invalid: {
              channels: ["At least one Slack channel must be configured before collection."]
            },
            duplicates: {},
            saved: {
              workspaces: [],
              channels: [],
              threads: [],
              mentions: [],
              keywords: [],
              channelThreadScopes: []
            },
            hasInvalid: true,
            hasDuplicates: false
          },
          collectionReady: false,
          targets: []
        };
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({ client });

    await expect(skill.getScheduledSlackCollectionScope()).rejects.toThrow(
      "Slack collection scope is not ready for scheduled collection"
    );
  });

  test("returns validated Slack collection targets when scheduled collection scope is ready", async () => {
    const logs: unknown[] = [];
    const client = {
      async slackCollectionScope() {
        return {
          ok: true,
          collectionScope: {
            workspace: "TWORK",
            workspaces: ["TWORK"],
            channels: ["CENG", "CPROD"],
            channelThreadScopes: {
              CENG: "parent_messages",
              CPROD: "full_thread_history"
            },
            threads: ["1710000000.000400"],
            mentions: ["U111"],
            keywords: ["deploy"],
            updatedAt: "2026-05-08T00:00:00.000Z"
          },
          validation: {
            invalid: {},
            duplicates: {},
            saved: {
              workspaces: ["TWORK"],
              channels: ["CENG", "CPROD"],
              threads: ["1710000000.000400"],
              mentions: ["U111"],
              keywords: ["deploy"],
              channelThreadScopes: ["CENG=parent_messages", "CPROD=full_thread_history"]
            },
            hasInvalid: false,
            hasDuplicates: false
          },
          collectionReady: true,
          targets: [
            {
              workspaceId: "TWORK",
              channelId: "CENG",
              threadCollectionMode: "parent_messages",
              cursor: null
            },
            {
              workspaceId: "TWORK",
              channelId: "CPROD",
              threadCollectionMode: "full_thread_history",
              cursor: null
            }
          ]
        };
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({
      client,
      logger: { info: (...args: unknown[]) => logs.push(args), error: () => undefined }
    });

    await expect(skill.getScheduledSlackCollectionScope()).resolves.toMatchObject({
      collectionScope: {
        workspaces: ["TWORK"],
        channels: ["CENG", "CPROD"],
        mentions: ["U111"],
        keywords: ["deploy"]
      },
      targets: [
        {
          workspaceId: "TWORK",
          channelId: "CENG",
          threadCollectionMode: "parent_messages"
        },
        {
          workspaceId: "TWORK",
          channelId: "CPROD",
          threadCollectionMode: "full_thread_history"
        }
      ]
    });
    expect(logs[0]).toEqual([
      "atm.slack_collection.scope_loaded",
      {
        workspaces: ["TWORK"],
        channels: ["CENG", "CPROD"],
        targets: [
          {
            workspaceId: "TWORK",
            channelId: "CENG",
            threadCollectionMode: "parent_messages"
          },
          {
            workspaceId: "TWORK",
            channelId: "CPROD",
            threadCollectionMode: "full_thread_history"
          }
        ]
      }
    ]);
  });

  test("scheduled Slack collection collects configured targets and commits digests", async () => {
    const collectCalls: unknown[] = [];
    const commitCalls: unknown[] = [];
    const logs: unknown[] = [];
    const client = {
      async slackCollectionScope() {
        return {
          ok: true,
          collectionScope: {
            workspace: "TWORK",
            workspaces: ["TWORK"],
            channels: ["CENG"],
            channelThreadScopes: {
              CENG: "active_threads"
            },
            threads: [],
            mentions: ["U111"],
            keywords: ["deploy"],
            updatedAt: "2026-05-08T00:00:00.000Z"
          },
          validation: {
            invalid: {},
            duplicates: {},
            saved: {
              workspaces: ["TWORK"],
              channels: ["CENG"],
              threads: [],
              mentions: ["U111"],
              keywords: ["deploy"],
              channelThreadScopes: ["CENG=active_threads"]
            },
            hasInvalid: false,
            hasDuplicates: false
          },
          collectionReady: true,
          targets: [
            {
              workspaceId: "TWORK",
              channelId: "CENG",
              threadCollectionMode: "active_threads",
              cursor: {
                agentId: "agent_openclaw",
                channelId: "CENG",
                lastTs: "1710000000.000100",
                lastScannedAt: "2026-05-08T00:00:00.000Z",
                includeThreads: true
              }
            }
          ]
        };
      },
      async collectSlackDigest(input: unknown) {
        collectCalls.push(input);
        return { ok: true, digest: { id: "digest_1" } };
      },
      async commitSlackDigest(input: unknown) {
        commitCalls.push(input);
        return { ok: true, tasks: [{ id: "task_1" }] };
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({
      client,
      logger: { info: (...args: unknown[]) => logs.push(args), error: () => undefined }
    });

    const result = await skill.runScheduledSlackCollection(async (target, scope) => {
      expect(target.channelId).toBe("CENG");
      expect(scope.collectionScope.keywords).toEqual(["deploy"]);
      return {
        channelName: "eng",
        nextLastTs: "1710000001.000100",
        messages: [
          {
            ts: "1710000001.000100",
            userId: "U111",
            text: "<@U111> please review the deploy checklist"
          }
        ]
      };
    });

    expect(result).toMatchObject({
      ok: true,
      digests: [
        {
          workspaceId: "TWORK",
          channelId: "CENG",
          threadCollectionMode: "active_threads",
          messageCount: 1,
          digestId: "digest_1",
          committed: true
        }
      ]
    });
    expect(collectCalls).toEqual([
      {
        workspaceId: "TWORK",
        workspaceName: null,
        channelId: "CENG",
        channelName: "eng",
        messages: [
          {
            ts: "1710000001.000100",
            userId: "U111",
            text: "<@U111> please review the deploy checklist"
          }
        ],
        nextLastTs: "1710000001.000100",
        threadCollectionMode: "active_threads",
        includeThreads: true,
        collectionScope: expect.objectContaining({
          workspaces: ["TWORK"],
          channels: ["CENG"],
          mentions: ["U111"],
          keywords: ["deploy"]
        })
      }
    ]);
    expect(commitCalls).toEqual([{ digestId: "digest_1", createTasks: true }]);
    expect(logs).toContainEqual([
      "atm.slack_collection.scheduled_run_started",
      {
        targetCount: 1,
        workspaces: ["TWORK"],
        channels: ["CENG"]
      }
    ]);
    expect(logs).toContainEqual([
      "atm.slack_collection.target_started",
      {
        workspaceId: "TWORK",
        channelId: "CENG",
        threadCollectionMode: "active_threads",
        cursorLastTs: "1710000000.000100",
        includeThreads: true
      }
    ]);
    expect(logs).toContainEqual([
      "atm.slack_collection.target_collected",
      {
        workspaceId: "TWORK",
        channelId: "CENG",
        threadCollectionMode: "active_threads",
        cursorLastTs: "1710000000.000100",
        includeThreads: true,
        messageCount: 1,
        nextLastTs: "1710000001.000100"
      }
    ]);
    expect(logs).toContainEqual([
      "atm.slack_collection.target_completed",
      {
        workspaceId: "TWORK",
        channelId: "CENG",
        threadCollectionMode: "active_threads",
        cursorLastTs: "1710000000.000100",
        includeThreads: true,
        messageCount: 1,
        digestId: "digest_1",
        committed: true
      }
    ]);
    expect(logs.at(-1)).toEqual([
      "atm.slack_collection.scheduled_run",
      {
        targetCount: 1,
        digestCount: 1,
        committedCount: 1,
        failureCount: 0
      }
    ]);
  });

  test("scheduled Slack collection continues through all configured targets when one target fails", async () => {
    const collectCalls: string[] = [];
    const commitCalls: unknown[] = [];
    const errorLogs: unknown[] = [];
    const client = {
      async slackCollectionScope() {
        return {
          ok: true,
          collectionScope: {
            workspace: "TWORK",
            workspaces: ["TWORK"],
            channels: ["CENG", "CPROD"],
            channelThreadScopes: {
              CENG: "active_threads",
              CPROD: "parent_messages"
            },
            threads: [],
            mentions: ["U111"],
            keywords: ["deploy"],
            updatedAt: "2026-05-08T00:00:00.000Z"
          },
          validation: {
            invalid: {},
            duplicates: {},
            saved: {
              workspaces: ["TWORK"],
              channels: ["CENG", "CPROD"],
              threads: [],
              mentions: ["U111"],
              keywords: ["deploy"],
              channelThreadScopes: ["CENG=active_threads", "CPROD=parent_messages"]
            },
            hasInvalid: false,
            hasDuplicates: false
          },
          collectionReady: true,
          targets: [
            {
              workspaceId: "TWORK",
              channelId: "CENG",
              threadCollectionMode: "active_threads",
              cursor: null
            },
            {
              workspaceId: "TWORK",
              channelId: "CPROD",
              threadCollectionMode: "parent_messages",
              cursor: null
            }
          ]
        };
      },
      async collectSlackDigest(input: unknown) {
        return { ok: true, digest: { id: `digest_${(input as { channelId: string }).channelId}` } };
      },
      async commitSlackDigest(input: unknown) {
        commitCalls.push(input);
        return { ok: true, tasks: [] };
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({
      client,
      logger: { info: () => undefined, error: (...args: unknown[]) => errorLogs.push(args) }
    });

    const result = await skill.runScheduledSlackCollection(async (target) => {
      collectCalls.push(target.channelId);
      if (target.channelId === "CENG") throw new Error("Slack history API failed");
      return {
        messages: [
          {
            ts: "1710000001.000200",
            userId: "U111",
            text: "<@U111> please review deploy notes"
          }
        ],
        nextLastTs: "1710000001.000200"
      };
    });

    expect(collectCalls).toEqual(["CENG", "CPROD"]);
    expect(result).toMatchObject({
      ok: true,
      digests: [
        {
          workspaceId: "TWORK",
          channelId: "CPROD",
          threadCollectionMode: "parent_messages",
          messageCount: 1,
          digestId: "digest_CPROD",
          committed: true
        }
      ],
      failures: [
        {
          workspaceId: "TWORK",
          channelId: "CENG",
          threadCollectionMode: "active_threads",
          stage: "collect",
          error: "Slack history API failed"
        }
      ]
    });
    expect(commitCalls).toEqual([{ digestId: "digest_CPROD", createTasks: true }]);
    expect(errorLogs).toEqual([
      [
        "atm.slack_collection.target_failed",
        {
          workspaceId: "TWORK",
          channelId: "CENG",
          threadCollectionMode: "active_threads",
          stage: "collect",
          error: "Slack history API failed"
        }
      ]
    ]);
  });

  test("scheduled Slack collection logs digest-stage failures per target without stopping other scopes", async () => {
    const commitCalls: unknown[] = [];
    const infoLogs: unknown[] = [];
    const errorLogs: unknown[] = [];
    const client = {
      async slackCollectionScope() {
        return {
          ok: true,
          collectionScope: {
            workspace: "TWORK",
            workspaces: ["TWORK"],
            channels: ["CENG", "CPROD", "COPS"],
            channelThreadScopes: {
              CENG: "active_threads",
              CPROD: "parent_messages",
              COPS: "full_thread_history"
            },
            threads: [],
            mentions: ["U111"],
            keywords: ["deploy"],
            updatedAt: "2026-05-08T00:00:00.000Z"
          },
          validation: {
            invalid: {},
            duplicates: {},
            saved: {
              workspaces: ["TWORK"],
              channels: ["CENG", "CPROD", "COPS"],
              threads: [],
              mentions: ["U111"],
              keywords: ["deploy"],
              channelThreadScopes: ["CENG=active_threads", "CPROD=parent_messages", "COPS=full_thread_history"]
            },
            hasInvalid: false,
            hasDuplicates: false
          },
          collectionReady: true,
          targets: [
            {
              workspaceId: "TWORK",
              channelId: "CENG",
              threadCollectionMode: "active_threads",
              cursor: null
            },
            {
              workspaceId: "TWORK",
              channelId: "CPROD",
              threadCollectionMode: "parent_messages",
              cursor: null
            },
            {
              workspaceId: "TWORK",
              channelId: "COPS",
              threadCollectionMode: "full_thread_history",
              cursor: null
            }
          ]
        };
      },
      async collectSlackDigest(input: unknown) {
        const channelId = (input as { channelId: string }).channelId;
        if (channelId === "CENG") throw new Error("ATM digest collect failed");
        return { ok: true, digest: { id: `digest_${channelId}` } };
      },
      async commitSlackDigest(input: unknown) {
        commitCalls.push(input);
        if ((input as { digestId: string }).digestId === "digest_CPROD") throw new Error("ATM digest commit failed");
        return { ok: true, tasks: [] };
      }
    } as unknown as TaskManagerClientShape;
    const skill = createOpenClawTaskManagerSkill({
      client,
      logger: { info: (...args: unknown[]) => infoLogs.push(args), error: (...args: unknown[]) => errorLogs.push(args) }
    });

    const result = await skill.runScheduledSlackCollection(async (target) => ({
      messages: [
        {
          ts: `1710000001.${target.channelId}`,
          userId: "U111",
          text: "<@U111> please review deploy notes"
        }
      ],
      nextLastTs: `1710000001.${target.channelId}`
    }));

    expect(result).toMatchObject({
      ok: true,
      digests: [
        {
          workspaceId: "TWORK",
          channelId: "CPROD",
          threadCollectionMode: "parent_messages",
          messageCount: 1,
          digestId: "digest_CPROD",
          committed: false
        },
        {
          workspaceId: "TWORK",
          channelId: "COPS",
          threadCollectionMode: "full_thread_history",
          messageCount: 1,
          digestId: "digest_COPS",
          committed: true
        }
      ],
      failures: [
        {
          workspaceId: "TWORK",
          channelId: "CENG",
          threadCollectionMode: "active_threads",
          stage: "digest_collect",
          error: "ATM digest collect failed"
        },
        {
          workspaceId: "TWORK",
          channelId: "CPROD",
          threadCollectionMode: "parent_messages",
          stage: "digest_commit",
          error: "ATM digest commit failed"
        }
      ]
    });
    expect(commitCalls).toEqual([{ digestId: "digest_CPROD", createTasks: true }, { digestId: "digest_COPS", createTasks: true }]);
    expect(infoLogs.filter((entry) => Array.isArray(entry) && entry[0] === "atm.slack_collection.target_started")).toHaveLength(3);
    expect(infoLogs.filter((entry) => Array.isArray(entry) && entry[0] === "atm.slack_collection.target_completed")).toHaveLength(2);
    expect(infoLogs.at(-1)).toEqual([
      "atm.slack_collection.scheduled_run",
      {
        targetCount: 3,
        digestCount: 2,
        committedCount: 1,
        failureCount: 2
      }
    ]);
    expect(errorLogs).toEqual([
      [
        "atm.slack_collection.target_failed",
        {
          workspaceId: "TWORK",
          channelId: "CENG",
          threadCollectionMode: "active_threads",
          stage: "digest_collect",
          error: "ATM digest collect failed"
        }
      ],
      [
        "atm.slack_collection.target_failed",
        {
          workspaceId: "TWORK",
          channelId: "CPROD",
          threadCollectionMode: "parent_messages",
          stage: "digest_commit",
          error: "ATM digest commit failed"
        }
      ]
    ]);
  });
});
