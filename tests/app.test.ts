import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyTaskCommand } from "../agent-plugin/shared/task-manager-client";
import { taskMemberColumns, taskStatusGroupSections } from "../src/client/lib/tasks";
import { createRuntime } from "../src/server/app";
import type { AppConfig } from "../src/server/config/app-config";
import type { Runtime } from "../src/server/context";
import { bootstrapFromEnv } from "../src/server/services/bootstrap.service";
import { OpenClawAdapter } from "../src/server/adapters/agent-adapter";
import {
  classifySlackTaskificationMessage,
  slackTaskificationEligibilityRuleIds,
  slackTaskificationEligibilitySchema,
  slackTaskificationExclusionReasonIds
} from "../src/shared/slack-qualification";
import {
  buildSlackTaskCandidateConfirmationMessage,
  detectSlackMemberMappingUncertainties,
  fallbackSlackTaskCandidateClassification,
  parseSlackDigestMessage,
  slackTaskCandidateClassificationOptions,
  validateSlackTaskCandidateMetadata
} from "../src/server/services/slack-task.service";
import {
  parseSlackConfirmationActionId,
  parseSlackConfirmationCallbackId,
  parseSlackConfirmationResponseState
} from "../src/server/shared/parsers";
import {
  slackConfirmationActionId,
  slackConfirmationCallbackId,
  slackConfirmationCallbackIds,
  slackConfirmationResponseStates,
  slackCollectionRunStatuses,
  slackCollectionTriggers,
  slackTaskCandidateSchema,
  type OwnerMapping,
  type SlackCollectedMessage,
  type SlackCollectionRun,
  type SlackConfirmationPayload,
  type SlackTaskCandidateMetadata,
  type Task
} from "../src/server/shared/types";

const runtimes: Runtime[] = [];
const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalGitHubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

function readJsonFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("GITHUB_TOKEN", originalGitHubToken);
  restoreEnv("GITHUB_WEBHOOK_SECRET", originalGitHubWebhookSecret);
  for (const runtime of runtimes.splice(0)) {
    runtime.store.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("task-manager core", () => {
  test("Slack taskification eligibility rules expose collected-message classification schema", () => {
    const classification = classifySlackTaskificationMessage(
      "Can <@U_ALICE> review the checkout fix before 3pm? cc <@U_ATM>",
      {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        threadTs: "1710000000.000800",
        messageTs: "1710000000.000900",
        addressedUserIds: ["U_ATM"]
      }
    );
    const chat = classifySlackTaskificationMessage("thanks, sounds good", {
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      messageTs: "1710000001.000900"
    });
    const taskListQuery = classifySlackTaskificationMessage("do I have any tasks today?", {
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      messageTs: "1710000001.500900"
    });
    const discussion = classifySlackTaskificationMessage("the checkout regression is annoying but let's discuss later", {
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      messageTs: "1710000002.000900"
    });
    const socialAsk = classifySlackTaskificationMessage("Can <@U_ALICE> review the lunch menu before EOD?", {
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      messageTs: "1710000002.500900"
    });

    expect(slackTaskificationEligibilitySchema.version).toBe("slack_taskification_eligibility.v1");
    expect(Object.keys(slackTaskificationEligibilitySchema.eligibilityRules)).toEqual([
      ...slackTaskificationEligibilityRuleIds
    ]);
    expect(Object.keys(slackTaskificationEligibilitySchema.exclusionRules)).toEqual([
      ...slackTaskificationExclusionReasonIds
    ]);
    expect(slackTaskificationEligibilitySchema.output.fields).toMatchObject({
      workspaceId: "string|null",
      channelId: "string|null",
      threadTs: "string|null",
      messageTs: "string|null",
      messageText: "string",
      qualifies: "boolean",
      isWorkRelated: "boolean",
      assigneeResolution:
        "assigned when exactly one assignee is detected, ambiguous for multi-target or group-owner wording, otherwise unassigned",
      requiresAssigneeConfirmation: "true when a work-related candidate lacks one clear assignee"
    });
    expect(classification).toMatchObject({
      schemaVersion: slackTaskificationEligibilitySchema.version,
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      qualifies: true,
      isWorkRelated: true,
      reason: "mention-assignment",
      excludedReason: null,
      assigneeCandidates: ["U_ALICE"],
      assigneeResolution: "assigned",
      requiresAssigneeConfirmation: false
    });
    expect(chat).toMatchObject({
      qualifies: false,
      isWorkRelated: false,
      reason: null,
      excludedReason: "casual",
      assigneeResolution: "unassigned",
      requiresAssigneeConfirmation: false
    });
    expect(taskListQuery).toMatchObject({
      qualifies: false,
      isWorkRelated: false,
      reason: null,
      excludedReason: "casual"
    });
    expect(discussion).toMatchObject({
      qualifies: false,
      isWorkRelated: false,
      reason: null,
      excludedReason: "no-work-action",
      assigneeResolution: "unassigned",
      requiresAssigneeConfirmation: false
    });
    expect(socialAsk).toMatchObject({
      qualifies: false,
      isWorkRelated: false,
      reason: null,
      excludedReason: "casual",
      assigneeCandidates: ["U_ALICE"],
      assigneeResolution: "assigned",
      requiresAssigneeConfirmation: false
    });
    expect(classifySlackTaskificationMessage("P1 prepare the deploy checklist before release")).toMatchObject({
      qualifies: true,
      isWorkRelated: true,
      assigneeCandidates: [],
      assigneeResolution: "unassigned",
      requiresAssigneeConfirmation: true
    });
    expect(classifySlackTaskificationMessage("Someone needs to triage checkout failures")).toMatchObject({
      qualifies: true,
      isWorkRelated: true,
      reason: "team-assignment",
      excludedReason: null,
      assigneeCandidates: [],
      assigneeResolution: "ambiguous",
      requiresAssigneeConfirmation: true
    });
    expect(classifySlackTaskificationMessage("Can <@U_ALICE> and <@U_BOB> review the checkout fix?")).toMatchObject({
      qualifies: true,
      isWorkRelated: true,
      assigneeCandidates: ["U_ALICE", "U_BOB"],
      assigneeResolution: "ambiguous",
      requiresAssigneeConfirmation: true
    });
  });

  test("Slack member mapping uncertainty classifies unmapped authors and mentioned users", () => {
    const uncertainties = detectSlackMemberMappingUncertainties(
      {
        authorId: "U_LEADER",
        authorName: "Team Lead",
        assigneeCandidates: ["U_ALICE", "U_UNKNOWN", "U_UNKNOWN"]
      },
      (value) => (value === "U_ALICE" ? { ownerName: "Alice" } : null)
    );

    expect(uncertainties).toEqual([
      {
        subject: "author",
        slackUserId: "U_LEADER",
        slackUserName: "Team Lead",
        reason: "unmapped_slack_user"
      },
      {
        subject: "mentioned_user",
        slackUserId: "U_UNKNOWN",
        slackUserName: null,
        reason: "unmapped_slack_user"
      }
    ]);
  });

  test("Slack confirmation schema defines candidate metadata, callback/action ids, and response states", () => {
    const candidate: SlackTaskCandidateMetadata = {
      candidateId: "cand_1",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      messageText: "Can <@U_ALICE> ship the billing fix before 3pm?",
      taskTitle: "Ship the billing fix",
      taskDescription: "Slack work item proposed from #eng.",
      taskClassification: "coding",
      sourceChannel: {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        channelName: "eng",
        threadTs: "1710000000.000800",
        messageTs: "1710000000.000900"
      },
      sourceMessageLink: "https://example.slack.com/archives/C_WORK/p1710000000000900",
      requester: "U_LEADER",
      relevantContext: ["Can <@U_ALICE> ship the billing fix before 3pm?"],
      assignee: "Alice",
      assigneeCandidates: ["U_ALICE"],
      assigneeResolution: "assigned",
      requiresAssigneeConfirmation: false,
      memberMappingUncertainties: [],
      leaderReviewer: "U_LEADER",
      confirmationTarget: "U_ALICE",
      confirmationState: "proposed",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE",
      dueAt: "2026-05-08T15:00:00.000+09:00",
      nextAction: "Ship the billing fix",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000900",
      markdownPath: null
    };
    const payload: SlackConfirmationPayload = {
      callbackId: slackConfirmationCallbackId.taskCandidateConfirmation,
      actionId: slackConfirmationActionId.candidateSelectClassification,
      confirmationAction: "select_classification",
      responseState: "proposed",
      candidate,
      requestId: null,
      taskId: null,
      selectedAssignee: "Alice",
      selectedClassification: "coding",
      responseText: null
    };

    expect(slackConfirmationCallbackIds).toContain("atm_assignment_confirmation");
    expect(parseSlackConfirmationActionId(slackConfirmationActionId.candidateSelectClassification)).toBe(
      "atm_candidate_select_classification"
    );
    expect(fallbackSlackTaskCandidateClassification).toBe("general");
    expect(slackTaskCandidateClassificationOptions).toEqual([
      { text: { type: "plain_text", text: "General" }, value: "general" },
      { text: { type: "plain_text", text: "Coding" }, value: "coding" }
    ]);
    expect(slackConfirmationResponseStates).toEqual([
      "proposed",
      "assigning",
      "confirmed",
      "in_progress",
      "blocked",
      "review_needed"
    ]);
    expect(parseSlackConfirmationCallbackId(payload.callbackId)).toBe(payload.callbackId);
    expect(parseSlackConfirmationActionId(slackConfirmationActionId.assignmentDelegateSelect)).toBe(
      "atm_assignment_delegate_select"
    );
    expect(parseSlackConfirmationResponseState(payload.responseState)).toBe("proposed");
    expect(parseSlackConfirmationActionId("unknown")).toBeNull();
    expect(slackTaskCandidateSchema.version).toBe("slack_task_candidate.v1");
    expect(slackTaskCandidateSchema.requiredSlackDerivedFields).toMatchObject({
      taskTitle: expect.any(String),
      taskDescription: expect.any(String),
      sourceChannel: expect.any(String),
      sourceMessageLink: expect.any(String),
      requester: expect.any(String),
      relevantContext: expect.any(String),
      assigneeResolution: expect.any(String),
      requiresAssigneeConfirmation: expect.any(String),
      memberMappingUncertainties: expect.any(String)
    });
    expect(validateSlackTaskCandidateMetadata(candidate)).toEqual({ ok: true, missing: [], invalid: [] });
  });

  test("Slack collection persistence schema defines collected messages and run metadata", () => {
    const collectedMessage: SlackCollectedMessage = {
      id: "slkmsg_1",
      agentId: "agent_1",
      collectionRunId: "slkrun_1",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      channelName: "eng",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      userId: "U_ALICE",
      userName: "Alice",
      text: "Please review the billing fix before 3pm",
      permalink: "https://example.slack.com/archives/C_WORK/p1710000000000900",
      botId: null,
      digestId: "digest_1",
      collectionScopeSource: "saved",
      threadCollectionMode: "active_threads",
      collectionScope: {
        workspace: "T_WORK",
        workspaces: ["T_WORK"],
        channels: ["C_WORK"],
        channelThreadScopes: { C_WORK: "active_threads" },
        threads: ["1710000000.000800"],
        mentions: ["U_ALICE"],
        keywords: ["billing"],
        updatedAt: "2026-05-08T00:00:00.000Z"
      },
      dedupeKey: "slackmsg:T_WORK:C_WORK:1710000000.000800:1710000000.000900",
      processedAt: null,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    };
    const run: SlackCollectionRun = {
      id: "slkrun_1",
      agentId: "agent_1",
      digestId: "digest_1",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      channelName: "eng",
      collectionTrigger: "scheduled",
      collectionScopeSource: "saved",
      threadCollectionMode: "active_threads",
      collectionScope: collectedMessage.collectionScope,
      status: "completed",
      startedAt: "2026-05-08T00:00:00.000Z",
      completedAt: "2026-05-08T00:00:00.000Z",
      receivedMessageCount: 2,
      parsedMessageCount: 2,
      retainedMessageCount: 1,
      insertedMessageCount: 1,
      duplicateMessageCount: 0,
      candidateCount: 1,
      error: null,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    };

    expect(slackCollectionTriggers).toEqual(["manual", "scheduled"]);
    expect(slackCollectionRunStatuses).toEqual(["completed", "failed"]);
    expect(collectedMessage.collectionRunId).toBe(run.id);
    expect(run.retainedMessageCount).toBe(1);
  });

  test("Slack task candidate confirmation message uses approve and reject buttons", () => {
    const candidate: SlackTaskCandidateMetadata = {
      candidateId: "cand_1",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      messageText: "Can <@U_ALICE> ship the billing fix before 3pm?",
      taskTitle: "Ship the billing fix",
      taskDescription: "Fix the billing deploy issue from the Slack request.",
      taskClassification: "coding",
      sourceChannel: {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        channelName: "eng",
        threadTs: "1710000000.000800",
        messageTs: "1710000000.000900"
      },
      sourceMessageLink: "https://example.slack.com/archives/C_WORK/p1710000000000900",
      requester: "U_LEADER",
      relevantContext: ["Can <@U_ALICE> ship the billing fix before 3pm?"],
      assignee: "Alice",
      assigneeCandidates: ["U_ALICE"],
      leaderReviewer: "U_LEADER",
      confirmationTarget: "U_LEADER",
      confirmationState: "proposed",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE",
      dueAt: "2026-05-08T15:00:00.000+09:00",
      nextAction: "Ship the billing fix",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000900",
      markdownPath: null
    };

    const action = buildSlackTaskCandidateConfirmationMessage(candidate);
    const blocks = action.blocks as Array<Record<string, unknown>>;
    const actionsBlock = blocks.find((block) => block.type === "actions") as Record<string, unknown>;
    const elements = actionsBlock.elements as Array<Record<string, unknown>>;

    expect(action.kind).toBe("dm");
    expect(action.userId).toBe("U_LEADER");
    expect(action.text).toContain("Approve task candidate");
    expect(JSON.stringify(blocks)).toContain("Required action: approve or reject this candidate before it can become an active ATM task.");
    expect(JSON.stringify(blocks)).toContain("Requester: U_LEADER");
    expect(actionsBlock.block_id).toBe("atm_candidate_cand_1");
    expect(elements).toEqual([
      {
        type: "static_select",
        action_id: slackConfirmationActionId.candidateSelectClassification,
        placeholder: { type: "plain_text", text: "Classification" },
        initial_option: { text: { type: "plain_text", text: "Coding" }, value: "coding" },
        options: [
          { text: { type: "plain_text", text: "General" }, value: "general" },
          { text: { type: "plain_text", text: "Coding" }, value: "coding" }
        ]
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Approve" },
        style: "primary",
        action_id: slackConfirmationActionId.candidateAccept,
        value: "cand_1"
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Reject" },
        style: "danger",
        action_id: slackConfirmationActionId.candidateDecline,
        value: "cand_1"
      }
    ]);
    expect(action.metadata).toMatchObject({
      type: slackConfirmationCallbackId.taskCandidateConfirmation,
      callbackId: slackConfirmationCallbackId.taskCandidateConfirmation,
      candidateId: "cand_1",
      dedupeKey: candidate.dedupeKey,
      defaultClassification: "coding",
      fallbackClassification: "general",
      classificationOptions: slackTaskCandidateClassificationOptions
    });
  });

  test("Slack task candidate classification dropdown falls back to general", () => {
    const candidate: SlackTaskCandidateMetadata = {
      candidateId: "cand_2",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000901",
      messageText: "Please follow up with finance.",
      taskTitle: "Follow up with finance",
      taskDescription: "Follow up with finance from Slack.",
      sourceChannel: {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        channelName: "eng",
        threadTs: "1710000000.000800",
        messageTs: "1710000000.000901"
      },
      sourceMessageLink: "https://example.slack.com/archives/C_WORK/p1710000000000901",
      requester: "U_LEADER",
      relevantContext: ["Please follow up with finance."],
      assignee: null,
      assigneeCandidates: [],
      leaderReviewer: "U_LEADER",
      confirmationTarget: "U_LEADER",
      confirmationState: "assigning",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:unassigned",
      dueAt: null,
      nextAction: null,
      sourceUrl: null,
      markdownPath: null
    };

    const action = buildSlackTaskCandidateConfirmationMessage(candidate);
    const blocks = action.blocks as Array<Record<string, unknown>>;
    const actionsBlock = blocks.find((block) => block.type === "actions") as Record<string, unknown>;
    const [classificationSelect] = actionsBlock.elements as Array<Record<string, unknown>>;

    expect(classificationSelect).toMatchObject({
      type: "static_select",
      action_id: slackConfirmationActionId.candidateSelectClassification,
      initial_option: { text: { type: "plain_text", text: "General" }, value: "general" },
      options: slackTaskCandidateClassificationOptions
    });
    expect(action.metadata).toMatchObject({
      defaultClassification: "general",
      fallbackClassification: fallbackSlackTaskCandidateClassification
    });
  });

  test("Slack interaction callback routes task candidate button and dropdown payloads", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Team Lead",
        slackUserId: "U_LEADER",
        aliases: ["lead"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000800",
          messageTs: "1710000000.000900",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000900",
          messages: [{ userId: "U_LEADER", text: "Can <@U_ALICE> ship the billing fix before 3pm?" }]
        },
        title: "Ship the billing fix",
        description: "Fix the billing deploy issue from Slack.",
        assignee: "U_ALICE",
        category: "coding",
        dueAt: "2026-05-08T15:00:00.000+09:00",
        nextAction: "Ship the billing fix"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;
    const confirmationTarget = (metadata.candidate as SlackTaskCandidateMetadata).confirmationTarget;
    const taskId = proposedBody.task.id as string;

    const classified = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: confirmationTarget },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "static_select",
              action_id: slackConfirmationActionId.candidateSelectClassification,
              block_id: `atm_candidate_${taskId}`,
              selected_option: { text: { type: "plain_text", text: "General" }, value: "general" }
            }
          ]
        })
      }
    });
    expect(classified.status).toBe(200);
    const classifiedBody = await classified.json();
    expect(classifiedBody.interaction).toMatchObject({
      callbackId: slackConfirmationCallbackId.taskCandidateConfirmation,
      actionId: slackConfirmationActionId.candidateSelectClassification,
      confirmationAction: "select_classification",
      responseState: "proposed",
      selectedClassification: "general",
      candidate: {
        candidateId: taskId,
        taskClassification: "coding"
      }
    });
    expect(classifiedBody.task).toMatchObject({ id: taskId, status: "assigning", category: "general" });
    expect(classifiedBody.confirmationRequest).toMatchObject({
      taskId,
      confirmationState: "proposed",
      confirmationAction: "select_classification",
      selectedClassification: "general"
    });
    expect(typeof classifiedBody.confirmationRequest.respondedAt).toBe("string");

    const approved = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: confirmationTarget },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateAccept,
              block_id: `atm_candidate_${taskId}`,
              value: taskId
            }
          ]
        })
      }
    });
    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    const acceptedState = confirmationTarget === "U_ALICE" ? "in_progress" : "confirmed";
    expect(approvedBody).toMatchObject({
      interaction: {
        callbackId: slackConfirmationCallbackId.taskCandidateConfirmation,
        actionId: slackConfirmationActionId.candidateAccept,
        confirmationAction: "accept",
        responseState: "confirmed",
        taskId,
        selectedClassification: "coding",
        candidate: {
          candidateId: taskId,
          dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE",
          confirmationTarget
        }
      },
      task: {
        id: taskId,
        status: acceptedState
      },
      confirmationRequest: {
        taskId,
        confirmationState: acceptedState,
        confirmationAction: "accept",
        selectedAssignee: null,
        selectedClassification: "coding"
      }
    });
    expect(typeof approvedBody.confirmationRequest.respondedAt).toBe("string");
    expect(
      runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(agent.id, "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE")
    ).toMatchObject({
      taskId,
      confirmationState: acceptedState,
      confirmationAction: "accept",
      selectedClassification: "coding"
    });

    const duplicateApproval = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: confirmationTarget },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateAccept,
              block_id: `atm_candidate_${taskId}`,
              value: taskId
            }
          ]
        })
      }
    });
    expect(duplicateApproval.status).toBe(409);
    await expect(duplicateApproval.json()).resolves.toMatchObject({
      error: "Slack task candidate confirmation is no longer pending."
    });
  });

  test("Slack task candidate rejection blocks the candidate even when payload state is stale", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000820",
          messageTs: "1710000000.000921",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000921",
          messages: [{ userId: "U_LEADER", text: "Can <@U_ALICE> audit the failed deploy?" }]
        },
        title: "Audit the failed deploy",
        description: "Review the failed deploy from Slack.",
        assignee: "U_ALICE",
        category: "coding"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const taskId = proposedBody.task.id as string;
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;
    const confirmationTarget = (metadata.candidate as SlackTaskCandidateMetadata).confirmationTarget;

    const rejected = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        responseState: "proposed",
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: confirmationTarget },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateDecline,
              block_id: `atm_candidate_${taskId}`,
              value: taskId
            }
          ]
        })
      }
    });
    expect(rejected.status).toBe(200);
    const rejectedBody = await rejected.json();
    expect(rejectedBody).toMatchObject({
      interaction: {
        confirmationAction: "decline",
        responseState: "proposed"
      },
      task: {
        id: taskId,
        status: "blocked"
      },
      confirmationRequest: {
        taskId,
        confirmationState: "blocked",
        confirmationAction: "decline",
        selectedClassification: "coding"
      }
    });
    expect(runtime.store.getTask(taskId)).toMatchObject({ status: "blocked" });
    expect(
      runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(agent.id, "slack:T_WORK:C_WORK:1710000000.000820:U_ALICE")
    ).toMatchObject({
      taskId,
      confirmationState: "blocked",
      confirmationAction: "decline"
    });
  });

  test("Slack task candidate acceptance rejects candidates whose task is no longer pending", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000850",
          messageTs: "1710000000.000951",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000951",
          messages: [{ userId: "U_LEADER", text: "Can <@U_ALICE> verify the deploy checklist?" }]
        },
        title: "Verify the deploy checklist",
        description: "Verify the deploy checklist from Slack.",
        assignee: "U_ALICE",
        category: "coding"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const taskId = proposedBody.task.id as string;
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;
    const confirmationTarget = (metadata.candidate as SlackTaskCandidateMetadata).confirmationTarget;
    runtime.store.updateTask(taskId, { status: "blocked" });

    const approved = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: confirmationTarget },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateAccept,
              block_id: `atm_candidate_${taskId}`,
              value: taskId
            }
          ]
        })
      }
    });
    expect(approved.status).toBe(409);
    await expect(approved.json()).resolves.toMatchObject({
      error: "Only pending Slack task candidates can be accepted."
    });
    expect(runtime.store.getTask(taskId)).toMatchObject({ status: "blocked" });
  });

  test("Slack task candidate acceptance requires the saved candidate record", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000852",
          messageTs: "1710000000.000953",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000953",
          messages: [{ userId: "U_LEADER", text: "Can <@U_ALICE> check the release gate?" }]
        },
        title: "Check the release gate",
        description: "Check the release gate from Slack.",
        assignee: "U_ALICE",
        category: "coding"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const taskId = proposedBody.task.id as string;
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;
    const candidate = metadata.candidate as SlackTaskCandidateMetadata;
    runtime.store.db
      .query("DELETE FROM slack_task_candidates WHERE agent_id = ? AND dedupe_key = ?")
      .run(agent.id, candidate.dedupeKey);

    const approved = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: candidate.confirmationTarget },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateAccept,
              block_id: `atm_candidate_${taskId}`,
              value: taskId
            }
          ]
        })
      }
    });
    expect(approved.status).toBe(409);
    await expect(approved.json()).resolves.toMatchObject({
      error: "Slack task candidate must be saved before activation."
    });
    expect(runtime.store.getTask(taskId)).toMatchObject({ status: "assigning" });
    expect(
      runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(agent.id, candidate.dedupeKey)
    ).toMatchObject({
      taskId,
      confirmationState: "proposed",
      confirmationAction: null
    });
  });

  test("accepted Slack task candidates create a task when the pending task no longer exists", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000854",
          messageTs: "1710000000.000955",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000955",
          messages: [{ userId: "U_LEADER", text: "Can <@U_ALICE> refresh the onboarding runbook by EOD?" }]
        },
        title: "Refresh the onboarding runbook",
        description: "Refresh the onboarding runbook from the Slack request.",
        assignee: "U_ALICE",
        category: "general",
        nextAction: "Refresh the onboarding runbook",
        dueAt: "2026-05-08T18:00:00.000+09:00"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const originalTaskId = proposedBody.task.id as string;
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;
    const candidate = metadata.candidate as SlackTaskCandidateMetadata;
    runtime.store.db.run("PRAGMA foreign_keys = OFF");
    runtime.store.db.query("DELETE FROM tasks WHERE id = ?").run(originalTaskId);
    runtime.store.db.run("PRAGMA foreign_keys = ON");
    expect(runtime.store.getTask(originalTaskId)).toBeNull();

    const approved = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: candidate.confirmationTarget },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateAccept,
              block_id: `atm_candidate_${originalTaskId}`,
              value: originalTaskId
            }
          ]
        })
      }
    });
    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody.task).toMatchObject({
      title: "Refresh the onboarding runbook",
      description: "Refresh the onboarding runbook from the Slack request.",
      status: "in_progress",
      assignee: "Alice",
      channelId: "C_WORK",
      threadTs: "1710000000.000854",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000955",
      dueAt: "2026-05-08T18:00:00.000+09:00",
      nextAction: "Refresh the onboarding runbook",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000854:U_ALICE"
    });
    expect(approvedBody.task.id).not.toBe(originalTaskId);
    expect(approvedBody.task.confirmedAt).toBeTruthy();
    expect(runtime.store.findTaskByDedupeKey(candidate.dedupeKey)?.id).toBe(approvedBody.task.id);
    expect(approvedBody.candidateRecord).toMatchObject({
      taskId: approvedBody.task.id,
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000854",
      messageTs: "1710000000.000955",
      sourceTs: "1710000000.000854",
      assigneeKey: "U_ALICE",
      dedupeKey: candidate.dedupeKey,
      payload: {
        candidateId: approvedBody.task.id,
        sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000955",
        markdownPath: approvedBody.task.markdownPath
      }
    });
    expect(runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, candidate.dedupeKey)).toMatchObject({
      taskId: approvedBody.task.id,
      confirmationState: "in_progress",
      payload: {
        candidateId: approvedBody.task.id,
        markdownPath: approvedBody.task.markdownPath
      }
    });
    expect(runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(agent.id, candidate.dedupeKey)).toMatchObject({
      taskId: approvedBody.task.id,
      confirmationState: "in_progress",
      confirmationAction: "accept"
    });
    const markdown = readFileSync(approvedBody.task.markdownPath, "utf8");
    expect(markdown).toContain('status: "in_progress"');
    expect(markdown).toContain('assignee: "Alice"');
    expect(markdown).not.toContain("confirmationState:");
    const interactionEvents = (runtime.store.db
      .query("SELECT payload FROM events WHERE type = 'agent.slack.task_candidate_interaction'")
      .all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    expect(interactionEvents.at(-1)).toMatchObject({
      taskId: approvedBody.task.id,
      dedupeKey: candidate.dedupeKey,
      candidateRecordId: approvedBody.candidateRecord.id,
      candidateTaskId: approvedBody.task.id,
      source: {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        threadTs: "1710000000.000854",
        messageTs: "1710000000.000955",
        sourceTs: "1710000000.000854",
        sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000955",
        markdownPath: approvedBody.task.markdownPath,
        assigneeKey: "U_ALICE"
      }
    });
  });

  test("accepted Slack task candidates activate an already linked existing ATM task", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000856",
          messageTs: "1710000000.000957",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000957",
          messages: [{ userId: "U_LEADER", text: "Can <@U_ALICE> update the incident checklist today?" }]
        },
        title: "Update the incident checklist",
        description: "Update the incident checklist from Slack.",
        assignee: "U_ALICE",
        category: "general",
        nextAction: "Update the incident checklist"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const originalTaskId = proposedBody.task.id as string;
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;
    const candidate = metadata.candidate as SlackTaskCandidateMetadata;
    const linked = runtime.store.createTask({
      title: "Existing linked checklist task",
      description: "Older linked placeholder.",
      status: "proposed",
      assignee: "Alice",
      channelId: "C_OTHER",
      threadTs: "1710000000.000100",
      sourceAgentId: agent.id,
      sourceAgentName: "OpenClaw",
      sourceAuthor: "U_LEADER",
      sourceUrl: "https://example.slack.com/archives/C_OTHER/p1710000000000100"
    });
    runtime.store.db
      .query("UPDATE slack_task_candidates SET task_id = ? WHERE agent_id = ? AND dedupe_key = ?")
      .run(linked.task.id, agent.id, candidate.dedupeKey);
    runtime.store.db.run("PRAGMA foreign_keys = OFF");
    runtime.store.db.query("DELETE FROM tasks WHERE id = ?").run(originalTaskId);
    runtime.store.db.run("PRAGMA foreign_keys = ON");

    const approved = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: candidate.confirmationTarget },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateAccept,
              block_id: `atm_candidate_${originalTaskId}`,
              value: originalTaskId
            }
          ]
        })
      }
    });

    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody.task).toMatchObject({
      id: linked.task.id,
      title: "Update the incident checklist",
      description: "Update the incident checklist from Slack.",
      status: "in_progress",
      assignee: "Alice",
      channelId: "C_WORK",
      threadTs: "1710000000.000856",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000957",
      nextAction: "Update the incident checklist",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000856:U_ALICE"
    });
    expect(runtime.store.getTask(originalTaskId)).toBeNull();
    expect(runtime.store.listTasks().filter((task) => task.dedupeKey === candidate.dedupeKey)).toHaveLength(1);
    expect(runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, candidate.dedupeKey)).toMatchObject({
      taskId: linked.task.id,
      confirmationState: "in_progress",
      payload: {
        candidateId: linked.task.id,
        markdownPath: approvedBody.task.markdownPath
      }
    });
  });

  test("accepted Slack task candidates update an existing ATM task matched by Slack source and assignee", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const sourceUrl = "https://example.slack.com/archives/C_WORK/p1710000000000959";
    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000858",
          messageTs: "1710000000.000959",
          authorId: "U_LEADER",
          permalink: sourceUrl,
          messages: [{ userId: "U_LEADER", text: "Can <@U_ALICE> reconcile the rollout notes?" }]
        },
        title: "Reconcile the rollout notes",
        description: "Reconcile the rollout notes from Slack.",
        assignee: "U_ALICE",
        category: "general"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const originalTaskId = proposedBody.task.id as string;
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;
    const candidate = metadata.candidate as SlackTaskCandidateMetadata;
    const matched = runtime.store.createTask({
      title: "Existing rollout notes task",
      description: "Older matched placeholder.",
      status: "proposed",
      assignee: "Alice",
      channelId: "C_WORK",
      threadTs: "1710000000.000858",
      sourceAgentId: agent.id,
      sourceAgentName: "OpenClaw",
      sourceAuthor: "U_LEADER",
      sourceUrl
    });
    runtime.store.db.run("PRAGMA foreign_keys = OFF");
    runtime.store.db.query("DELETE FROM tasks WHERE id = ?").run(originalTaskId);
    runtime.store.db.run("PRAGMA foreign_keys = ON");

    const approved = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: candidate.confirmationTarget },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateAccept,
              block_id: `atm_candidate_${originalTaskId}`,
              value: originalTaskId
            }
          ]
        })
      }
    });

    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody.task).toMatchObject({
      id: matched.task.id,
      title: "Reconcile the rollout notes",
      description: "Reconcile the rollout notes from Slack.",
      status: "in_progress",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000858:U_ALICE"
    });
    expect(runtime.store.listTasks().filter((task) => task.dedupeKey === candidate.dedupeKey)).toHaveLength(1);
    expect(runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(agent.id, candidate.dedupeKey)).toMatchObject({
      taskId: matched.task.id,
      confirmationState: "in_progress",
      confirmationAction: "accept"
    });
  });

  test("Slack interaction callback validates action ids, selections, and Slack identifiers before parsing", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const candidate: SlackTaskCandidateMetadata = {
      candidateId: "task_candidate_2",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      messageText: "Can <@U_ALICE> ship the billing fix before 3pm?",
      taskTitle: "Ship the billing fix",
      taskDescription: "Fix the billing deploy issue from Slack.",
      taskClassification: "coding",
      sourceChannel: {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        channelName: "eng",
        threadTs: "1710000000.000800",
        messageTs: "1710000000.000900"
      },
      sourceMessageLink: "https://example.slack.com/archives/C_WORK/p1710000000000900",
      requester: "U_LEADER",
      relevantContext: ["Can <@U_ALICE> ship the billing fix before 3pm?"],
      assignee: "Alice",
      assigneeCandidates: ["U_ALICE"],
      leaderReviewer: "U_LEADER",
      confirmationTarget: "U_LEADER",
      confirmationState: "proposed",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE",
      dueAt: null,
      nextAction: "Ship the billing fix",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000900",
      markdownPath: "/tmp/task_candidate_2.md"
    };
    const metadata = buildSlackTaskCandidateConfirmationMessage(candidate).metadata as Record<string, unknown>;
    const validPayload = {
      type: "block_actions",
      team: { id: "T_WORK" },
      user: { id: "U_LEADER" },
      channel: { id: "C_WORK" },
      message: { metadata: { event_payload: metadata } },
      actions: [
        {
          type: "button",
          action_id: slackConfirmationActionId.candidateAccept,
          block_id: "atm_candidate_task_candidate_2",
          value: "task_candidate_2"
        }
      ]
    };

    const unknownAction = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: { payload: JSON.stringify({ ...validPayload, actions: [{ action_id: "atm_candidate_delete" }] }) }
    });
    expect(unknownAction.status).toBe(400);
    await expect(unknownAction.json()).resolves.toMatchObject({ error: "Slack interaction action_id is not supported." });

    const invalidSelection = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          ...validPayload,
          actions: [
            {
              type: "static_select",
              action_id: slackConfirmationActionId.candidateSelectClassification,
              block_id: "atm_candidate_task_candidate_2",
              selected_option: { value: "legal" }
            }
          ]
        })
      }
    });
    expect(invalidSelection.status).toBe(400);
    await expect(invalidSelection.json()).resolves.toMatchObject({
      error: "Slack task candidate classification selection is not supported."
    });

    const wrongUser = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: { payload: JSON.stringify({ ...validPayload, user: { id: "U_INTRUDER" } }) }
    });
    expect(wrongUser.status).toBe(400);
    await expect(wrongUser.json()).resolves.toMatchObject({
      error: "Slack task candidate confirmationTarget must match user.id."
    });

    const missingTeam = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: { payload: JSON.stringify({ ...validPayload, team: undefined, team_id: undefined }) }
    });
    expect(missingTeam.status).toBe(400);
    await expect(missingTeam.json()).resolves.toMatchObject({ error: "Slack interaction team.id is required." });
  });

  test("OpenClaw assignment confirmation message uses stable Slack action payload IDs", () => {
    const adapter = new OpenClawAdapter();
    const task: Task = {
      id: "task_1",
      title: "Fix assignment confirmation",
      description: "Confirm that generated Slack payloads stay compatible with block actions.",
      status: "assigning",
      priority: "P1",
      category: "coding",
      assignee: "Alice",
      reporter: "PM",
      notify: true,
      initiative: null,
      nextAction: "Confirm owner in Slack",
      result: null,
      githubRef: null,
      channelId: "C_ASSIGN",
      threadTs: "1710000000.000500",
      sourceAgentId: "agent_1",
      sourceAgentName: "OpenClaw",
      sourceAuthor: "U_PM",
      sourceUrl: "https://example.slack.com/archives/C_ASSIGN/p1710000000000500",
      dueAt: null,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z",
      confirmedAt: null,
      markdownPath: "/tmp/task_1.md",
      dedupeKey: "slack:T_WORK:C_ASSIGN:1710000000.000500:U_ALICE"
    };
    const assignee: OwnerMapping = {
      id: "owner_alice",
      ownerName: "Alice",
      slackUserId: "U_ALICE",
      aliases: ["alice"],
      active: true,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    };
    const delegate: OwnerMapping = {
      id: "owner_bob",
      ownerName: "Bob",
      slackUserId: "U_BOB",
      aliases: ["bob"],
      active: true,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    };

    const action = adapter.requestAssignment(task, assignee, "asn_confirm_1", [assignee, delegate])[0];
    if (!action) throw new Error("Expected assignment confirmation action");
    const blocks = action.blocks as Array<Record<string, unknown>>;
    const actionsBlock = blocks.find((block) => block.type === "actions") as Record<string, unknown>;
    const elements = actionsBlock.elements as Array<Record<string, unknown>>;

    expect(action).toMatchObject({
      kind: "dm",
      userId: "U_ALICE",
      text: "Can you take task_1: Fix assignment confirmation?",
      metadata: {
        type: slackConfirmationCallbackId.assignmentConfirmation,
        requestId: "asn_confirm_1",
        taskId: "task_1"
      }
    });
    expect(actionsBlock.block_id).toBe("atm_assignment_asn_confirm_1");
    expect(elements).toEqual([
      {
        type: "static_select",
        action_id: slackConfirmationActionId.assignmentDelegateSelect,
        placeholder: { type: "plain_text", text: "Delegate to" },
        options: [{ text: { type: "plain_text", text: "Bob" }, value: "owner_bob" }]
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Accept" },
        style: "primary",
        action_id: slackConfirmationActionId.assignmentAccept,
        value: "asn_confirm_1"
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Decline" },
        style: "danger",
        action_id: slackConfirmationActionId.assignmentDecline,
        value: "asn_confirm_1"
      }
    ]);
  });

  test("OpenClaw plugin classifies common Korean task creation phrases", () => {
    const phrases = [
      "검색 고도화 작업 태스크에 넣어줘",
      "검색 고도화 작업 태스크 추가해줘",
      "검색 고도화 작업 태스크 등록해줘",
      "이거 할 일로 넣어줘",
      "이 내용 업무로 넣어줘"
    ];

    for (const phrase of phrases) {
      expect(classifyTaskCommand(phrase)).toMatchObject({ type: "propose" });
    }
  });

  test("setup locks after admin creation and admin can create synced Markdown tasks", async () => {
    const runtime = await makeRuntime();

    const unauthenticated = await request(runtime, "/api/tasks");
    expect(unauthenticated.status).toBe(401);

    const invalidAdmin = await request(runtime, "/api/setup/admin", {
      method: "POST",
      body: {
        email: "admin@localhost",
        password: "password123"
      }
    });
    expect(invalidAdmin.status).toBe(400);
    expect(await invalidAdmin.json()).toMatchObject({
      error: "A valid admin email is required, for example admin@example.com"
    });

    const setup = await request(runtime, "/api/setup/admin", {
      method: "POST",
      body: {
        email: "admin@example.com",
        password: "password123"
      }
    });
    expect(setup.status).toBe(201);
    const setupCookie = cookieHeader(setup);
    const setupBody = await setup.json();
    expect(setupBody.setupLocked).toBe(true);
    expect(setupBody.token).toBeUndefined();
    expect(runtime.store.getUserProfile(setupBody.admin.id)?.role).toBe("owner");

    const reviewed = await request(runtime, "/api/setup/review", {
      method: "PATCH",
      cookie: setupCookie,
      body: { slackPermissionsReviewed: true }
    });
    expect(reviewed.status).toBe(200);
    const reviewedBody = await reviewed.json();
    expect(reviewedBody.review.slackPermissionsReviewedAt).toBeTruthy();

    const setupStatus = await request(runtime, "/api/setup/status");
    const setupStatusBody = await setupStatus.json();
    expect(setupStatusBody.review.slackPermissionsReviewedAt).toBe(reviewedBody.review.slackPermissionsReviewedAt);

    const publicAccess = await request(runtime, "/api/setup/public-access", {
      method: "PATCH",
      cookie: setupCookie,
      body: {
        mode: "remote",
        publicUrl: "https://tasks.example.com",
        localServiceUrl: "http://localhost:3011",
        tunnelName: "agent-task-manager",
        tunnelToken: "cloudflared service install cf_tunnel_token_123456789",
        accessProtected: true
      }
    });
    expect(publicAccess.status).toBe(200);
    const publicAccessBody = await publicAccess.json();
    expect(publicAccessBody.publicAccess.tunnelTokenConfigured).toBe(true);
    expect(publicAccessBody.publicAccess.tunnelTokenPreview).toBe("cf_tunne...6789");
    expect(publicAccessBody.guide.quickTunnelCommand).toBe("cloudflared tunnel --url http://localhost:3011");
    expect(publicAccessBody.guide.serviceInstallCommand).toContain("cf_tunnel_token_123456789");

    const publicAccessStatus = await request(runtime, "/api/setup/status");
    const publicAccessStatusBody = await publicAccessStatus.json();
    expect(publicAccessStatusBody.publicAccess.publicUrl).toBe("https://tasks.example.com");
    expect(publicAccessStatusBody.publicAccess.accessProtected).toBe(true);

    const secondSetup = await request(runtime, "/api/setup/admin", {
      method: "POST",
      body: {
        email: "second@example.com",
        password: "password123"
      }
    });
    expect(secondSetup.status).toBe(409);

    const reporterOwner = await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: setupCookie,
      body: {
        ownerName: "PM",
        slackUserId: "U_PM",
        aliases: ["pm"]
      }
    });
    expect(reporterOwner.status).toBe(200);

    const created = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: setupCookie,
      body: {
        title: "Write launch checklist",
        description: "Prepare the initial rollout checklist.",
        status: "confirmed",
        priority: "P1",
        reporter: "PM",
        notify: false,
        initiative: "Launch",
        nextAction: "Draft rollout note",
        githubRef: "acme/web#12"
      }
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.task.status).toBe("confirmed");
    expect(createdBody.task.priority).toBe("P1");
    expect(createdBody.task.reporter).toBe("PM");
    expect(createdBody.task.notify).toBe(false);
    expect(createdBody.task.initiative).toBe("Launch");
    expect(createdBody.task.nextAction).toBe("Draft rollout note");
    expect(createdBody.task.githubRef).toBe("acme/web#12");
    expect(existsSync(createdBody.task.markdownPath)).toBe(true);

    const boardDefault = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: setupCookie,
      body: {
        title: "Review launch notes",
        assignee: "PM"
      }
    });
    expect(boardDefault.status).toBe(201);
    const boardDefaultBody = await boardDefault.json();
    expect(boardDefaultBody.task.status).toBe("confirmed");
    expect(boardDefaultBody.task.priority).toBe("P2");
    expect(boardDefaultBody.task.category).toBe("general");
    expect(boardDefaultBody.task.assignee).toBe("PM");

    const invalidOwner = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: setupCookie,
      body: {
        title: "Invalid owner",
        assignee: "not-a-slack-user"
      }
    });
    expect(invalidOwner.status).toBe(400);

    const updated = await request(runtime, `/api/tasks/${createdBody.task.id}`, {
      method: "PATCH",
      cookie: setupCookie,
      body: { status: "done" }
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    const markdown = readFileSync(updatedBody.task.markdownPath, "utf8");
    expect(markdown).toContain('status: "done"');
    expect(markdown).toContain('priority: "P1"');
    expect(markdown).toContain("notify: false");
    expect(markdown).toContain('github_ref: "acme/web#12"');
    expect(markdown).toContain("# Write launch checklist");
  });

  test("legacy Better Auth users without profiles are backfilled as the owner", async () => {
    const runtime = await makeRuntime();
    const created = await runtime.auth.auth.api.signUpEmail({
      body: { email: "legacy@example.com", password: "password123", name: "Legacy Owner" },
      asResponse: true
    });
    expect(created.ok).toBe(true);
    const createdBody = await created.json();
    expect(runtime.store.getUserProfile(createdBody.user.id)).toBeNull();

    const dataDir = runtime.config.dataDir;
    runtime.store.close();
    const runtimeIndex = runtimes.indexOf(runtime);
    if (runtimeIndex >= 0) runtimes.splice(runtimeIndex, 1);

    const migrated = await createRuntime({ dataDir, publicBaseUrl: "http://localhost:3011" });
    runtimes.push(migrated);
    expect(migrated.store.getUserProfile(createdBody.user.id)).toMatchObject({ role: "owner" });
  });

  test("owner task patch persists Kanban drop assignee and status updates", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Bob",
        slackUserId: "U_BOB",
        aliases: ["bob"]
      }
    });

    const created = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: adminCookie,
      body: {
        title: "Move from board",
        assignee: "Alice",
        status: "confirmed"
      }
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    const moved = await request(runtime, `/api/tasks/${createdBody.task.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        assignee: "Bob",
        status: "in_progress"
      }
    });
    expect(moved.status).toBe(200);
    const movedBody = await moved.json();
    expect(movedBody.task.assignee).toBe("Bob");
    expect(movedBody.task.status).toBe("in_progress");
    expect(runtime.store.getTask(createdBody.task.id)).toMatchObject({
      assignee: "Bob",
      status: "in_progress"
    });
    const movedMarkdown = readFileSync(movedBody.task.markdownPath, "utf8");
    expect(movedMarkdown).toContain('assignee: "Bob"');
    expect(movedMarkdown).toContain('status: "in_progress"');

    const unassigned = await request(runtime, `/api/tasks/${createdBody.task.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        assignee: null,
        status: "done"
      }
    });
    expect(unassigned.status).toBe(200);
    const unassignedBody = await unassigned.json();
    expect(unassignedBody.task.assignee).toBeNull();
    expect(unassignedBody.task.status).toBe("done");

    const invalidStatus = await request(runtime, `/api/tasks/${createdBody.task.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        assignee: "Alice",
        status: "blocked-review"
      }
    });
    expect(invalidStatus.status).toBe(400);
    expect(runtime.store.getTask(createdBody.task.id)).toMatchObject({
      assignee: null,
      status: "done"
    });
  });

  test("task creation validation rejects incomplete titles and invalid Slack owners", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);

    for (const body of [
      {},
      { title: "" },
      { title: "   ", description: "Whitespace-only titles stay invalid." }
    ]) {
      const invalidTitle = await request(runtime, "/api/tasks", {
        method: "POST",
        cookie: adminCookie,
        body
      });

      expect(invalidTitle.status).toBe(400);
      expect(await invalidTitle.json()).toEqual({ error: "Task title is required" });
    }

    const invalidAssignee = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: adminCookie,
      body: {
        title: "Assign to missing Slack owner",
        assignee: "not-a-slack-user"
      }
    });
    expect(invalidAssignee.status).toBe(400);
    expect(await invalidAssignee.json()).toEqual({
      error: "Assignee must be selected from active Slack users in Settings."
    });

    const invalidReporter = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: adminCookie,
      body: {
        title: "Report from missing Slack owner",
        reporter: "not-a-slack-user"
      }
    });
    expect(invalidReporter.status).toBe(400);
    expect(await invalidReporter.json()).toEqual({
      error: "Reporter must be selected from active Slack users in Settings."
    });

    expect(runtime.store.listTasks()).toEqual([]);
  });

  test("created board tasks persist and reload in the same member status column", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Bob",
        slackUserId: "U_BOB",
        aliases: ["bob"]
      }
    });

    const created = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: adminCookie,
      body: {
        title: "Persist created board task",
        assignee: "Bob",
        status: "in_progress",
        priority: "P1"
      }
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.task).toMatchObject({
      assignee: "Bob",
      status: "in_progress",
      priority: "P1"
    });

    const dataDir = runtime.config.dataDir;
    runtime.store.close();
    const runtimeIndex = runtimes.indexOf(runtime);
    if (runtimeIndex >= 0) runtimes.splice(runtimeIndex, 1);

    const reloaded = await createRuntime({ dataDir, publicBaseUrl: "http://localhost:3011" });
    runtimes.push(reloaded);

    const reloadedTasks = reloaded.store.listTasks();
    const columns = taskMemberColumns(reloadedTasks, reloaded.store.listOwners());
    const bobColumn = columns.find((column) => column.label === "Bob");
    const inProgressSection = taskStatusGroupSections(bobColumn?.tasks ?? [])
      .find((section) => section.id === "in-progress");

    expect(reloadedTasks.find((task) => task.id === createdBody.task.id)).toMatchObject({
      assignee: "Bob",
      status: "in_progress",
      priority: "P1"
    });
    expect(bobColumn?.tasks.map((task) => task.id)).toEqual([createdBody.task.id]);
    expect(inProgressSection?.tasks.map((task) => task.id)).toEqual([createdBody.task.id]);
  });

  test("agent token flow proposes once per Slack thread and processes assignment/status", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const unauthenticatedProposal = await request(runtime, "/api/agent/task/propose", {
      method: "POST",
      body: { context: { channelId: "C123", messages: [{ text: "taskify this" }] } }
    });
    expect(unauthenticatedProposal.status).toBe(401);
    expect(await unauthenticatedProposal.json()).toEqual({ error: "Agent id and token are required" });

    const invalidProposal = await runtime.app.handle(
      new Request("http://localhost/api/agent/task/propose", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-id": agent.id,
          authorization: "Bearer invalid"
        },
        body: JSON.stringify({ context: { channelId: "C123", messages: [{ text: "taskify this" }] } })
      })
    );
    expect(invalidProposal.status).toBe(401);
    expect(await invalidProposal.json()).toEqual({ error: "Invalid agent credentials" });

    const connect = await agentRequest(runtime, agent, "/api/agent/connect/test", {
      method: "POST",
      body: { source: "test" }
    });
    expect(connect.status).toBe(200);

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Deploy Owner",
        slackUserId: "U222",
        aliases: ["deploy"]
      }
    });

    const context = {
      channelId: "C123",
      channelName: "ops",
      threadTs: "1710000000.000100",
      messageTs: "1710000000.000100",
      authorId: "U111",
      permalink: "https://example.slack.com/archives/C123/p1710000000000100",
      messages: [{ userId: "U111", text: "태스크로 만들어줘: rotate deploy key", ts: "1710000000.000100" }]
    };

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: { context }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    expect(proposedBody.task.status).toBe("proposed");
    expect(proposedBody.duplicate).toBe(false);
    expect(proposedBody.confirmationOutbox.status).toBe("pending");
    expect(proposedBody.confirmationOutbox.payload.dedupeKey).toBe(proposedBody.task.dedupeKey);

    const duplicate = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: { context }
    });
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.duplicate).toBe(true);
    expect(duplicateBody.task.id).toBe(proposedBody.task.id);
    expect(duplicateBody.confirmationOutbox).toBeNull();

    await agentRequest(runtime, agent, `/api/agent/outbox/${proposedBody.confirmationOutbox.id}/ack`, {
      method: "POST",
      body: {}
    });

    const ask = await agentRequest(runtime, agent, `/api/agent/task/${proposedBody.task.id}/ask-assignee`, {
      method: "POST",
      body: { assigneeId: "U222" }
    });
    expect(ask.status).toBe(200);
    const askBody = await ask.json();
    expect(askBody.task.status).toBe("assigning");
    expect(askBody.assignmentRequest.status).toBe("pending");
    expect(askBody.actions[0].kind).toBe("dm");
    expect(askBody.actions[0].userId).toBe("U222");
    expect(askBody.actions[0].blocks).toBeTruthy();

    const accepted = await agentRequest(
      runtime,
      agent,
      `/api/agent/task/${proposedBody.task.id}/assignment-response`,
      {
        method: "POST",
        body: { accepted: true, requestId: askBody.assignmentRequest.id }
      }
    );
    const acceptedBody = await accepted.json();
    expect(acceptedBody.task.status).toBe("in_progress");

    const done = await agentRequest(runtime, agent, `/api/agent/task/${proposedBody.task.id}/status-signal`, {
      method: "POST",
      body: { signal: "done", confidence: 0.95 }
    });
    const doneBody = await done.json();
    expect(doneBody.task.status).toBe("done");

    const needsConfirmation = await agentRequest(
      runtime,
      agent,
      `/api/agent/task/${proposedBody.task.id}/status-signal`,
      {
        method: "POST",
        body: { signal: "blocked", confidence: 0.5 }
      }
    );
    const needsConfirmationBody = await needsConfirmation.json();
    expect(needsConfirmationBody.outbox.status).toBe("pending");

    const outbox = await agentRequest(runtime, agent, "/api/agent/outbox");
    const outboxBody = await outbox.json();
    expect(outboxBody.outbox).toHaveLength(1);

    const ack = await agentRequest(runtime, agent, `/api/agent/outbox/${outboxBody.outbox[0].id}/ack`, {
      method: "POST",
      body: {}
    });
    const ackBody = await ack.json();
    expect(ackBody.outbox.status).toBe("acked");
  });

  test("task candidate promotion queues one Slack confirmation request", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const context = {
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      channelName: "eng",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      authorId: "U_LEADER",
      permalink: "https://example.slack.com/archives/C_WORK/p1710000000000900",
      messages: [
        {
          userId: "U_LEADER",
          text: "Can <@U_ALICE> ship the billing fix before 3pm?",
          ts: "1710000000.000900"
        }
      ]
    };

    const promoted = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context,
        title: "Ship the billing fix",
        description: "Fix the billing deploy issue from Slack.",
        assignee: "U_ALICE",
        dueAt: "2026-05-08T15:00:00.000+09:00",
        nextAction: "Ship the billing fix"
      }
    });
    expect(promoted.status).toBe(200);
    const promotedBody = await promoted.json();
    expect(promotedBody.intakeTraceId).toMatch(/^intake_|^atm_intake_|trace_/);
    expect(promotedBody.task.status).toBe("assigning");
    const promotedAction = promotedBody.confirmationOutbox.payload.actions[0];
    expect(promotedAction.userId).toBe(promotedAction.metadata.candidate.confirmationTarget);
    expect(promotedAction.metadata).toMatchObject({
      type: slackConfirmationCallbackId.taskCandidateConfirmation,
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE",
      candidate: {
        candidateId: promotedBody.task.id,
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        messageTs: "1710000000.000900",
        confirmationTarget: promotedAction.userId,
        confirmationState: "proposed",
        markdownPath: promotedBody.task.markdownPath
      }
    });
    const confirmationRequest = runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(
      agent.id,
      "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE"
    );
    expect(confirmationRequest).toMatchObject({
      taskId: promotedBody.task.id,
      outboxId: promotedBody.confirmationOutbox.id,
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      assigneeKey: "U_ALICE",
      confirmationTarget: "U_ALICE",
      confirmationState: "proposed",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE"
    });
    expect(confirmationRequest?.payload).toMatchObject({
      candidateId: promotedBody.task.id,
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      messageTs: "1710000000.000900",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000900"
    });
    const persistedCandidate = runtime.store.getSlackTaskCandidateByDedupeKey(
      agent.id,
      "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE"
    );
    expect(persistedCandidate).toMatchObject({
      taskId: promotedBody.task.id,
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000800",
      messageTs: "1710000000.000900",
      assigneeKey: "U_ALICE",
      confirmationTarget: "U_ALICE",
      confirmationState: "proposed",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE",
      payload: {
        candidateId: promotedBody.task.id,
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        messageTs: "1710000000.000900",
        messageText: "Can <@U_ALICE> ship the billing fix before 3pm?",
        taskTitle: "Ship the billing fix",
        taskDescription: "Fix the billing deploy issue from Slack.",
        sourceChannel: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          channelName: "eng",
          threadTs: "1710000000.000800",
          messageTs: "1710000000.000900"
        },
        sourceMessageLink: "https://example.slack.com/archives/C_WORK/p1710000000000900",
        sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000900",
        markdownPath: promotedBody.task.markdownPath
      }
    });

    const duplicate = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context,
        title: "Ship the billing fix",
        description: "Fix the billing deploy issue from Slack.",
        assignee: "U_ALICE"
      }
    });
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.duplicate).toBe(true);
    expect(duplicateBody.confirmationOutbox).toBeNull();
    expect(
      runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(
        agent.id,
        "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE"
      )?.id
    ).toBe(confirmationRequest?.id);

    const outbox = await agentRequest(runtime, agent, "/api/agent/outbox");
    const outboxBody = await outbox.json();
    expect(outboxBody.outbox.filter((item: { payload: { dedupeKey?: string } }) => item.payload.dedupeKey === promotedBody.task.dedupeKey)).toHaveLength(1);

    const routedEvents = (runtime.store.db
      .query("SELECT payload FROM events WHERE type = 'agent.task.propose.routed'")
      .all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    expect(routedEvents.find((event) => event.intakeTraceId === promotedBody.intakeTraceId)).toMatchObject({
      intakeTraceId: promotedBody.intakeTraceId,
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000800:U_ALICE",
      duplicate: false,
      taskId: promotedBody.task.id,
      confirmationOutboxId: promotedBody.confirmationOutbox.id,
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      messageTs: "1710000000.000900"
    });
  });

  test("ambiguous Slack task candidates stay assignee-confirmation gated at ATM intake", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          channelName: "eng",
          threadTs: "1710000000.000910",
          messageTs: "1710000000.000920",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000920",
          messages: [
            {
              userId: "U_LEADER",
              text: "Can <@U_ALICE> and <@U_BOB> review the checkout fix before EOD?",
              ts: "1710000000.000920"
            }
          ]
        },
        title: "Review the checkout fix",
        description: "Review the checkout fix from Slack.",
        assignee: "U_ALICE",
        assigneeCandidates: ["U_ALICE", "U_BOB"],
        assigneeResolution: "ambiguous",
        requiresAssigneeConfirmation: true,
        taskification: {
          confirmationState: "proposed",
          dedupeKey: "slack:T_WORK:C_WORK:1710000000.000910:U_ALICE"
        }
      }
    });

    expect(proposed.status).toBe(200);
    const body = await proposed.json();
    expect(body.task.status).toBe("assigning");
    expect(body.confirmationOutbox).not.toBeNull();

    const candidate = body.confirmationOutbox.payload.actions[0].metadata.candidate as SlackTaskCandidateMetadata;
    expect(candidate).toMatchObject({
      assignee: "Alice",
      assigneeCandidates: ["U_ALICE", "U_BOB"],
      assigneeResolution: "ambiguous",
      requiresAssigneeConfirmation: true,
      confirmationTarget: "U_LEADER",
      confirmationState: "proposed",
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000910:U_ALICE"
    });

    expect(
      runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, "slack:T_WORK:C_WORK:1710000000.000910:U_ALICE")?.payload
    ).toMatchObject({
      assigneeResolution: "ambiguous",
      requiresAssigneeConfirmation: true,
      atmIdentityContext: {
        assigneeResolution: "ambiguous",
        requiresAssigneeConfirmation: true
      }
    });
  });

  test("ambiguous Slack task candidates require confirmed assignee selection before activation", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Bob",
        slackUserId: "U_BOB",
        aliases: ["bob"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          channelName: "eng",
          threadTs: "1710000000.000912",
          messageTs: "1710000000.000922",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000922",
          messages: [
            {
              userId: "U_LEADER",
              text: "Can <@U_ALICE> and <@U_BOB> check the rollout metrics?",
              ts: "1710000000.000922"
            }
          ]
        },
        title: "Check the rollout metrics",
        description: "Check the rollout metrics from Slack.",
        assignee: "U_ALICE",
        assigneeCandidates: ["U_ALICE", "U_BOB"],
        assigneeResolution: "ambiguous",
        requiresAssigneeConfirmation: true,
        taskification: {
          confirmationState: "proposed",
          dedupeKey: "slack:T_WORK:C_WORK:1710000000.000912:U_ALICE"
        }
      }
    });

    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const taskId = proposedBody.task.id as string;
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;
    const candidate = metadata.candidate as SlackTaskCandidateMetadata;
    expect(proposedBody.task).toMatchObject({ status: "assigning", assignee: "Alice" });

    const approvedWithoutSelection = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: candidate.confirmationTarget },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateAccept,
              block_id: `atm_candidate_${taskId}`,
              value: taskId
            }
          ]
        })
      }
    });

    expect(approvedWithoutSelection.status).toBe(200);
    const approvedBody = await approvedWithoutSelection.json();
    expect(approvedBody).toMatchObject({
      task: {
        id: taskId,
        status: "review_needed",
        assignee: "Alice"
      },
      githubSync: null,
      confirmationRequest: {
        taskId,
        confirmationState: "review_needed",
        confirmationAction: "accept",
        payload: {
          assignee: "Alice",
          assigneeResolution: "ambiguous",
          requiresAssigneeConfirmation: true,
          confirmationState: "review_needed"
        }
      },
      actions: [
        {
          kind: "thread_reply",
          channelId: "C_WORK",
          threadTs: "1710000000.000912",
          text: `${taskId} needs an assignee before activation.`
        }
      ]
    });
    expect(
      runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, "slack:T_WORK:C_WORK:1710000000.000912:U_ALICE")
    ).toMatchObject({
      taskId,
      confirmationState: "review_needed",
      payload: {
        assignee: "Alice",
        assigneeResolution: "ambiguous",
        requiresAssigneeConfirmation: true
      }
    });
  });

  test("leader-facing Slack task candidate confirmations include profile and ATM identity context", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Team Lead",
        slackUserId: "U_LEADER",
        aliases: ["lead"]
      }
    });
    const alice = await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });
    const bob = await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Bob",
        slackUserId: "U_BOB",
        aliases: ["bob"]
      }
    });
    const aliceBody = await alice.json();
    const bobBody = await bob.json();

    const context = {
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      channelName: "eng",
      threadTs: "1710000000.001000",
      messageTs: "1710000000.001100",
      authorId: "U_LEADER",
      permalink: "https://example.slack.com/archives/C_WORK/p1710000000001100",
      messages: [
        {
          userId: "U_LEADER",
          text: "Can <@U_UNKNOWN> prepare the incident report before EOD?",
          ts: "1710000000.001100"
        }
      ]
    };

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context,
        title: "Prepare the incident report",
        description: "Prepare the incident report from Slack.",
        assignee: "U_UNKNOWN",
        assigneeCandidates: ["U_UNKNOWN"]
      }
    });
    expect(proposed.status).toBe(200);
    const body = await proposed.json();
    const action = body.confirmationOutbox.payload.actions[0];
    const candidate = action.metadata.candidate as SlackTaskCandidateMetadata;
    const blocks = action.blocks as Array<Record<string, unknown>>;
    const actionsBlock = blocks.find((block) => block.type === "actions") as Record<string, unknown>;
    const elements = actionsBlock.elements as Array<Record<string, unknown>>;
    const assigneeSelect = elements.find(
      (element) => element.action_id === slackConfirmationActionId.candidateSelectAssignee
    );

    expect(action.userId).toBe("U_LEADER");
    expect(JSON.stringify(action.blocks)).toContain("Slack profiles:");
    expect(JSON.stringify(action.blocks)).toContain("ATM candidate:");
    expect(assigneeSelect).toMatchObject({
      type: "static_select",
      action_id: slackConfirmationActionId.candidateSelectAssignee,
      placeholder: { type: "plain_text", text: "Assignee" },
      options: expect.arrayContaining([
        { text: { type: "plain_text", text: "Alice" }, value: aliceBody.owner.id },
        { text: { type: "plain_text", text: "Bob" }, value: bobBody.owner.id }
      ])
    });
    expect(candidate).toMatchObject({
      confirmationTarget: "U_LEADER",
      leaderReviewer: "U_LEADER",
      confirmationState: "assigning",
      assigneeOptions: expect.arrayContaining([
        {
          ownerId: aliceBody.owner.id,
          ownerName: "Alice",
          slackUserId: "U_ALICE"
        },
        {
          ownerId: bobBody.owner.id,
          ownerName: "Bob",
          slackUserId: "U_BOB"
        }
      ]),
      memberMappingUncertainties: [
        {
          subject: "mentioned_user",
          slackUserId: "U_UNKNOWN",
          reason: "unmapped_slack_user"
        }
      ],
      atmIdentityContext: {
        candidateId: body.task.id,
        taskTitle: "Prepare the incident report",
        confirmationState: "assigning",
        assignee: null,
        assigneeResolution: "unassigned",
        requiresAssigneeConfirmation: true,
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.001000:U_UNKNOWN",
        markdownPath: body.task.markdownPath,
        sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000001100"
      }
    });
    expect(candidate.slackProfileContext).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "requester",
          slackUserId: "U_LEADER",
          atmOwnerName: "Team Lead",
          mappingStatus: "mapped"
        }),
        expect.objectContaining({
          role: "candidate_assignee",
          slackUserId: "U_UNKNOWN",
          atmOwnerName: null,
          mappingStatus: "unmapped",
          uncertaintyReason: "unmapped_slack_user"
        }),
        expect.objectContaining({
          role: "leader_reviewer",
          slackUserId: "U_LEADER",
          atmOwnerName: "Team Lead",
          mappingStatus: "mapped"
        })
      ])
    );

    const confirmationRequest = runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(
      agent.id,
      "slack:T_WORK:C_WORK:1710000000.001000:U_UNKNOWN"
    );
    expect(confirmationRequest?.payload.slackProfileContext).toEqual(candidate.slackProfileContext);
    expect(confirmationRequest?.payload.atmIdentityContext).toEqual(candidate.atmIdentityContext);
  });

  test("leader-facing Slack task candidate confirmations deliver to configured leader channel", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Team Lead",
        slackUserId: "U_LEADER",
        aliases: ["lead"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          channelName: "eng",
          threadTs: "1710000000.001200",
          messageTs: "1710000000.001300",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000001300",
          messages: [
            {
              userId: "U_LEADER",
              text: "Can someone prepare the customer follow-up before EOD?",
              ts: "1710000000.001300"
            }
          ]
        },
        title: "Prepare the customer follow-up",
        description: "Prepare the customer follow-up requested in Slack.",
        assigneeCandidates: [],
        confirmationState: "assigning",
        taskification: {
          leaderReviewer: "U_LEADER",
          confirmationTarget: "U_LEADER",
          confirmationState: "assigning",
          leaderReviewChannelId: "C_LEADS",
          leaderReviewThreadTs: "1710000000.009900"
        },
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.001200:unassigned"
      }
    });

    expect(proposed.status).toBe(200);
    const body = await proposed.json();
    const action = body.confirmationOutbox.payload.actions[0];
    expect(action).toMatchObject({
      kind: "thread_reply",
      channelId: "C_LEADS",
      threadTs: "1710000000.009900",
      userId: "U_LEADER",
      metadata: {
        candidate: {
          leaderReviewer: "U_LEADER",
          leaderReviewChannelId: "C_LEADS",
          leaderReviewThreadTs: "1710000000.009900",
          confirmationTarget: "U_LEADER",
          confirmationState: "assigning"
        }
      }
    });

    const confirmationRequest = runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(
      agent.id,
      "slack:T_WORK:C_WORK:1710000000.001200:unassigned"
    );
    expect(confirmationRequest?.payload).toMatchObject({
      leaderReviewChannelId: "C_LEADS",
      leaderReviewThreadTs: "1710000000.009900"
    });
  });

  test("Slack task candidate no-response timeout detection returns overdue pending confirmations", async () => {
    const runtime = await makeRuntime({ slackConfirmationNoResponseTimeoutMinutes: 30 });
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const oldProposal = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          channelName: "eng",
          threadTs: "1710000300.000100",
          messageTs: "1710000300.000200",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000300000200",
          messages: [
            { userId: "U_LEADER", text: "Can <@U_ALICE> review the stale deploy fix?", ts: "1710000300.000200" }
          ]
        },
        title: "Review the stale deploy fix",
        description: "Confirm the deploy fix from Slack.",
        assignee: "U_ALICE"
      }
    });
    expect(oldProposal.status).toBe(200);
    const oldProposalBody = await oldProposal.json();

    const freshProposal = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          channelName: "eng",
          threadTs: "1710000301.000100",
          messageTs: "1710000301.000200",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000301000200",
          messages: [
            { userId: "U_LEADER", text: "Can <@U_ALICE> review the fresh deploy fix?", ts: "1710000301.000200" }
          ]
        },
        title: "Review the fresh deploy fix",
        description: "Confirm the newer deploy fix from Slack.",
        assignee: "U_ALICE"
      }
    });
    expect(freshProposal.status).toBe(200);
    const freshProposalBody = await freshProposal.json();

    const confirmedProposal = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          channelName: "eng",
          threadTs: "1710000302.000100",
          messageTs: "1710000302.000200",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000302000200",
          messages: [
            { userId: "U_LEADER", text: "Can <@U_ALICE> review the already confirmed deploy fix?", ts: "1710000302.000200" }
          ]
        },
        title: "Review the already confirmed deploy fix",
        description: "This old confirmation has already been handled.",
        assignee: "U_ALICE"
      }
    });
    expect(confirmedProposal.status).toBe(200);
    const confirmedProposalBody = await confirmedProposal.json();

    const oldCreatedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    runtime.store.db
      .query("UPDATE slack_task_candidate_confirmations SET created_at = ?, updated_at = ? WHERE dedupe_key = ?")
      .run(oldCreatedAt, oldCreatedAt, oldProposalBody.task.dedupeKey);
    runtime.store.db
      .query("UPDATE slack_task_candidate_confirmations SET created_at = ?, updated_at = ? WHERE dedupe_key = ?")
      .run(oldCreatedAt, oldCreatedAt, confirmedProposalBody.task.dedupeKey);
    const confirmedTask = runtime.store.updateTask(confirmedProposalBody.task.id, { status: "confirmed" });
    expect(confirmedTask?.status).toBe("confirmed");
    const confirmedCandidate = runtime.store.getSlackTaskCandidateByDedupeKey(
      agent.id,
      confirmedProposalBody.task.dedupeKey
    );
    expect(confirmedCandidate).not.toBeNull();
    runtime.store.upsertSlackTaskCandidate({
      agentId: agent.id,
      taskId: confirmedProposalBody.task.id,
      candidate: { ...confirmedCandidate!.payload, confirmationState: "confirmed" }
    });
    const confirmedRequest = runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(
      agent.id,
      confirmedProposalBody.task.dedupeKey
    );
    expect(confirmedRequest).not.toBeNull();
    runtime.store.upsertSlackTaskCandidateConfirmationRequest({
      agentId: agent.id,
      taskId: confirmedProposalBody.task.id,
      outboxId: confirmedRequest!.outboxId,
      candidate: { ...confirmedRequest!.payload, confirmationState: "confirmed" },
      decision: {
        confirmationAction: "accept",
        respondedAt: oldCreatedAt
      }
    });

    const timedOut = runtime.store.listSlackTaskCandidateConfirmationsPastNoResponseTimeout(agent.id, 30);
    expect(timedOut.map((confirmation) => confirmation.dedupeKey)).toEqual([oldProposalBody.task.dedupeKey]);

    const response = await agentRequest(
      runtime,
      agent,
      "/api/agent/slack/task-candidate-confirmations/no-response-timeouts"
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      timeoutMinutes: 30,
      count: 1,
      transitionedCount: 1,
      notifiedLeaderCount: 1,
      confirmations: [
        {
          taskId: oldProposalBody.task.id,
          confirmationTarget: "U_LEADER",
          confirmationState: "review_needed",
          confirmationAction: null,
          respondedAt: null,
          dedupeKey: oldProposalBody.task.dedupeKey
        }
      ]
    });
    expect(body.confirmations[0].payload).toMatchObject({
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      messageTs: "1710000300.000200"
    });
    expect(body.reviewNeededOutbox).toHaveLength(1);
    expect(body.reviewNeededOutbox[0]).toMatchObject({
      agentId: agent.id,
      type: "slack.actions",
      status: "pending",
      payload: {
        taskCandidateReviewNeeded: true,
        reason: "no_response_timeout",
        taskId: oldProposalBody.task.id,
        confirmationId: body.confirmations[0].id,
        sourceDedupeKey: oldProposalBody.task.dedupeKey,
        dedupeKey: `${oldProposalBody.task.dedupeKey}:review_needed`,
        actions: [
          {
            kind: "dm",
            userId: "U_LEADER",
            metadata: {
              dedupeKey: oldProposalBody.task.dedupeKey,
              candidate: {
                candidateId: oldProposalBody.task.id,
                confirmationTarget: "U_LEADER",
                confirmationState: "review_needed",
                leaderReviewer: "U_LEADER"
              }
            }
          }
        ]
      }
    });
    expect(JSON.stringify(body.reviewNeededOutbox[0].payload.actions[0].blocks)).toContain(
      "Required action: no response was received, so the leader must review and approve or reject this candidate."
    );
    expect(runtime.store.getTask(oldProposalBody.task.id)).toMatchObject({
      status: "review_needed",
      confirmedAt: null
    });
    expect(runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, oldProposalBody.task.dedupeKey)).toMatchObject({
      confirmationState: "review_needed",
      confirmationTarget: "U_LEADER",
      payload: {
        confirmationState: "review_needed",
        confirmationTarget: "U_LEADER"
      }
    });
    expect(readFileSync(oldProposalBody.task.markdownPath, "utf8")).toContain('status: "review_needed"');
    expect(runtime.store.getTask(freshProposalBody.task.id)).toMatchObject({ status: "assigning" });
    expect(runtime.store.getTask(confirmedProposalBody.task.id)).toMatchObject({ status: "confirmed" });
    expect(
      runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, confirmedProposalBody.task.dedupeKey)
    ).toMatchObject({
      confirmationState: "confirmed",
      payload: {
        confirmationState: "confirmed"
      }
    });
  });

  test("OpenClaw taskification metadata routes assigned candidates to leader approval", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          channelName: "eng",
          threadTs: "1710000000.000940",
          messageTs: "1710000000.000941",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000941",
          messages: [{ userId: "U_LEADER", text: "Can <@U_ALICE> confirm the tax export by EOD?", ts: "1710000000.000941" }]
        },
        title: "Confirm the tax export by EOD",
        description: "Confirm the tax export from the Slack taskification request.",
        assignee: "U_ALICE",
        assigneeCandidates: ["U_ALICE"],
        taskification: {
          leaderReviewer: "U_LEADER",
          confirmationTarget: "U_LEADER",
          confirmationState: "proposed"
        },
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000940:U_ALICE"
      }
    });

    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const action = proposedBody.confirmationOutbox.payload.actions[0];
    expect(action).toMatchObject({
      kind: "dm",
      userId: "U_LEADER",
      metadata: {
        candidate: {
          candidateId: proposedBody.task.id,
          taskTitle: "Confirm the tax export by EOD",
          assignee: "Alice",
          leaderReviewer: "U_LEADER",
          confirmationTarget: "U_LEADER",
          confirmationState: "proposed",
          dedupeKey: "slack:T_WORK:C_WORK:1710000000.000940:U_ALICE"
        }
      }
    });
    expect(JSON.stringify(action.blocks)).toContain("Required action: approve or reject this candidate before it can become an active ATM task.");
    expect(JSON.stringify(action.blocks)).toContain("Requester: U_LEADER");
  });

  test("Slack task candidate storage defaults unsent confirmation state to proposed", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const dedupeKey = "slack:T_WORK:C_WORK:1710000000.000930:U_ALICE";
    const created = runtime.store.createTask({
      title: "Review stored candidate defaults",
      description: "Stored Slack candidates should start pending confirmation.",
      channelId: "C_WORK",
      threadTs: "1710000000.000930",
      sourceAgentId: agent.id,
      sourceAuthor: "U_LEADER",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000931",
      dedupeKey
    });

    const candidate = runtime.store.upsertSlackTaskCandidate({
      agentId: agent.id,
      taskId: created.task.id,
      candidate: {
        candidateId: created.task.id,
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        threadTs: "1710000000.000930",
        messageTs: "1710000000.000931",
        messageText: "Can <@U_ALICE> review stored candidate defaults?",
        taskTitle: created.task.title,
        taskDescription: created.task.description,
        taskClassification: "general",
        sourceChannel: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          channelName: "eng",
          threadTs: "1710000000.000930",
          messageTs: "1710000000.000931"
        },
        sourceMessageLink: "https://example.slack.com/archives/C_WORK/p1710000000000931",
        requester: "U_LEADER",
        relevantContext: ["Can <@U_ALICE> review stored candidate defaults?"],
        assignee: "Alice",
        assigneeCandidates: ["U_ALICE"],
        leaderReviewer: "U_LEADER",
        confirmationTarget: "U_ALICE",
        dedupeKey,
        dueAt: null,
        nextAction: null,
        sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000931",
        markdownPath: created.task.markdownPath
      }
    });

    expect(created.task.status).toBe("proposed");
    expect(candidate).toMatchObject({
      taskId: created.task.id,
      confirmationState: "proposed",
      dedupeKey,
      payload: {
        candidateId: created.task.id,
        confirmationState: "proposed",
        assigneeResolution: "assigned",
        requiresAssigneeConfirmation: false,
        memberMappingUncertainties: [],
        markdownPath: created.task.markdownPath
      }
    });
  });

  test("Slack task candidate storage persists normalized source identity and reuses source duplicates", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const firstDedupeKey = "slack:T_WORK:C_WORK:1710000000.000950:U_ALICE";
    const secondDedupeKey = "slack:T_WORK:C_WORK:1710000000.000951:U_ALICE";
    const first = runtime.store.createTask({
      title: "Review normalized source identity",
      description: "First proposal",
      channelId: "C_WORK",
      threadTs: "1710000000.000950",
      sourceAgentId: agent.id,
      sourceAuthor: "U_LEADER",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000951",
      dedupeKey: firstDedupeKey
    });
    const second = runtime.store.createTask({
      title: "Review normalized source identity again",
      description: "Second proposal",
      channelId: "C_WORK",
      threadTs: "1710000000.000950",
      sourceAgentId: agent.id,
      sourceAuthor: "U_LEADER",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000951",
      dedupeKey: secondDedupeKey
    });
    const baseCandidate: SlackTaskCandidateMetadata = {
      candidateId: first.task.id,
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000950",
      messageTs: "1710000000.000951",
      messageText: "Can <@U_ALICE> review normalized source identity?",
      taskTitle: first.task.title,
      taskDescription: first.task.description,
      taskClassification: "general",
      sourceChannel: {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        channelName: "eng",
        threadTs: "1710000000.000950",
        messageTs: "1710000000.000951"
      },
      sourceMessageLink: "https://example.slack.com/archives/C_WORK/p1710000000000951",
      requester: "U_LEADER",
      relevantContext: ["Can <@U_ALICE> review normalized source identity?"],
      assignee: "Alice",
      assigneeCandidates: ["U_ALICE"],
      leaderReviewer: "U_LEADER",
      confirmationTarget: "U_ALICE",
      confirmationState: "proposed",
      dedupeKey: firstDedupeKey,
      dueAt: null,
      nextAction: null,
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000951",
      markdownPath: first.task.markdownPath
    };

    const firstCandidate = runtime.store.upsertSlackTaskCandidate({
      agentId: agent.id,
      taskId: first.task.id,
      candidate: baseCandidate
    });
    const secondCandidate = runtime.store.upsertSlackTaskCandidate({
      agentId: agent.id,
      taskId: second.task.id,
      candidate: {
        ...baseCandidate,
        candidateId: second.task.id,
        taskTitle: second.task.title,
        taskDescription: second.task.description,
        dedupeKey: secondDedupeKey,
        markdownPath: second.task.markdownPath
      }
    });

    expect(firstCandidate.id).toBe(secondCandidate.id);
    expect(secondCandidate).toMatchObject({
      taskId: second.task.id,
      sourceTs: "1710000000.000950",
      dedupeKey: secondDedupeKey,
      payload: {
        candidateId: second.task.id,
        threadTs: "1710000000.000950",
        messageTs: "1710000000.000951"
      }
    });
    expect(
      runtime.store.getSlackTaskCandidateBySourceIdentity(agent.id, {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        sourceTs: "1710000000.000950",
        assigneeKey: "U_ALICE"
      })
    ).toMatchObject({ id: firstCandidate.id, dedupeKey: secondDedupeKey });
    expect(
      (runtime.store.db
        .query(
          "SELECT COUNT(*) AS count FROM slack_task_candidates WHERE agent_id = ? AND workspace_id = ? AND channel_id = ? AND source_ts = ? AND assignee_key = ?"
        )
        .get(agent.id, "T_WORK", "C_WORK", "1710000000.000950", "U_ALICE") as { count: number }).count
    ).toBe(1);
    expect(
      (runtime.store.db
        .query("SELECT COUNT(*) AS count FROM pragma_index_list('slack_task_candidates') WHERE name = ? AND [unique] = 1")
        .get("slack_task_candidates_source_unique") as { count: number }).count
    ).toBe(1);
  });

  test("Slack taskification intake reuses existing candidate source identity before creating a task", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const context = {
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      channelName: "eng",
      threadTs: "1710000000.000960",
      messageTs: "1710000000.000961",
      authorId: "U_LEADER",
      permalink: "https://example.slack.com/archives/C_WORK/p1710000000000961",
      messages: [
        {
          userId: "U_LEADER",
          text: "Can <@U_ALICE> review candidate source identity before EOD?",
          ts: "1710000000.000961"
        }
      ]
    };

    const first = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context,
        assignee: "U_ALICE",
        assigneeCandidates: ["U_ALICE"],
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000960:U_ALICE"
      }
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.duplicate).toBe(false);

    const retry = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context,
        assignee: "U_ALICE",
        assigneeCandidates: ["U_ALICE"],
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000961:U_ALICE"
      }
    });
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();

    expect(retryBody.duplicate).toBe(true);
    expect(retryBody.task.id).toBe(firstBody.task.id);
    expect(retryBody.confirmationOutbox).toBeNull();
    expect(runtime.store.listTasks().filter((task) => task.channelId === "C_WORK")).toHaveLength(1);
    expect(
      runtime.store.getSlackTaskCandidateBySourceIdentity(agent.id, {
        workspaceId: "T_WORK",
        channelId: "C_WORK",
        sourceTs: "1710000000.000960",
        assigneeKey: "U_ALICE"
      })
    ).toMatchObject({
      taskId: firstBody.task.id,
      dedupeKey: firstBody.task.dedupeKey
    });
    expect(
      (runtime.store.db
        .query(
          "SELECT COUNT(*) AS count FROM slack_task_candidates WHERE agent_id = ? AND workspace_id = ? AND channel_id = ? AND source_ts = ? AND assignee_key = ?"
        )
        .get(agent.id, "T_WORK", "C_WORK", "1710000000.000960", "U_ALICE") as { count: number }).count
    ).toBe(1);
  });

  test("Slack-created task candidates preserve the existing Markdown frontmatter contract", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Leader",
        slackUserId: "U_LEADER",
        aliases: ["leader"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          channelName: "eng",
          threadTs: "1710000000.000850",
          messageTs: "1710000000.000851",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000851",
          messages: [
            {
              userId: "U_LEADER",
              text: "Can someone review the checkout regression by EOD?",
              ts: "1710000000.000851"
            }
          ]
        },
        title: "Review the checkout regression",
        description: "Review the checkout regression requested in Slack.",
        priority: "P1",
        category: "coding",
        nextAction: "Review the checkout regression",
        dueAt: "2026-05-08T18:00:00.000+09:00",
        messageText: "Can someone review the checkout regression by EOD.",
        confirmationState: "assigning",
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000850:unassigned"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const task = proposedBody.task as Task;
    expect(task).toMatchObject({
      title: "Review the checkout regression",
      status: "proposed",
      priority: "P1",
      category: "coding",
      assignee: null,
      reporter: "U_LEADER",
      nextAction: "Review the checkout regression",
      channelId: "C_WORK",
      threadTs: "1710000000.000850",
      sourceAgentId: agent.id,
      sourceAuthor: "U_LEADER",
      sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000851",
      dueAt: "2026-05-08T18:00:00.000+09:00",
      confirmedAt: null,
      dedupeKey: "slack:T_WORK:C_WORK:1710000000.000850:unassigned"
    });
    expect(existsSync(task.markdownPath)).toBe(true);

    const markdown = readFileSync(task.markdownPath, "utf8");
    expect(markdown).toBe(`---
id: ${JSON.stringify(task.id)}
title: "Review the checkout regression"
status: "proposed"
priority: "P1"
category: "coding"
assignee: null
reporter: "U_LEADER"
notify: true
initiative: null
next_action: "Review the checkout regression"
result: null
github_ref: null
channel_id: "C_WORK"
thread_ts: "1710000000.000850"
source_agent_id: ${JSON.stringify(agent.id)}
source_agent_name: ${JSON.stringify(task.sourceAgentName)}
source_author: "U_LEADER"
source_url: "https://example.slack.com/archives/C_WORK/p1710000000000851"
due_at: "2026-05-08T18:00:00.000+09:00"
created_at: ${JSON.stringify(task.createdAt)}
updated_at: ${JSON.stringify(task.updatedAt)}
confirmed_at: null
dedupe_key: "slack:T_WORK:C_WORK:1710000000.000850:unassigned"
---

# Review the checkout regression

Review the checkout regression requested in Slack.
`);
    const frontmatterKeys = markdown.slice(4, markdown.indexOf("\n---", 4)).split("\n").map((line) => line.split(":")[0]);
    expect(frontmatterKeys).toEqual([
      "id",
      "title",
      "status",
      "priority",
      "category",
      "assignee",
      "reporter",
      "notify",
      "initiative",
      "next_action",
      "result",
      "github_ref",
      "channel_id",
      "thread_ts",
      "source_agent_id",
      "source_agent_name",
      "source_author",
      "source_url",
      "due_at",
      "created_at",
      "updated_at",
      "confirmed_at",
      "dedupe_key"
    ]);
    expect(markdown).not.toContain("workspaceId:");
    expect(markdown).not.toContain("messageTs:");
    expect(markdown).not.toContain("assigneeCandidates:");
    expect(markdown).not.toContain("confirmationState:");
  });

  test("ATM intake failures are returned and logged with trace context", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const originalCreateTask = runtime.store.createTask.bind(runtime.store);
    runtime.store.createTask = (() => {
      throw new Error("simulated intake write failure");
    }) as typeof runtime.store.createTask;

    const failed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        intakeTraceId: "trace_intake_failure_1",
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000810",
          messageTs: "1710000000.000811",
          authorId: "U_LEADER",
          messages: [{ userId: "U_LEADER", text: "taskify the broken intake path", ts: "1710000000.000811" }]
        },
        title: "Broken intake path",
        description: "Exercise failure traceability",
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000810:unassigned"
      }
    });
    runtime.store.createTask = originalCreateTask;

    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toMatchObject({
      ok: false,
      intakeTraceId: "trace_intake_failure_1",
      error: "simulated intake write failure"
    });
    const failureEvent = runtime.store.db
      .query("SELECT payload FROM events WHERE type = 'agent.task.propose.failed' ORDER BY created_at DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(JSON.parse(failureEvent?.payload ?? "{}")).toMatchObject({
      intakeTraceId: "trace_intake_failure_1",
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000810",
      messageTs: "1710000000.000811",
      error: "simulated intake write failure"
    });
  });

  test("ATM routing retries do not leave orphan confirmation outbox entries", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const context = {
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000920",
      messageTs: "1710000000.000921",
      authorId: "U_LEADER",
      permalink: "https://example.slack.com/archives/C_WORK/p1710000000000921",
      messages: [{ userId: "U_LEADER", text: "Can <@U_ALICE> retry the routing failure path?", ts: "1710000000.000921" }]
    };
    const dedupeKey = "slack:T_WORK:C_WORK:1710000000.000920:U_ALICE";
    const originalUpsert = runtime.store.upsertSlackTaskCandidateConfirmationRequest.bind(runtime.store);
    runtime.store.upsertSlackTaskCandidateConfirmationRequest = (() => {
      throw new Error("simulated confirmation write failure");
    }) as typeof runtime.store.upsertSlackTaskCandidateConfirmationRequest;

    const failed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        intakeTraceId: "trace_retry_safe_confirmation_1",
        context,
        title: "Retry the routing failure path",
        description: "Confirm retry safety after a partial confirmation write failure.",
        assignee: "U_ALICE",
        assigneeCandidates: ["U_ALICE"],
        messageText: "Can <@U_ALICE> retry the routing failure path?",
        dedupeKey
      }
    });
    runtime.store.upsertSlackTaskCandidateConfirmationRequest = originalUpsert;

    expect(failed.status).toBe(500);
    expect(runtime.store.listTasks().filter((task) => task.dedupeKey === dedupeKey)).toHaveLength(1);
    expect(runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(agent.id, dedupeKey)).toBeNull();
    expect(
      (runtime.store.db
        .query("SELECT COUNT(*) AS count FROM outbox WHERE agent_id = ?")
        .get(agent.id) as { count: number }).count
    ).toBe(0);

    const retried = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        intakeTraceId: "trace_retry_safe_confirmation_2",
        context,
        title: "Retry the routing failure path",
        description: "Confirm retry safety after a partial confirmation write failure.",
        assignee: "U_ALICE",
        assigneeCandidates: ["U_ALICE"],
        messageText: "Can <@U_ALICE> retry the routing failure path?",
        dedupeKey
      }
    });

    expect(retried.status).toBe(200);
    const retriedBody = await retried.json();
    expect(retriedBody.duplicate).toBe(true);
    expect(retriedBody.confirmationOutbox.payload.dedupeKey).toBe(dedupeKey);
    expect(runtime.store.listTasks().filter((task) => task.dedupeKey === dedupeKey)).toHaveLength(1);
    expect(runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(agent.id, dedupeKey)).toMatchObject({
      taskId: retriedBody.task.id,
      dedupeKey,
      confirmationTarget: "U_ALICE",
      confirmationState: "proposed"
    });
    expect(
      (runtime.store.db
        .query("SELECT COUNT(*) AS count FROM outbox WHERE agent_id = ?")
        .get(agent.id) as { count: number }).count
    ).toBe(1);
  });

  test("Slack task candidates persist even when no confirmation target can be resolved yet", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const dedupeKey = "slack:T_WORK:C_WORK:1710000000.000905:unassigned";

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          channelName: "eng",
          threadTs: "1710000000.000905",
          messageTs: "1710000000.000906",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000906",
          messages: [{ text: "Someone needs to triage the failed billing export.", ts: "1710000000.000906" }]
        },
        title: "Triage the failed billing export",
        description: "Triage the failed billing export from Slack.",
        messageText: "Someone needs to triage the failed billing export.",
        confirmationState: "assigning",
        dedupeKey
      }
    });

    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    expect(proposedBody.confirmationOutbox).toBeNull();
    expect(runtime.store.getSlackTaskCandidateConfirmationByDedupeKey(agent.id, dedupeKey)).toBeNull();
    expect(runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, dedupeKey)).toMatchObject({
      taskId: proposedBody.task.id,
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000905",
      messageTs: "1710000000.000906",
      assigneeKey: "unassigned",
      confirmationTarget: null,
      confirmationState: "assigning",
      payload: {
        messageText: "Someone needs to triage the failed billing export.",
        taskTitle: "Triage the failed billing export",
        taskDescription: "Triage the failed billing export from Slack.",
        sourceChannel: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000905",
          messageTs: "1710000000.000906"
        },
        sourceMessageLink: "https://example.slack.com/archives/C_WORK/p1710000000000906",
        markdownPath: proposedBody.task.markdownPath
      }
    });
  });

  test("Slack propose payloads with unresolved assignee mappings route to leader confirmation", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const context = {
      workspaceId: "T_WORK",
      channelId: "C_WORK",
      threadTs: "1710000000.000910",
      messageTs: "1710000000.000911",
      authorId: "U_LEADER",
      permalink: "https://example.slack.com/archives/C_WORK/p1710000000000911",
      messages: [
        {
          userId: "U_LEADER",
          text: "<@U_UNKNOWN> please review the checkout logs by EOD",
          ts: "1710000000.000911"
        }
      ]
    };

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context,
        title: "Review the checkout logs by EOD",
        description: "Slack taskification request from the checkout incident.",
        assignee: "U_UNKNOWN",
        assigneeCandidates: ["U_UNKNOWN"],
        messageText: "<@U_UNKNOWN> please review the checkout logs by EOD",
        sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000911",
        confirmationState: "assigning",
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000910:U_UNKNOWN"
      }
    });

    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    expect(proposedBody.task.status).toBe("proposed");
    expect(proposedBody.task.assignee).toBeNull();
    expect(proposedBody.assignmentRequest).toBeUndefined();
    expect(proposedBody.confirmationOutbox.payload.actions[0]).toMatchObject({
      kind: "dm",
      userId: "U_LEADER",
      metadata: {
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000910:U_UNKNOWN",
        candidate: {
          assignee: null,
          assigneeCandidates: ["U_UNKNOWN"],
          memberMappingUncertainties: [
            {
              subject: "author",
              slackUserId: "U_LEADER",
              slackUserName: null,
              reason: "unmapped_slack_user"
            },
            {
              subject: "mentioned_user",
              slackUserId: "U_UNKNOWN",
              slackUserName: null,
              reason: "unmapped_slack_user"
            }
          ],
          confirmationTarget: "U_LEADER",
          confirmationState: "assigning"
        }
      }
    });
  });

  test("leader assignee responses hydrate unresolved mapping state from pending confirmation records", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000912",
          messageTs: "1710000000.000913",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000913",
          messages: [
            {
              userId: "U_LEADER",
              text: "<@U_UNKNOWN> please audit the invoice export before Friday",
              ts: "1710000000.000913"
            }
          ]
        },
        title: "Audit the invoice export",
        description: "Slack taskification request for invoice export audit.",
        assignee: "U_UNKNOWN",
        assigneeCandidates: ["U_UNKNOWN"],
        messageText: "<@U_UNKNOWN> please audit the invoice export before Friday",
        sourceUrl: "https://example.slack.com/archives/C_WORK/p1710000000000913",
        confirmationState: "assigning",
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000912:U_UNKNOWN"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const taskId = proposedBody.task.id as string;

    const selected = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: "U_LEADER" },
          channel: { id: "C_WORK" },
          message: {
            metadata: {
              event_payload: {
                type: slackConfirmationCallbackId.taskCandidateConfirmation,
                callbackId: slackConfirmationCallbackId.taskCandidateConfirmation,
                candidateId: taskId,
                dedupeKey: "slack:T_WORK:C_WORK:1710000000.000912:U_UNKNOWN",
                candidate: {
                  candidateId: taskId,
                  dedupeKey: "slack:T_WORK:C_WORK:1710000000.000912:U_UNKNOWN"
                }
              }
            }
          },
          actions: [
            {
              type: "static_select",
              action_id: slackConfirmationActionId.candidateSelectAssignee,
              block_id: `atm_candidate_${taskId}`,
              selected_option: {
                text: { type: "plain_text", text: "Alice" },
                value: "U_ALICE"
              }
            }
          ]
        })
      }
    });

    expect(selected.status).toBe(200);
    const selectedBody = await selected.json();
    expect(selectedBody.confirmationRequest).toMatchObject({
      taskId,
      confirmationState: "assigning",
      confirmationAction: "select_assignee",
      selectedAssignee: "U_ALICE",
      payload: {
        assignee: "Alice",
        assigneeResolution: "assigned",
        requiresAssigneeConfirmation: false,
        assigneeCandidates: ["U_UNKNOWN"],
        memberMappingUncertainties: [
          {
            subject: "author",
            slackUserId: "U_LEADER",
            reason: "unmapped_slack_user"
          },
          {
            subject: "mentioned_user",
            slackUserId: "U_UNKNOWN",
            reason: "unmapped_slack_user"
          }
        ],
        confirmationState: "assigning",
        confirmationTarget: "U_LEADER"
      }
    });
    expect(runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, "slack:T_WORK:C_WORK:1710000000.000912:U_UNKNOWN")).toMatchObject({
      taskId,
      confirmationState: "assigning",
      payload: {
        assignee: "Alice",
        assigneeResolution: "assigned",
        requiresAssigneeConfirmation: false,
        atmIdentityContext: {
          assignee: "Alice",
          assigneeResolution: "assigned",
          requiresAssigneeConfirmation: false,
          confirmationState: "assigning"
        },
        assigneeCandidates: ["U_UNKNOWN"],
        memberMappingUncertainties: expect.arrayContaining([
          expect.objectContaining({ subject: "mentioned_user", slackUserId: "U_UNKNOWN" })
        ])
      }
    });
  });

  test("ambiguous Slack task candidates resolve leader recipient from mapped author names", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Team Lead",
        slackUserId: "U_LEADER",
        aliases: ["lead"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000920",
          messageTs: "1710000000.000921",
          authorName: "lead",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000921",
          messages: [{ userName: "lead", text: "Someone needs to publish the release summary by EOD." }]
        },
        title: "Publish the release summary",
        description: "Publish the release summary requested in Slack.",
        messageText: "Someone needs to publish the release summary by EOD.",
        confirmationState: "assigning",
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000920:unassigned"
      }
    });

    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    expect(proposedBody.confirmationOutbox.payload.actions[0]).toMatchObject({
      kind: "dm",
      userId: "U_LEADER",
      metadata: {
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000920:unassigned",
        candidate: {
          leaderReviewer: "U_LEADER",
          confirmationTarget: "U_LEADER",
          confirmationState: "assigning"
        }
      }
    });
    expect(
      runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, "slack:T_WORK:C_WORK:1710000000.000920:unassigned")
    ).toMatchObject({
      confirmationTarget: "U_LEADER",
      payload: {
        requester: "lead",
        leaderReviewer: "U_LEADER",
        confirmationTarget: "U_LEADER"
      }
    });
  });

  test("approved Slack task candidates become confirmed ATM tasks after assignee selection", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const alice = await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });
    const aliceBody = await alice.json();

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000930",
          messageTs: "1710000000.000931",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000931",
          messages: [{ userId: "U_LEADER", text: "Someone needs to publish the incident summary by EOD." }]
        },
        title: "Publish the incident summary",
        description: "Publish the incident summary requested in Slack.",
        assigneeCandidates: ["U_ALICE"],
        messageText: "Someone needs to publish the incident summary by EOD.",
        confirmationState: "assigning",
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000930:unassigned"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const taskId = proposedBody.task.id as string;
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;
    expect(proposedBody.task).toMatchObject({ status: "proposed", assignee: null });

    const approved = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: "U_LEADER" },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          state: {
            values: {
              atm_candidate_assignee: {
                [slackConfirmationActionId.candidateSelectAssignee]: {
                  selected_option: {
                    text: { type: "plain_text", text: "Alice" },
                    value: aliceBody.owner.id
                  }
                }
              }
            }
          },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateAccept,
              block_id: `atm_candidate_${taskId}`,
              value: taskId
            }
          ]
        })
      }
    });
    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody).toMatchObject({
      task: {
        id: taskId,
        status: "confirmed",
        assignee: "Alice"
      },
      githubSync: {
        status: "skipped",
        reason: "disabled",
        taskId
      },
      confirmationRequest: {
        taskId,
        confirmationState: "confirmed",
        confirmationAction: "accept",
        selectedAssignee: aliceBody.owner.id
      }
    });
    expect(approvedBody.task.confirmedAt).toBeTruthy();
    const markdown = readFileSync(approvedBody.task.markdownPath, "utf8");
    expect(markdown).toBe(`---
id: ${JSON.stringify(taskId)}
title: "Publish the incident summary"
status: "confirmed"
priority: "P2"
category: ${JSON.stringify(approvedBody.task.category)}
assignee: "Alice"
reporter: "U_LEADER"
notify: true
initiative: null
next_action: null
result: null
github_ref: null
channel_id: "C_WORK"
thread_ts: "1710000000.000930"
source_agent_id: ${JSON.stringify(agent.id)}
source_agent_name: ${JSON.stringify(approvedBody.task.sourceAgentName)}
source_author: "U_LEADER"
source_url: "https://example.slack.com/archives/C_WORK/p1710000000000931"
due_at: null
created_at: ${JSON.stringify(approvedBody.task.createdAt)}
updated_at: ${JSON.stringify(approvedBody.task.updatedAt)}
confirmed_at: ${JSON.stringify(approvedBody.task.confirmedAt)}
dedupe_key: "slack:T_WORK:C_WORK:1710000000.000930:unassigned"
---

# Publish the incident summary

Publish the incident summary requested in Slack.
`);
    expect(markdown).not.toContain("assigneeCandidates:");
    expect(markdown).not.toContain("confirmationState:");
  });

  test("Slack task candidate assignee dropdown persists assignment state before approval", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const alice = await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });
    const aliceBody = await alice.json();

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000932",
          messageTs: "1710000000.000933",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000933",
          messages: [{ userId: "U_LEADER", text: "Someone needs to update the renewal checklist." }]
        },
        title: "Update the renewal checklist",
        description: "Update the renewal checklist requested in Slack.",
        assigneeCandidates: ["U_ALICE"],
        messageText: "Someone needs to update the renewal checklist.",
        confirmationState: "assigning",
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000932:unassigned"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const taskId = proposedBody.task.id as string;
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;

    const selected = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: "U_LEADER" },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "static_select",
              action_id: slackConfirmationActionId.candidateSelectAssignee,
              block_id: `atm_candidate_${taskId}`,
              selected_option: {
                text: { type: "plain_text", text: "Alice" },
                value: aliceBody.owner.id
              }
            }
          ]
        })
      }
    });

    expect(selected.status).toBe(200);
    const selectedBody = await selected.json();
    expect(selectedBody).toMatchObject({
      task: {
        id: taskId,
        status: "assigning",
        assignee: "Alice"
      },
      confirmationRequest: {
        taskId,
        confirmationState: "assigning",
        confirmationAction: "select_assignee",
        selectedAssignee: aliceBody.owner.id,
        payload: {
          assignee: "Alice",
          confirmationState: "assigning"
        }
      }
    });
    expect(selectedBody.assignmentRequest).toMatchObject({
      taskId,
      ownerId: aliceBody.owner.id,
      ownerName: "Alice",
      slackUserId: "U_ALICE",
      status: "pending",
      requestedBy: "U_LEADER"
    });
    expect(selectedBody.actions).toHaveLength(2);
    expect(selectedBody.actions[0]).toMatchObject({
      kind: "thread_reply",
      channelId: "C_WORK",
      threadTs: "1710000000.000932",
      text: `${taskId} assignee set to Alice.`
    });
    expect(selectedBody.actions[1]).toMatchObject({
      kind: "dm",
      userId: "U_ALICE",
      text: `Can you take ${taskId}: Update the renewal checklist?`,
      metadata: {
        type: slackConfirmationCallbackId.assignmentConfirmation,
        requestId: selectedBody.assignmentRequest.id,
        taskId
      }
    });
    expect(runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, "slack:T_WORK:C_WORK:1710000000.000932:unassigned")).toMatchObject({
      taskId,
      confirmationState: "assigning",
      payload: {
        assignee: "Alice",
        assigneeResolution: "assigned",
        requiresAssigneeConfirmation: false,
        atmIdentityContext: {
          assignee: "Alice",
          assigneeResolution: "assigned",
          requiresAssigneeConfirmation: false,
          confirmationState: "assigning"
        },
        confirmationState: "assigning"
      }
    });
    const markdown = readFileSync(selectedBody.task.markdownPath, "utf8");
    expect(markdown).toContain('status: "assigning"');
    expect(markdown).toContain('assignee: "Alice"');
    expect(markdown).not.toContain("confirmationState:");
  });

  test("Slack task candidate assignee acceptance moves the task into progress", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "UALICE",
        aliases: ["alice"]
      }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000935",
          messageTs: "1710000000.000936",
          authorId: "ULEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000936",
          messages: [{ userId: "ULEADER", text: "Can <@UALICE> patch the webhook retry issue?" }]
        },
        title: "Patch the webhook retry issue",
        description: "Patch the webhook retry issue requested in Slack.",
        assignee: "UALICE",
        category: "coding"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const taskId = proposedBody.task.id as string;
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;
    const confirmationTarget = (metadata.candidate as SlackTaskCandidateMetadata).confirmationTarget;
    expect(proposedBody.task).toMatchObject({ status: "assigning", assignee: "Alice" });

    const approved = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        responseState: "in_progress",
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: confirmationTarget },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateAccept,
              block_id: `atm_candidate_${taskId}`,
              value: taskId
            }
          ]
        })
      }
    });

    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody).toMatchObject({
      task: {
        id: taskId,
        status: "in_progress",
        assignee: "Alice"
      },
      confirmationRequest: {
        taskId,
        confirmationState: "in_progress",
        confirmationAction: "accept"
      }
    });
    expect(approvedBody.task.confirmedAt).toBeTruthy();
    const markdown = readFileSync(approvedBody.task.markdownPath, "utf8");
    expect(markdown).toContain('status: "in_progress"');
    expect(markdown).not.toContain("confirmationState:");
  });

  test("approving an unassigned Slack task candidate keeps it out of active task states", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          workspaceId: "T_WORK",
          channelId: "C_WORK",
          threadTs: "1710000000.000940",
          messageTs: "1710000000.000941",
          authorId: "U_LEADER",
          permalink: "https://example.slack.com/archives/C_WORK/p1710000000000941",
          messages: [{ userId: "U_LEADER", text: "Need an owner to reconcile failed invoices." }]
        },
        title: "Reconcile failed invoices",
        description: "Resolve the failed invoices mentioned in Slack.",
        confirmationState: "assigning",
        dedupeKey: "slack:T_WORK:C_WORK:1710000000.000940:unassigned"
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    const taskId = proposedBody.task.id as string;
    const metadata = proposedBody.confirmationOutbox.payload.actions[0].metadata as Record<string, unknown>;

    const approved = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: "U_LEADER" },
          channel: { id: "C_WORK" },
          message: { metadata: { event_payload: metadata } },
          actions: [
            {
              type: "button",
              action_id: slackConfirmationActionId.candidateAccept,
              block_id: `atm_candidate_${taskId}`,
              value: taskId
            }
          ]
        })
      }
    });
    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody).toMatchObject({
      task: {
        id: taskId,
        status: "review_needed",
        assignee: null
      },
      githubSync: null,
      confirmationRequest: {
        taskId,
        confirmationState: "review_needed",
        confirmationAction: "accept"
      }
    });
    expect(approvedBody.task.confirmedAt).toBeNull();
    const markdown = readFileSync(approvedBody.task.markdownPath, "utf8");
    expect(markdown).toContain('status: "review_needed"');
    expect(markdown).toContain("assignee: null");
  });

  test("manual_only channels ignore automatic proposals until suggest_only is configured", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const context = {
      channelId: "C999",
      threadTs: "1710000000.000200",
      messages: [{ userId: "U333", text: "We should update the runbook." }]
    };

    const ignored = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: { context, automatic: true }
    });
    const ignoredBody = await ignored.json();
    expect(ignoredBody.ignored).toBe(true);

    await request(runtime, "/api/settings/channels", {
      method: "PATCH",
      cookie: adminCookie,
      body: { channelId: "C999", mode: "suggest_only" }
    });

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: { context, automatic: true }
    });
    const proposedBody = await proposed.json();
    expect(proposedBody.task.status).toBe("proposed");
  });

  test("owner mappings drive task cards and queued daily digests", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const owner = await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U222",
        aliases: ["alice", "ali"]
      }
    });
    expect(owner.status).toBe(200);
    const ownerBody = await owner.json();
    expect(ownerBody.owner.ownerName).toBe("Alice");

    const agentOwners = await agentRequest(runtime, agent, "/api/agent/owners");
    expect(agentOwners.status).toBe(200);
    const agentOwnersBody = await agentOwners.json();
    expect(agentOwnersBody.owners).toHaveLength(1);
    expect(agentOwnersBody.owners[0].slackUserId).toBe("U222");

    const created = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: adminCookie,
      body: {
        title: "Review release blocker",
        description: "Check the deploy failure before launch.",
        status: "in_progress",
        priority: "P0",
        assignee: "Alice",
        nextAction: "Inspect CI logs"
      }
    });
    expect(created.status).toBe(201);

    const cards = await agentRequest(
      runtime,
      agent,
      "/api/agent/tasks/cards?owner=ali&channelId=C123&threadTs=1710000000.000300&scope=today"
    );
    expect(cards.status).toBe(200);
    const cardsBody = await cards.json();
    expect(cardsBody.owner.ownerName).toBe("Alice");
    expect(cardsBody.tasks).toHaveLength(1);
    expect(cardsBody.actions[0].text).toContain("[P0/in_progress]");
    expect(cardsBody.actions[0].text).toContain("Inspect CI logs");

    const digest = await agentRequest(runtime, agent, "/api/agent/tasks/daily-digest", {
      method: "POST",
      body: { owner: "alice", enqueue: true }
    });
    expect(digest.status).toBe(200);
    const digestBody = await digest.json();
    expect(digestBody.actions).toHaveLength(1);
    expect(digestBody.actions[0].kind).toBe("dm");
    expect(digestBody.actions[0].userId).toBe("U222");
    expect(digestBody.outbox).toHaveLength(1);

    const outbox = await agentRequest(runtime, agent, "/api/agent/outbox");
    const outboxBody = await outbox.json();
    expect(outboxBody.outbox[0].payload.actions[0].userId).toBe("U222");
  });

  test("OpenClaw assignment interactions can delegate and then accept ownership", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const alice = await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });
    const aliceBody = await alice.json();
    const bob = await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Bob",
        slackUserId: "U_BOB",
        aliases: ["bob"]
      }
    });
    const bobBody = await bob.json();

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        title: "Fix assignment interaction",
        description: "Make ownership confirmation interactive.",
        assignee: "Alice",
        confirmed: true,
        context: {
          channelId: "C_ASSIGN",
          threadTs: "1710000000.000500",
          messageTs: "1710000000.000500",
          authorId: "U_REPORTER",
          messages: [{ userId: "U_REPORTER", text: "Alice should own this." }]
        }
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    expect(proposedBody.task.status).toBe("assigning");
    expect(proposedBody.task.assignee).toBe("Alice");
    expect(proposedBody.assignmentRequest.ownerId).toBe(aliceBody.owner.id);
    expect(proposedBody.actions.at(-1).kind).toBe("dm");
    expect(proposedBody.actions.at(-1).userId).toBe("U_ALICE");

    const delegated = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_WORK" },
          user: { id: "U_ALICE" },
          actions: [
            {
              action_id: "atm_assignment_delegate_select",
              block_id: `atm_assignment_${proposedBody.assignmentRequest.id}`,
              selected_option: { value: bobBody.owner.id }
            }
          ]
        }),
        responseText: "Bob has the right context."
      }
    });
    expect(delegated.status).toBe(200);
    const delegatedBody = await delegated.json();
    expect(delegatedBody.assignmentRequest.previousRequestId).toBe(proposedBody.assignmentRequest.id);
    expect(delegatedBody.assignmentRequest.ownerId).toBe(bobBody.owner.id);
    expect(delegatedBody.task.assignee).toBe("Bob");
    expect(delegatedBody.actions[0].userId).toBe("U_BOB");

    const accepted = await agentRequest(runtime, agent, "/api/agent/slack/interaction", {
      method: "POST",
      body: {
        requestId: delegatedBody.assignmentRequest.id,
        action: "accept"
      }
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    expect(acceptedBody.assignmentRequest.status).toBe("accepted");
    expect(acceptedBody.task.status).toBe("in_progress");
    expect(acceptedBody.task.assignee).toBe("Bob");
  });

  test("owner can invite approved Slack members and members only access their tasks", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const alice = await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });
    const aliceBody = await alice.json();
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "No Slack",
        aliases: ["noslack"]
      }
    });
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Inactive",
        slackUserId: "U_INACTIVE",
        active: false
      }
    });

    const emptySelection = await request(runtime, "/api/settings/member-invites", {
      method: "POST",
      cookie: adminCookie,
      body: { ownerIds: [] }
    });
    const emptySelectionBody = await emptySelection.json();
    expect(emptySelectionBody.invitations).toHaveLength(0);

    const invited = await request(runtime, "/api/settings/member-invites", {
      method: "POST",
      cookie: adminCookie,
      body: {}
    });
    expect(invited.status).toBe(200);
    const invitedBody = await invited.json();
    expect(invitedBody.invitations).toHaveLength(1);
    expect(invitedBody.invitations[0].ownerId).toBe(aliceBody.owner.id);
    expect(invitedBody.outbox).toHaveLength(1);
    expect(invitedBody.outbox[0].payload.memberInvitationId).toBe(invitedBody.invitations[0].id);

    const inviteOutbox = await agentRequest(runtime, agent, "/api/agent/outbox");
    const inviteOutboxBody = await inviteOutbox.json();
    expect(inviteOutboxBody.outbox[0].payload.actions[0].kind).toBe("dm");
    expect(inviteOutboxBody.outbox[0].payload.actions[0].userId).toBe("U_ALICE");

    const duplicate = await request(runtime, "/api/settings/member-invites", {
      method: "POST",
      cookie: adminCookie,
      body: {}
    });
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.invitations).toHaveLength(0);
    expect(duplicateBody.skipped[0].reason).toBe("pending_invitation");

    const token = inviteTokenFromAction(inviteOutboxBody.outbox[0].payload.actions[0]);
    const accepted = await request(runtime, "/api/invitations/accept", {
      method: "POST",
      body: {
        token,
        email: "alice@example.com",
        password: "password123",
        name: "Alice"
      }
    });
    expect(accepted.status).toBe(201);
    const memberCookie = cookieHeader(accepted);
    const acceptedBody = await accepted.json();
    expect(acceptedBody.role).toBe("member");
    expect(acceptedBody.token).toBeUndefined();
    expect(acceptedBody.owner.ownerName).toBe("Alice");
    expect(runtime.store.getUserProfile(acceptedBody.user.id)).toMatchObject({
      role: "member",
      ownerId: aliceBody.owner.id,
      slackUserId: "U_ALICE"
    });

    const memberSettings = await request(runtime, "/api/settings/member-invites", {
      cookie: memberCookie
    });
    expect(memberSettings.status).toBe(403);

    const aliceTask = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: adminCookie,
      body: {
        title: "Alice task",
        assignee: "Alice",
        status: "confirmed"
      }
    });
    const aliceTaskBody = await aliceTask.json();
    const otherTask = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: adminCookie,
      body: {
        title: "Owner task",
        status: "confirmed"
      }
    });
    const otherTaskBody = await otherTask.json();

    const memberTasks = await request(runtime, "/api/tasks", { cookie: memberCookie });
    expect(memberTasks.status).toBe(200);
    const memberTasksBody = await memberTasks.json();
    expect(memberTasksBody.tasks.map((task: { id: string }) => task.id)).toEqual([aliceTaskBody.task.id]);

    const forbiddenTask = await request(runtime, `/api/tasks/${otherTaskBody.task.id}`, { cookie: memberCookie });
    expect(forbiddenTask.status).toBe(404);

    const memberPatch = await request(runtime, `/api/tasks/${aliceTaskBody.task.id}`, {
      method: "PATCH",
      cookie: memberCookie,
      body: {
        status: "in_progress",
        nextAction: "Ship the update",
        result: "Started"
      }
    });
    expect(memberPatch.status).toBe(200);
    const memberPatchBody = await memberPatch.json();
    expect(memberPatchBody.task.status).toBe("in_progress");
    expect(memberPatchBody.task.nextAction).toBe("Ship the update");
    expect(memberPatchBody.task.result).toBe("Started");

    const forbiddenPatch = await request(runtime, `/api/tasks/${aliceTaskBody.task.id}`, {
      method: "PATCH",
      cookie: memberCookie,
      body: {
        priority: "P0"
      }
    });
    expect(forbiddenPatch.status).toBe(403);

    const reused = await request(runtime, "/api/invitations/accept", {
      method: "POST",
      body: {
        token,
        email: "alice-again@example.com",
        password: "password123"
      }
    });
    expect(reused.status).toBe(409);
  });

  test("member invitations reject revoked and expired tokens", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const ownerResponse = await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Bob",
        slackUserId: "U_BOB"
      }
    });
    const owner = (await ownerResponse.json()).owner;

    const invited = await request(runtime, "/api/settings/member-invites", {
      method: "POST",
      cookie: adminCookie,
      body: { ownerIds: [owner.id] }
    });
    const invitedBody = await invited.json();
    const inviteOutbox = await agentRequest(runtime, agent, "/api/agent/outbox");
    const inviteOutboxBody = await inviteOutbox.json();
    const revokedToken = inviteTokenFromAction(inviteOutboxBody.outbox[0].payload.actions[0]);
    const revoked = await request(runtime, `/api/settings/member-invites/${invitedBody.invitations[0].id}/revoke`, {
      method: "POST",
      cookie: adminCookie,
      body: {}
    });
    expect(revoked.status).toBe(200);

    const revokedAccept = await request(runtime, "/api/invitations/accept", {
      method: "POST",
      body: {
        token: revokedToken,
        email: "bob@example.com",
        password: "password123"
      }
    });
    expect(revokedAccept.status).toBe(409);

    const expired = runtime.store.createMemberInvitation({
      owner,
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    const expiredAccept = await request(runtime, "/api/invitations/accept", {
      method: "POST",
      body: {
        token: expired.token,
        email: "expired@example.com",
        password: "password123"
      }
    });
    expect(expiredAccept.status).toBe(409);
  });

  test("Slack digest collect and commit creates low-token task proposals and advances cursor", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "T777",
        channelId: "C777",
        channelName: "eng",
        messages: [
          {
            ts: "1710000000.000400",
            threadTs: "1710000000.000400",
            userId: "U333",
            userName: "Jae",
            text: "P1 runbook 수정 필요. 오늘 배포 전에 정리해야 함",
            permalink: "https://example.slack.com/archives/C777/p1710000000000400"
          },
          {
            ts: "1710000001.000400",
            userId: "U444",
            userName: "Min",
            text: "thanks for fixing the deploy bug, great work"
          },
          {
            ts: "1710000002.000400",
            userId: "U555",
            userName: "Lee",
            text: "the checkout regression is annoying but let's discuss later"
          },
          {
            ts: "1710000003.000400",
            userId: "B999",
            botId: "B999",
            text: "자동 응답입니다"
          }
        ]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();
    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.classifications).toHaveLength(4);
    expect(collectedBody.digest.payload.classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageTs: "1710000000.000400",
          qualifies: true,
          isWorkRelated: true,
          reason: "korean-work-intent",
          excludedReason: null
        }),
        expect.objectContaining({
          messageTs: "1710000001.000400",
          qualifies: false,
          isWorkRelated: false,
          reason: null,
          excludedReason: "casual"
        }),
        expect.objectContaining({
          messageTs: "1710000002.000400",
          qualifies: false,
          isWorkRelated: false,
          reason: null,
          excludedReason: "no-work-action"
        }),
        expect.objectContaining({
          messageTs: "1710000003.000400",
          qualifies: false,
          isWorkRelated: false,
          reason: null,
          excludedReason: "bot-origin"
        })
      ])
    );
    expect(collectedBody.digest.payload.candidates[0].reason).toBe("korean-work-intent");
    expect(collectedBody.digest.payload.candidates[0].classification).toMatchObject({
      schemaVersion: slackTaskificationEligibilitySchema.version,
      workspaceId: "T777",
      channelId: "C777",
      threadTs: "1710000000.000400",
      messageTs: "1710000000.000400",
      messageText: "P1 runbook 수정 필요. 오늘 배포 전에 정리해야 함",
      qualifies: true,
      isWorkRelated: true,
      reason: "korean-work-intent",
      excludedReason: null,
      assigneeCandidates: []
    });
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject({
      taskTitle: "P1 runbook 수정 필요. 오늘 배포 전에 정리해야 함",
      taskDescription: expect.stringContaining("Original message:"),
      dueAt: "today",
      nextAction: expect.stringContaining("runbook 수정 필요"),
      relevantContext: expect.arrayContaining(["P1 runbook 수정 필요. 오늘 배포 전에 정리해야 함"])
    });
    expect(collectedBody.cursor).toBe(null);

    const beforeCommit = await request(runtime, "/api/tasks", { cookie: adminCookie });
    const beforeCommitBody = await beforeCommit.json();
    expect(beforeCommitBody.tasks).toHaveLength(0);

    const committed = await agentRequest(runtime, agent, "/api/agent/slack/digest/commit", {
      method: "POST",
      body: { digestId: collectedBody.digest.id }
    });
    expect(committed.status).toBe(200);
    const committedBody = await committed.json();
    expect(committedBody.tasks).toHaveLength(1);
    expect(committedBody.tasks[0].status).toBe("proposed");
    expect(committedBody.tasks[0].priority).toBe("P1");
    expect(committedBody.tasks[0].title).toBe("P1 runbook 수정 필요. 오늘 배포 전에 정리해야 함");
    expect(committedBody.tasks[0].dueAt).toBe("today");
    expect(committedBody.tasks[0].nextAction).toContain("runbook 수정 필요");
    expect(committedBody.tasks[0].dedupeKey).toBe("slack:T777:C777:1710000000.000400:unassigned");
    expect(committedBody.tasks[0].description).toContain(`- Candidate: ${collectedBody.digest.payload.candidates[0].id}`);
    expect(committedBody.tasks[0].description).toContain("- Workspace: T777");
    expect(committedBody.cursor.lastTs).toBe("1710000003.000400");
    expect(committedBody.actions[0].kind).toBe("thread_reply");
    const storedCandidate = runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, committedBody.tasks[0].dedupeKey);
    expect(storedCandidate).toMatchObject({
      agentId: agent.id,
      taskId: committedBody.tasks[0].id,
      workspaceId: "T777",
      channelId: "C777",
      threadTs: "1710000000.000400",
      messageTs: "1710000000.000400",
      confirmationState: "assigning",
      dedupeKey: "slack:T777:C777:1710000000.000400:unassigned",
      payload: expect.objectContaining({
        candidateId: committedBody.tasks[0].id,
        workspaceId: "T777",
        channelId: "C777",
        threadTs: "1710000000.000400",
        messageTs: "1710000000.000400",
        messageText: "P1 runbook 수정 필요. 오늘 배포 전에 정리해야 함",
        taskTitle: "P1 runbook 수정 필요. 오늘 배포 전에 정리해야 함",
        sourceMessageLink: "https://example.slack.com/archives/C777/p1710000000000400",
        requester: "U333",
        relevantContext: expect.arrayContaining(["P1 runbook 수정 필요. 오늘 배포 전에 정리해야 함"]),
        sourceUrl: "https://example.slack.com/archives/C777/p1710000000000400",
        markdownPath: committedBody.tasks[0].markdownPath
      })
    });

    const afterCommit = await request(runtime, "/api/tasks", { cookie: adminCookie });
    const afterCommitBody = await afterCommit.json();
    expect(afterCommitBody.tasks).toHaveLength(1);

    const committedAgain = await agentRequest(runtime, agent, "/api/agent/slack/digest/commit", {
      method: "POST",
      body: { digestId: collectedBody.digest.id }
    });
    expect(committedAgain.status).toBe(200);
    const committedAgainBody = await committedAgain.json();
    expect(committedAgainBody.tasks).toHaveLength(1);
    expect(committedAgainBody.tasks[0].id).toBe(committedBody.tasks[0].id);
    expect(runtime.store.listTasks().filter((task) => task.dedupeKey === committedBody.tasks[0].dedupeKey)).toHaveLength(1);
    expect(
      (runtime.store.db
        .query("SELECT COUNT(*) AS count FROM slack_task_candidates WHERE agent_id = ? AND dedupe_key = ?")
        .get(agent.id, committedBody.tasks[0].dedupeKey) as { count: number }).count
    ).toBe(1);
  });

  test("Slack digest collection reuses the existing candidate when the same message is collected again", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const collectBody = {
      workspaceId: "TREUSE",
      channelId: "CREUSE",
      channelName: "ops",
      nextLastTs: "1710000499.000000",
      messages: [
        {
          ts: "1710000500.000400",
          threadTs: "1710000500.000400",
          userId: "U333",
          userName: "Jae",
          text: "P1 prepare the deploy checklist before release",
          permalink: "https://example.slack.com/archives/CREUSE/p1710000500000400"
        }
      ]
    };

    const first = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: collectBody
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.digest.payload.candidates).toHaveLength(1);

    const firstCommit = await agentRequest(runtime, agent, "/api/agent/slack/digest/commit", {
      method: "POST",
      body: { digestId: firstBody.digest.id }
    });
    expect(firstCommit.status).toBe(200);
    const firstCommitBody = await firstCommit.json();
    const dedupeKey = "slack:TREUSE:CREUSE:1710000500.000400:unassigned";
    expect(firstCommitBody.tasks[0]).toMatchObject({ dedupeKey, status: "proposed" });
    expect(firstCommitBody.confirmationOutbox).toHaveLength(1);
    const persistedCandidate = runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, dedupeKey);
    expect(persistedCandidate).not.toBeNull();
    runtime.store.db
      .query("UPDATE slack_task_candidates SET payload = ? WHERE agent_id = ? AND dedupe_key = ?")
      .run(
        JSON.stringify({
          ...persistedCandidate!.payload,
          taskTitle: "Existing confirmation-requested candidate"
        }),
        agent.id,
        dedupeKey
      );

    const second = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: collectBody
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.digest.payload.collectionPersistence).toMatchObject({
      insertedMessages: 0,
      duplicateMessages: 1
    });
    expect(secondBody.digest.payload.messages).toHaveLength(1);
    expect(secondBody.digest.payload.candidates).toHaveLength(1);
    expect(secondBody.digest.payload.candidates[0]).toMatchObject({
      workspaceId: "TREUSE",
      channelId: "CREUSE",
      ts: "1710000500.000400",
      taskTitle: "P1 prepare the deploy checklist before release"
    });

    const secondCommit = await agentRequest(runtime, agent, "/api/agent/slack/digest/commit", {
      method: "POST",
      body: { digestId: secondBody.digest.id }
    });
    expect(secondCommit.status).toBe(200);
    const secondCommitBody = await secondCommit.json();
    expect(secondCommitBody.tasks).toHaveLength(1);
    expect(secondCommitBody.tasks[0].id).toBe(firstCommitBody.tasks[0].id);
    expect(secondCommitBody.confirmationOutbox).toEqual([]);
    expect(runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, dedupeKey)?.payload.taskTitle).toBe(
      "Existing confirmation-requested candidate"
    );
    expect(runtime.store.listTasks().filter((task) => task.dedupeKey === dedupeKey)).toHaveLength(1);
    expect(
      (runtime.store.db
        .query("SELECT COUNT(*) AS count FROM slack_task_candidates WHERE agent_id = ? AND dedupe_key = ?")
        .get(agent.id, dedupeKey) as { count: number }).count
    ).toBe(1);
    expect(
      (runtime.store.db
        .query("SELECT COUNT(*) AS count FROM slack_task_candidate_confirmations WHERE agent_id = ? AND dedupe_key = ?")
        .get(agent.id, dedupeKey) as { count: number }).count
    ).toBe(1);
  });

  test("Slack digest collection keeps work-related non-chat messages as task candidates before commit", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "T777",
        channelId: "C777",
        channelName: "eng",
        messages: [
          {
            ts: "1710000100.000400",
            userId: "U333",
            userName: "Jae",
            text: "Investigate checkout regression",
            permalink: "https://example.slack.com/archives/C777/p1710000100000400"
          },
          {
            ts: "1710000101.000400",
            userId: "U444",
            userName: "Min",
            text: "thanks for looking at the checkout regression"
          }
        ]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();
    expect(collectedBody.digest.payload.classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageTs: "1710000100.000400",
          qualifies: false,
          isWorkRelated: true,
          excludedReason: "no-assignment-signal"
        }),
        expect.objectContaining({
          messageTs: "1710000101.000400",
          qualifies: false,
          isWorkRelated: false,
          excludedReason: "casual"
        })
      ])
    );
    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject({
      ts: "1710000100.000400",
      reason: "no-assignment-signal",
      classification: expect.objectContaining({
        isWorkRelated: true,
        excludedReason: "no-assignment-signal"
      })
    });

    const committed = await agentRequest(runtime, agent, "/api/agent/slack/digest/commit", {
      method: "POST",
      body: { digestId: collectedBody.digest.id }
    });
    expect(committed.status).toBe(200);
    const committedBody = await committed.json();
    expect(committedBody.tasks).toHaveLength(1);
    expect(committedBody.tasks[0]).toMatchObject({
      status: "proposed",
      dedupeKey: "slack:T777:C777:1710000100.000400:unassigned"
    });
    expect(committedBody.confirmationOutbox).toHaveLength(1);
  });

  test("Slack digest guest TTS example-message fixture matches expected task candidate output", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const fixture = readJsonFixture<{
      input: {
        workspaceId: string;
        channelId: string;
        channelName: string;
        messages: Array<Record<string, unknown>>;
      };
      expectedCandidate: Record<string, unknown>;
    }>("tests/fixtures/slack-taskification/guest-tts-example-message.json");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: fixture.input
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();

    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject(fixture.expectedCandidate);
    expect(collectedBody.digest.payload.candidates[0].taskDescription).toContain(
      "Can <@U_ALICE> add the guest TTS example-message fixture before demo?"
    );
    expect(collectedBody.digest.payload.candidates[0].relevantContext).toEqual(
      expect.arrayContaining([
        "Can <@U_ALICE> add the guest TTS example-message fixture before demo?",
        "https://example.slack.com/archives/CGUEST/p1710000300000400"
      ])
    );
  });

  test("Slack digest page loading animation example-message fixture matches expected task candidate output", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const fixture = readJsonFixture<{
      input: {
        workspaceId: string;
        channelId: string;
        channelName: string;
        messages: Array<Record<string, unknown>>;
      };
      expectedCandidate: Record<string, unknown>;
    }>("tests/fixtures/slack-taskification/page-loading-animation-example-message.json");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: fixture.input
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();

    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject(fixture.expectedCandidate);
    expect(collectedBody.digest.payload.candidates[0].taskDescription).toContain(
      "Can <@U_ALICE> add the page loading animation example-message fixture before demo?"
    );
    expect(collectedBody.digest.payload.candidates[0].relevantContext).toEqual(
      expect.arrayContaining([
        "Can <@U_ALICE> add the page loading animation example-message fixture before demo?",
        "https://example.slack.com/archives/CPAGELOAD/p1710000310000400"
      ])
    );
  });

  test("Slack digest dev app issue example-message fixture matches expected task candidate output", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const fixture = readJsonFixture<{
      input: {
        workspaceId: string;
        channelId: string;
        channelName: string;
        messages: Array<Record<string, unknown>>;
      };
      expectedCandidate: Record<string, unknown>;
    }>("tests/fixtures/slack-taskification/dev-app-issue-example-message.json");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: fixture.input
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();

    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject(fixture.expectedCandidate);
    expect(collectedBody.digest.payload.candidates[0].taskDescription).toContain(
      "Can <@U_ALICE> add the dev app issue example-message fixture before demo?"
    );
    expect(collectedBody.digest.payload.candidates[0].relevantContext).toEqual(
      expect.arrayContaining([
        "Can <@U_ALICE> add the dev app issue example-message fixture before demo?",
        "https://example.slack.com/archives/CDEVAPP/p1710000320000400"
      ])
    );
  });

  test("Slack digest server latency before 3 example-message fixture matches expected task candidate output", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const fixture = readJsonFixture<{
      input: {
        workspaceId: string;
        channelId: string;
        channelName: string;
        messages: Array<Record<string, unknown>>;
      };
      expectedCandidate: Record<string, unknown>;
    }>("tests/fixtures/slack-taskification/server-latency-before-3-example-message.json");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: fixture.input
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();

    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject(fixture.expectedCandidate);
    expect(collectedBody.digest.payload.candidates[0].taskDescription).toContain(
      "Can <@U_ALICE> investigate server latency before 3?"
    );
    expect(collectedBody.digest.payload.candidates[0].relevantContext).toEqual(
      expect.arrayContaining([
        "Can <@U_ALICE> investigate server latency before 3?",
        "https://example.slack.com/archives/CENG/p1710000330000400"
      ])
    );
  });

  test("Slack digest live deploy example-message fixture matches expected task candidate output", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const fixture = readJsonFixture<{
      input: {
        workspaceId: string;
        channelId: string;
        channelName: string;
        messages: Array<Record<string, unknown>>;
      };
      expectedCandidate: Record<string, unknown>;
    }>("tests/fixtures/slack-taskification/live-deploy-example-message.json");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: fixture.input
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();

    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject(fixture.expectedCandidate);
    expect(collectedBody.digest.payload.candidates[0].taskDescription).toContain(
      "Can <@U_ALICE> deploy the live build to production before 5pm?"
    );
    expect(collectedBody.digest.payload.candidates[0].relevantContext).toEqual(
      expect.arrayContaining([
        "Can <@U_ALICE> deploy the live build to production before 5pm?",
        "https://example.slack.com/archives/CLIVE/p1710000340000400"
      ])
    );
  });

  test("Slack digest TTS setup sharing example-message fixture matches expected task candidate output", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const fixture = readJsonFixture<{
      input: {
        workspaceId: string;
        channelId: string;
        channelName: string;
        messages: Array<Record<string, unknown>>;
      };
      expectedCandidate: Record<string, unknown>;
    }>("tests/fixtures/slack-taskification/tts-setup-sharing-example-message.json");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: fixture.input
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();

    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject(fixture.expectedCandidate);
    expect(collectedBody.digest.payload.candidates[0].taskDescription).toContain(
      "Can <@U_ALICE> document and share the TTS setup steps before demo?"
    );
    expect(collectedBody.digest.payload.candidates[0].relevantContext).toEqual(
      expect.arrayContaining([
        "Can <@U_ALICE> document and share the TTS setup steps before demo?",
        "https://example.slack.com/archives/CTTSSETUP/p1710000350000400"
      ])
    );
  });

  test("Slack digest BGM template example-message fixture matches expected task candidate output", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const fixture = readJsonFixture<{
      input: {
        workspaceId: string;
        channelId: string;
        channelName: string;
        messages: Array<Record<string, unknown>>;
      };
      expectedCandidate: Record<string, unknown>;
    }>("tests/fixtures/slack-taskification/bgm-template-example-message.json");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: fixture.input
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();

    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject(fixture.expectedCandidate);
    expect(collectedBody.digest.payload.candidates[0].taskDescription).toContain(
      "Can <@U_ALICE> add the BGM template example-message fixture before demo?"
    );
    expect(collectedBody.digest.payload.candidates[0].relevantContext).toEqual(
      expect.arrayContaining([
        "Can <@U_ALICE> add the BGM template example-message fixture before demo?",
        "https://example.slack.com/archives/CBGM/p1710000360000400"
      ])
    );
  });

  test("Slack digest extraction flow produces expected task candidates for all seven example messages", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    const fixturePaths = [
      "tests/fixtures/slack-taskification/guest-tts-example-message.json",
      "tests/fixtures/slack-taskification/page-loading-animation-example-message.json",
      "tests/fixtures/slack-taskification/dev-app-issue-example-message.json",
      "tests/fixtures/slack-taskification/server-latency-before-3-example-message.json",
      "tests/fixtures/slack-taskification/live-deploy-example-message.json",
      "tests/fixtures/slack-taskification/tts-setup-sharing-example-message.json",
      "tests/fixtures/slack-taskification/bgm-template-example-message.json"
    ];
    const fixtures = fixturePaths.map((path) =>
      readJsonFixture<{
        name: string;
        input: {
          workspaceId: string;
          channelId: string;
          channelName: string;
          messages: Array<Record<string, unknown>>;
        };
        expectedCandidate: Record<string, unknown> & { text: string; permalink: string };
      }>(path)
    );

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const producedCandidates: Array<{ fixtureName: string; candidate: Record<string, unknown> }> = [];
    for (const fixture of fixtures) {
      const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
        method: "POST",
        body: fixture.input
      });
      expect(collected.status, fixture.name).toBe(200);
      const collectedBody = await collected.json();
      expect(collectedBody.digest.payload.candidates, fixture.name).toHaveLength(1);
      producedCandidates.push({
        fixtureName: fixture.name,
        candidate: collectedBody.digest.payload.candidates[0]
      });
    }

    expect(producedCandidates).toHaveLength(7);
    expect(producedCandidates.map(({ fixtureName }) => fixtureName)).toEqual(fixtures.map(({ name }) => name));

    for (const [index, fixture] of fixtures.entries()) {
      const candidate = producedCandidates[index]?.candidate;
      expect(candidate, fixture.name).toMatchObject(fixture.expectedCandidate);
      expect(candidate?.taskDescription, fixture.name).toContain(fixture.expectedCandidate.text);
      expect(candidate?.relevantContext, fixture.name).toEqual(
        expect.arrayContaining([fixture.expectedCandidate.text, fixture.expectedCandidate.permalink])
      );
      expect(candidate?.classification, fixture.name).toMatchObject({
        qualifies: true,
        isWorkRelated: true,
        excludedReason: null
      });
    }
  });

  test("Slack digest detects exactly one clear assignee for task candidates", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "T777",
        channelId: "C777",
        channelName: "eng",
        messages: [
          {
            ts: "1710000102.000400",
            threadTs: "1710000102.000400",
            userId: "U_LEADER",
            userName: "Jae",
            text: "Can <@U_ALICE> review the checkout fix before EOD?",
            permalink: "https://example.slack.com/archives/C777/p1710000102000400"
          }
        ]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();
    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject({
      assigneeCandidates: ["U_ALICE"],
      assigneeSlackUserId: "U_ALICE",
      assignee: "Alice",
      memberMappingUncertainties: [
        {
          subject: "author",
          slackUserId: "U_LEADER",
          slackUserName: "Jae",
          reason: "unmapped_slack_user"
        }
      ],
      assigneeResolution: "assigned",
      requiresAssigneeConfirmation: false,
      classification: expect.objectContaining({
        qualifies: true,
        assigneeCandidates: ["U_ALICE"]
      })
    });

    const committed = await agentRequest(runtime, agent, "/api/agent/slack/digest/commit", {
      method: "POST",
      body: { digestId: collectedBody.digest.id }
    });
    expect(committed.status).toBe(200);
    const committedBody = await committed.json();
    expect(committedBody.tasks).toHaveLength(1);
    expect(committedBody.tasks[0]).toMatchObject({
      status: "proposed",
      assignee: "Alice",
      dedupeKey: "slack:T777:C777:1710000102.000400:U_ALICE"
    });
    expect(committedBody.confirmationOutbox).toHaveLength(1);
    const committedAction = committedBody.confirmationOutbox[0].payload.actions[0];
    expect(committedAction).toMatchObject({ kind: "dm" });
    expect(committedAction.userId).toBe(committedAction.metadata.candidate.confirmationTarget);
    expect(committedAction.metadata.candidate).toMatchObject({
      confirmationTarget: committedAction.userId,
      confirmationState: "proposed",
      assignee: "Alice",
      assigneeCandidates: ["U_ALICE"],
      assigneeResolution: "assigned",
      requiresAssigneeConfirmation: false,
      dedupeKey: "slack:T777:C777:1710000102.000400:U_ALICE"
    });

    const storedCandidate = runtime.store.getSlackTaskCandidateByDedupeKey(
      agent.id,
      "slack:T777:C777:1710000102.000400:U_ALICE"
    );
    expect(storedCandidate).toMatchObject({
      assigneeKey: "U_ALICE",
      confirmationTarget: "U_ALICE",
      confirmationState: "proposed",
      payload: expect.objectContaining({
        assignee: "Alice",
        assigneeCandidates: ["U_ALICE"],
        assigneeResolution: "assigned",
        requiresAssigneeConfirmation: false,
        memberMappingUncertainties: [
          {
            subject: "author",
            slackUserId: "U_LEADER",
            slackUserName: "Jae",
            reason: "unmapped_slack_user"
          }
        ]
      })
    });
  });

  test("Slack digest marks unmapped mentioned assignees as missing assignee confidence", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "T777",
        channelId: "C777",
        channelName: "eng",
        messages: [
          {
            ts: "1710000102.500400",
            threadTs: "1710000102.500400",
            userId: "U_LEADER",
            userName: "Jae",
            text: "Can <@U_UNKNOWN> review the checkout fix before EOD?",
            permalink: "https://example.slack.com/archives/C777/p1710000102500400"
          }
        ]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();
    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject({
      assigneeCandidates: ["U_UNKNOWN"],
      assigneeSlackUserId: "U_UNKNOWN",
      assignee: null,
      assigneeResolution: "unassigned",
      requiresAssigneeConfirmation: true,
      memberMappingUncertainties: [
        {
          subject: "author",
          slackUserId: "U_LEADER",
          slackUserName: "Jae",
          reason: "unmapped_slack_user"
        },
        {
          subject: "mentioned_user",
          slackUserId: "U_UNKNOWN",
          slackUserName: null,
          reason: "unmapped_slack_user"
        }
      ],
      classification: expect.objectContaining({
        assigneeResolution: "assigned",
        requiresAssigneeConfirmation: false
      })
    });

    const committed = await agentRequest(runtime, agent, "/api/agent/slack/digest/commit", {
      method: "POST",
      body: { digestId: collectedBody.digest.id }
    });
    expect(committed.status).toBe(200);
    const committedBody = await committed.json();
    expect(committedBody.tasks[0]).toMatchObject({
      status: "proposed",
      assignee: null,
      dedupeKey: "slack:T777:C777:1710000102.500400:U_UNKNOWN"
    });
    expect(committedBody.confirmationOutbox).toHaveLength(1);
    expect(committedBody.confirmationOutbox[0].payload.actions[0].metadata.candidate).toMatchObject({
      confirmationState: "assigning",
      confirmationTarget: "U_LEADER",
      assigneeResolution: "unassigned",
      requiresAssigneeConfirmation: true
    });
  });

  test("Slack digest splits multi-mention work messages into one candidate per assignee", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Alice",
        slackUserId: "U_ALICE",
        aliases: ["alice"]
      }
    });
    await request(runtime, "/api/settings/owners", {
      method: "POST",
      cookie: adminCookie,
      body: {
        ownerName: "Bob",
        slackUserId: "U_BOB",
        aliases: ["bob"]
      }
    });

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "T777",
        channelId: "C777",
        channelName: "eng",
        messages: [
          {
            ts: "1710000103.000400",
            threadTs: "1710000103.000400",
            userId: "U_LEADER",
            userName: "Jae",
            text: "Can <@U_ALICE> and <@U_BOB> review the checkout fix before EOD?",
            permalink: "https://example.slack.com/archives/C777/p1710000103000400"
          }
        ]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();
    expect(collectedBody.digest.payload.classifications).toHaveLength(1);
    expect(collectedBody.digest.payload.classifications[0]).toMatchObject({
      assigneeCandidates: ["U_ALICE", "U_BOB"],
      assigneeResolution: "ambiguous"
    });
    expect(collectedBody.digest.payload.candidates).toHaveLength(2);
    expect(collectedBody.digest.payload.candidates.map((candidate: { assigneeSlackUserId: string }) => candidate.assigneeSlackUserId)).toEqual([
      "U_ALICE",
      "U_BOB"
    ]);
    expect(collectedBody.digest.payload.candidates.map((candidate: { assignee: string }) => candidate.assignee)).toEqual([
      "Alice",
      "Bob"
    ]);

    const committed = await agentRequest(runtime, agent, "/api/agent/slack/digest/commit", {
      method: "POST",
      body: { digestId: collectedBody.digest.id }
    });
    expect(committed.status).toBe(200);
    const committedBody = await committed.json();
    expect(committedBody.tasks).toHaveLength(2);
    expect(committedBody.tasks.map((task: Task) => task.assignee)).toEqual(["Alice", "Bob"]);
    expect(committedBody.tasks.map((task: Task) => task.dedupeKey)).toEqual([
      "slack:T777:C777:1710000103.000400:U_ALICE",
      "slack:T777:C777:1710000103.000400:U_BOB"
    ]);
    expect(committedBody.confirmationOutbox).toHaveLength(2);
    expect(
      committedBody.confirmationOutbox.map(
        (outbox: { payload: { actions: Array<{ metadata: { candidate: SlackTaskCandidateMetadata } }> } }) => {
          const action = outbox.payload.actions[0];
          expect(action).toBeDefined();
          return action!.metadata.candidate;
        }
      )
    ).toEqual([
      expect.objectContaining({
        assignee: "Alice",
        assigneeCandidates: ["U_ALICE", "U_BOB"],
        confirmationState: "proposed",
        dedupeKey: "slack:T777:C777:1710000103.000400:U_ALICE"
      }),
      expect.objectContaining({
        assignee: "Bob",
        assigneeCandidates: ["U_ALICE", "U_BOB"],
        confirmationState: "proposed",
        dedupeKey: "slack:T777:C777:1710000103.000400:U_BOB"
      })
    ]);
    expect(
      runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, "slack:T777:C777:1710000103.000400:U_ALICE")
    ).toMatchObject({ assigneeKey: "U_ALICE", confirmationState: "proposed" });
    expect(
      runtime.store.getSlackTaskCandidateByDedupeKey(agent.id, "slack:T777:C777:1710000103.000400:U_BOB")
    ).toMatchObject({ assigneeKey: "U_BOB", confirmationState: "proposed" });
  });

  test("Slack task candidates derive concise content with surrounding thread context", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "T777",
        channelId: "C777",
        channelName: "eng",
        messages: [
          {
            ts: "1710000119.000400",
            threadTs: "1710000119.000400",
            userId: "U_LEADER",
            userName: "Jae",
            text: "Context: customer reports checkout fails only for annual plans"
          },
          {
            ts: "1710000120.000400",
            threadTs: "1710000119.000400",
            userId: "U_LEADER",
            userName: "Jae",
            text: "<@U_ALICE> please investigate checkout regression before 3pm and post next steps",
            permalink: "https://example.slack.com/archives/C777/p1710000120000400"
          }
        ]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();
    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject({
      taskTitle: "Investigate checkout regression before 3pm and post next steps",
      dueAt: "3pm and post next steps",
      nextAction: "Investigate checkout regression before 3pm and post next steps",
      relevantContext: expect.arrayContaining([
        "<@U_ALICE> please investigate checkout regression before 3pm and post next steps",
        "Context: customer reports checkout fails only for annual plans"
      ])
    });
    expect(collectedBody.digest.payload.candidates[0].taskDescription).toContain("Relevant Slack context:");
    expect(collectedBody.digest.payload.candidates[0].taskDescription).toContain("customer reports checkout fails");

    const committed = await agentRequest(runtime, agent, "/api/agent/slack/digest/commit", {
      method: "POST",
      body: { digestId: collectedBody.digest.id }
    });
    expect(committed.status).toBe(200);
    const committedBody = await committed.json();
    expect(committedBody.tasks[0]).toMatchObject({
      title: "Investigate checkout regression before 3pm and post next steps",
      dueAt: "3pm and post next steps",
      nextAction: "Investigate checkout regression before 3pm and post next steps"
    });
    expect(committedBody.tasks[0].description).toContain("Relevant Slack context:");
    expect(committedBody.tasks[0].description).toContain("customer reports checkout fails");
    expect(committedBody.confirmationOutbox[0].payload.actions[0].metadata.candidate.relevantContext).toEqual(
      expect.arrayContaining(["Context: customer reports checkout fails only for annual plans"])
    );
  });

  test("Slack digest collection classifies eligible, non-work, ambiguous, and unsupported Slack messages", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "T777",
        channelId: "C777",
        channelName: "eng",
        messages: [
          {
            type: "message",
            ts: "1710000200.000400",
            userId: "U333",
            userName: "Jae",
            text: "Can <@U_ALICE> review the checkout fix before EOD?",
            permalink: "https://example.slack.com/archives/C777/p1710000200000400"
          },
          {
            type: "message",
            ts: "1710000201.000400",
            userId: "U444",
            userName: "Min",
            text: "thanks, sounds good"
          },
          {
            type: "message",
            ts: "1710000202.000400",
            userId: "U555",
            userName: "Lee",
            text: "Investigate the flaky checkout test"
          },
          {
            type: "reaction_added",
            ts: "1710000203.000400",
            userId: "U666",
            text: "P1 prepare the deploy checklist before release"
          },
          {
            type: "message",
            subtype: "channel_join",
            ts: "1710000204.000400",
            userId: "U777",
            text: "P1 prepare the deploy checklist before release"
          }
        ]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();

    expect(collectedBody.collectionFilter).toMatchObject({
      receivedMessages: 5,
      parsedMessages: 3,
      retainedMessages: 3
    });
    expect(collectedBody.digest.payload.classifications).toHaveLength(3);
    expect(collectedBody.digest.payload.classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageTs: "1710000200.000400",
          qualifies: true,
          isWorkRelated: true,
          reason: "mention-assignment",
          excludedReason: null,
          assigneeCandidates: ["U_ALICE"],
          assigneeResolution: "assigned",
          requiresAssigneeConfirmation: false
        }),
        expect.objectContaining({
          messageTs: "1710000201.000400",
          qualifies: false,
          isWorkRelated: false,
          reason: null,
          excludedReason: "casual"
        }),
        expect.objectContaining({
          messageTs: "1710000202.000400",
          qualifies: false,
          isWorkRelated: true,
          reason: null,
          excludedReason: "no-assignment-signal",
          assigneeResolution: "unassigned",
          requiresAssigneeConfirmation: true
        })
      ])
    );
    expect(collectedBody.digest.payload.classifications.map((item: { messageTs: string }) => item.messageTs)).not.toContain(
      "1710000203.000400"
    );
    expect(collectedBody.digest.payload.classifications.map((item: { messageTs: string }) => item.messageTs)).not.toContain(
      "1710000204.000400"
    );
    expect(collectedBody.digest.payload.candidates).toHaveLength(2);
    expect(collectedBody.digest.payload.candidates.map((candidate: { ts: string; reason: string }) => ({
      ts: candidate.ts,
      reason: candidate.reason
    }))).toEqual([
      { ts: "1710000200.000400", reason: "mention-assignment" },
      { ts: "1710000202.000400", reason: "no-assignment-signal" }
    ]);

    const beforeCommit = await request(runtime, "/api/tasks", { cookie: adminCookie });
    expect((await beforeCommit.json()).tasks).toHaveLength(0);
  });

  test("Slack digest collection ignores chatty messages even when they contain assignment-like verbs", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "T777",
        channelId: "C777",
        channelName: "eng",
        messages: [
          {
            type: "message",
            ts: "1710000220.000400",
            userId: "U333",
            userName: "Jae",
            text: "Can <@U_ALICE> review the lunch menu before EOD?",
            permalink: "https://example.slack.com/archives/C777/p1710000220000400"
          },
          {
            type: "message",
            ts: "1710000221.000400",
            userId: "U444",
            userName: "Min",
            text: "Team let's schedule coffee tomorrow"
          },
          {
            type: "message",
            ts: "1710000222.000400",
            userId: "U555",
            userName: "Lee",
            text: "do I have any tasks today?"
          },
          {
            type: "message",
            ts: "1710000223.000400",
            userId: "U666",
            userName: "Kim",
            text: "Can <@U_BOB> review the release checklist before EOD?",
            permalink: "https://example.slack.com/archives/C777/p1710000223000400"
          }
        ]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();

    expect(collectedBody.digest.payload.classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageTs: "1710000220.000400",
          qualifies: false,
          isWorkRelated: false,
          excludedReason: "casual",
          assigneeCandidates: ["U_ALICE"]
        }),
        expect.objectContaining({
          messageTs: "1710000221.000400",
          qualifies: false,
          isWorkRelated: false,
          excludedReason: "casual"
        }),
        expect.objectContaining({
          messageTs: "1710000222.000400",
          qualifies: false,
          isWorkRelated: false,
          excludedReason: "casual"
        }),
        expect.objectContaining({
          messageTs: "1710000223.000400",
          qualifies: true,
          isWorkRelated: true,
          reason: "mention-assignment",
          excludedReason: null,
          assigneeCandidates: ["U_BOB"]
        })
      ])
    );
    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject({
      ts: "1710000223.000400",
      reason: "mention-assignment",
      taskTitle: "Review the release checklist before EOD?"
    });

    const committed = await agentRequest(runtime, agent, "/api/agent/slack/digest/commit", {
      method: "POST",
      body: { digestId: collectedBody.digest.id }
    });
    expect(committed.status).toBe(200);
    const committedBody = await committed.json();
    expect(committedBody.tasks).toHaveLength(1);
    expect(committedBody.tasks[0].dedupeKey).toBe("slack:T777:C777:1710000223.000400:U_BOB");
  });

  test("Slack digest collection extracts source metadata from eligible messages", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const configured = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        workspaces: ["TMSG"],
        channels: ["C777"],
        channelThreadScopes: {
          C777: "active_threads"
        }
      }
    });
    expect(configured.status).toBe(200);

    const parsed = parseSlackDigestMessage(
      {
        type: "message",
        teamId: "TMSG",
        channelId: "C777",
        channelName: "eng",
        ts: "1710000250.000400",
        threadTs: "1710000250.000100",
        parentTs: "1710000250.000100",
        userId: "U_LEADER",
        userName: "Jae",
        text: "Can <@U_ALICE> review the release checklist before EOD?",
        permalink: "https://example.slack.com/archives/C777/p1710000250000400"
      },
      "C777",
      "eng"
    );
    if (!parsed) throw new Error("Expected Slack digest message to parse");
    expect(parsed).toMatchObject({
      workspaceId: "TMSG",
      channelId: "C777",
      channelName: "eng",
      ts: "1710000250.000400",
      threadTs: "1710000250.000100",
      parentTs: "1710000250.000100",
      userId: "U_LEADER",
      userName: "Jae",
      permalink: "https://example.slack.com/archives/C777/p1710000250000400"
    });

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        channelId: "C777",
        messages: [parsed]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();
    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0]).toMatchObject({
      workspaceId: "TMSG",
      channelId: "C777",
      channelName: "eng",
      ts: "1710000250.000400",
      threadTs: "1710000250.000100",
      userId: "U_LEADER",
      userName: "Jae",
      permalink: "https://example.slack.com/archives/C777/p1710000250000400",
      sourceChannel: {
        workspaceId: "TMSG",
        channelId: "C777",
        channelName: "eng",
        threadTs: "1710000250.000100",
        messageTs: "1710000250.000400"
      },
      sourceMessageLink: "https://example.slack.com/archives/C777/p1710000250000400",
      requester: "U_LEADER"
    });
    expect(collectedBody.digest.payload.candidates[0].classification).toMatchObject({
      workspaceId: "TMSG",
      channelId: "C777",
      threadTs: "1710000250.000100",
      messageTs: "1710000250.000400",
      assigneeCandidates: ["U_ALICE"]
    });
  });

  test("Slack digest collection persists retained messages with scope metadata and source dedupe", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const configured = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        workspaces: ["TWORK"],
        channels: ["C777"],
        mentions: ["U333"],
        keywords: ["deploy"],
        channelThreadScopes: {
          C777: "full_thread_history"
        }
      }
    });
    expect(configured.status).toBe(200);

    const collectBody = {
      workspaceId: "TWORK",
      channelId: "C777",
      channelName: "eng",
      messages: [
        {
          ts: "1710000300.000400",
          threadTs: "1710000300.000100",
          userId: "U333",
          userName: "Jae",
          text: "P1 prepare the deploy checklist before release",
          permalink: "https://example.slack.com/archives/C777/p1710000300000400"
        }
      ]
    };

    const first = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: collectBody
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.digest.payload.collectionPersistence).toMatchObject({
      insertedMessages: 1,
      duplicateMessages: 0
    });
    expect(firstBody.digest.payload.collectionRunId).toEqual(expect.stringMatching(/^slkrun_/));
    expect(firstBody.digest.payload.messages).toHaveLength(1);
    expect(firstBody.digest.payload.candidates).toHaveLength(1);

    const persisted = runtime.store.listSlackCollectedMessages({ agentId: agent.id, channelId: "C777" });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      workspaceId: "TWORK",
      channelId: "C777",
      channelName: "eng",
      threadTs: "1710000300.000100",
      messageTs: "1710000300.000400",
      collectionScopeSource: "saved",
      threadCollectionMode: "full_thread_history",
      dedupeKey: "slackmsg:TWORK:C777:1710000300.000100:1710000300.000400"
    });
    expect(persisted[0]?.collectionRunId).toBe(firstBody.digest.payload.collectionRunId);
    expect(persisted[0]?.collectionScope).toMatchObject({
      workspaces: ["TWORK"],
      channels: ["C777"],
      mentions: ["U333"],
      keywords: ["deploy"]
    });
    const runs = runtime.store.listSlackCollectionRuns({ agentId: agent.id, channelId: "C777" });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: firstBody.digest.payload.collectionRunId,
      digestId: firstBody.digest.id,
      workspaceId: "TWORK",
      channelId: "C777",
      collectionTrigger: "scheduled",
      collectionScopeSource: "saved",
      threadCollectionMode: "full_thread_history",
      status: "completed",
      receivedMessageCount: 1,
      parsedMessageCount: 1,
      retainedMessageCount: 1,
      insertedMessageCount: 1,
      duplicateMessageCount: 0,
      candidateCount: 1
    });

    const second = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: collectBody
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.digest.payload.collectionPersistence).toMatchObject({
      insertedMessages: 0,
      duplicateMessages: 1
    });
    expect(secondBody.digest.payload.messages).toEqual([]);
    expect(secondBody.digest.payload.candidates).toEqual([]);
    expect(runtime.store.listSlackCollectedMessages({ agentId: agent.id, channelId: "C777" })).toHaveLength(1);
  });

  test("Slack unprocessed message query returns persisted messages with collection run context", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "TWORK",
        channelId: "C777",
        channelName: "eng",
        messages: [
          {
            ts: "1710000400.000400",
            threadTs: "1710000400.000100",
            userId: "U333",
            userName: "Jae",
            text: "P1 prepare the deploy checklist before release",
            permalink: "https://example.slack.com/archives/C777/p1710000400000400"
          }
        ]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();
    const collectionRunId = collectedBody.digest.payload.collectionRunId;

    const unprocessed = await agentRequest(
      runtime,
      agent,
      `/api/agent/slack/messages/unprocessed?workspaceId=TWORK&channelId=C777&limit=10`
    );
    expect(unprocessed.status).toBe(200);
    const unprocessedBody = await unprocessed.json();
    expect(unprocessedBody).toMatchObject({ ok: true, count: 1 });
    expect(unprocessedBody.messages[0]).toMatchObject({
      message: {
        workspaceId: "TWORK",
        channelId: "C777",
        threadTs: "1710000400.000100",
        messageTs: "1710000400.000400",
        digestId: collectedBody.digest.id,
        collectionRunId,
        processedAt: null
      },
      collectionRun: {
        id: collectionRunId,
        digestId: collectedBody.digest.id,
        collectionTrigger: "scheduled",
        retainedMessageCount: 1,
        candidateCount: 1
      }
    });

    const committed = await agentRequest(runtime, agent, "/api/agent/slack/digest/commit", {
      method: "POST",
      body: { digestId: collectedBody.digest.id }
    });
    expect(committed.status).toBe(200);

    const afterCommit = await agentRequest(runtime, agent, "/api/agent/slack/messages/unprocessed?channelId=C777");
    expect(afterCommit.status).toBe(200);
    const afterCommitBody = await afterCommit.json();
    expect(afterCommitBody.messages).toEqual([]);
    expect(runtime.store.listSlackCollectedMessages({ agentId: agent.id, channelId: "C777" })[0]?.processedAt).toEqual(
      expect.any(String)
    );
  });

  test("Slack collection scope settings expose normalized workspace channel thread mention and keyword fields", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);

    const defaults = await request(runtime, "/api/settings/slack/collection-scope", { cookie: adminCookie });
    expect(defaults.status).toBe(200);
    const defaultsBody = await defaults.json();
    expect(defaultsBody.collectionScope).toMatchObject({
      workspace: null,
      workspaces: [],
      channels: [],
      channelThreadScopes: {},
      threads: [],
      mentions: [],
      keywords: [],
      updatedAt: null
    });
    expect(defaultsBody.collectionScopeSchema).toMatchObject({
      version: "slack_collection_scope.v1",
      supportedTriggers: ["manual", "scheduled"],
      fields: {
        workspaces: expect.objectContaining({ itemPattern: "^[TE][A-Z0-9]{2,}$" }),
        channels: expect.objectContaining({ requiredForScheduled: true }),
        channelThreadScopes: expect.objectContaining({
          allowedValues: ["parent_messages", "active_threads", "full_thread_history"]
        }),
        threads: expect.objectContaining({ itemPattern: "^\\d{10,}\\.\\d{1,6}$" }),
        mentions: expect.objectContaining({ itemPattern: "^[UW][A-Z0-9]{2,}$|^@[A-Za-z0-9._-]{1,80}$" }),
        keywords: expect.objectContaining({ maxLength: 120 })
      },
      scheduledTarget: {
        expansion: "workspaces x channels",
        defaultThreadCollectionMode: "active_threads",
        cursorKey: "agentId + channelId"
      }
    });

    const updated = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        workspace: "T111, T222",
        channels: ["C111", "C222", "C111", ""],
        channelThreadScopes: {
          C111: "parent_messages",
          C222: "full_thread_history",
          C999: "active_threads",
          "not-a-channel": "full_thread_history"
        },
        threads: "1710000000.000400, 1710000001.000500",
        mentions: ["U111", "@lead"],
        keywords: "ship, incident, 배포"
      }
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.collectionScope).toMatchObject({
      workspace: "T111",
      workspaces: ["T111", "T222"],
      channels: ["C111", "C222"],
      channelThreadScopes: {
        C111: "parent_messages",
        C222: "full_thread_history"
      },
      threads: ["1710000000.000400", "1710000001.000500"],
      mentions: ["U111", "@lead"],
      keywords: ["ship", "incident", "배포"]
    });
    expect(updatedBody.validation).toMatchObject({
      invalid: {
        channelThreadScopes: ["C999=active_threads", "not-a-channel"]
      },
      duplicates: {
        channels: ["C111"]
      },
      saved: {
        workspaces: ["T111", "T222"],
        channels: ["C111", "C222"],
        threads: ["1710000000.000400", "1710000001.000500"],
        mentions: ["U111", "@lead"],
        keywords: ["ship", "incident", "배포"],
        channelThreadScopes: ["C111=parent_messages", "C222=full_thread_history"]
      },
      hasInvalid: true,
      hasDuplicates: true
    });
    expect(updatedBody.collectionScope.updatedAt).toBeTruthy();

    const persisted = await request(runtime, "/api/settings/slack/collection-scope", { cookie: adminCookie });
    expect(persisted.status).toBe(200);
    const persistedBody = await persisted.json();
    expect(persistedBody.collectionScope.channels).toEqual(["C111", "C222"]);
    expect(readFileSync(runtime.store.configPath, "utf8")).toContain("slack_collection_scope:");

    const malformedPatch = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        channels: ["not-a-channel", "G333", "G333", 42],
        channelThreadScopes: {
          G333: "active_threads",
          C111: "not-a-mode"
        },
        threads: { bad: true },
        mentions: ["not mention", "@lead-2", "W123"],
        keywords: ["standup", "", "x".repeat(121), true]
      }
    });
    expect(malformedPatch.status).toBe(200);
    const malformedPatchBody = await malformedPatch.json();
    expect(malformedPatchBody.collectionScope).toMatchObject({
      workspace: "T111",
      workspaces: ["T111", "T222"],
      channels: ["G333"],
      channelThreadScopes: {
        G333: "active_threads"
      },
      threads: [],
      mentions: ["@lead-2", "W123"],
      keywords: ["standup"]
    });
    expect(malformedPatchBody.validation).toMatchObject({
      invalid: {
        channels: expect.arrayContaining(["not-a-channel", "42"]),
        channelThreadScopes: ["C111=not-a-mode"],
        threads: ["Expected a comma-separated string or array."],
        mentions: ["not mention"],
        keywords: expect.arrayContaining(["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "true"])
      },
      duplicates: {
        channels: ["G333"]
      },
      saved: {
        channels: ["G333"],
        threads: [],
        mentions: ["@lead-2", "W123"],
        keywords: ["standup"],
        channelThreadScopes: ["G333=active_threads"]
      },
      hasInvalid: true,
      hasDuplicates: true
    });

    const malformedWorkspace = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        workspace: "not a workspace"
      }
    });
    expect(malformedWorkspace.status).toBe(200);
    const malformedWorkspaceBody = await malformedWorkspace.json();
    expect(malformedWorkspaceBody.collectionScope.workspace).toBe(null);
    expect(malformedWorkspaceBody.collectionScope.workspaces).toEqual([]);
    expect(malformedWorkspaceBody.validation.invalid.workspaces).toEqual(["not a workspace"]);
  });

  test("Slack digest collection applies selected channel thread collection mode", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const configured = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        channels: ["C777"],
        channelThreadScopes: {
          C777: "parent_messages"
        }
      }
    });
    expect(configured.status).toBe(200);

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        channelId: "C777",
        channelName: "eng",
        messages: [
          {
            ts: "1710000000.000400",
            threadTs: "1710000000.000400",
            userId: "U333",
            text: "P1 prepare the release checklist before deploy today"
          },
          {
            ts: "1710000001.000400",
            threadTs: "1710000000.000400",
            userId: "U333",
            text: "P1 fix the follow-up migration before deploy today"
          }
        ]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();
    expect(collectedBody.threadCollectionMode).toBe("parent_messages");
    expect(collectedBody.digest.payload.threadCollectionMode).toBe("parent_messages");
    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0].ts).toBe("1710000000.000400");
  });

  test("Slack digest collection applies configured channel user and time-window filters", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const configured = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        workspaces: ["TWORK"],
        channels: ["C777"],
        mentions: ["U333"]
      }
    });
    expect(configured.status).toBe(200);

    const wrongChannel = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "TWORK",
        channelId: "C999",
        messages: [
          {
            ts: "1710000002.000400",
            userId: "U333",
            text: "P1 prepare the deploy checklist before release"
          }
        ]
      }
    });
    expect(wrongChannel.status).toBe(200);
    const wrongChannelBody = await wrongChannel.json();
    expect(wrongChannelBody.collectionFilter.retainedMessages).toBe(0);
    expect(wrongChannelBody.digest.payload.messages).toHaveLength(0);
    expect(wrongChannelBody.digest.payload.candidates).toHaveLength(0);

    const collected = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "TWORK",
        channelId: "C777",
        oldestTs: "1710000001.000000",
        latestTs: "1710000003.000000",
        messages: [
          {
            ts: "1710000000.000400",
            userId: "U333",
            text: "P1 prepare the deploy checklist before release"
          },
          {
            ts: "1710000002.000400",
            userId: "U444",
            text: "P1 prepare the deploy checklist before release"
          },
          {
            ts: "1710000002.000500",
            userId: "U333",
            text: "P1 prepare the deploy checklist before release"
          },
          {
            ts: "1710000004.000400",
            userId: "U333",
            text: "P1 prepare the deploy checklist before release"
          }
        ]
      }
    });
    expect(collected.status).toBe(200);
    const collectedBody = await collected.json();
    expect(collectedBody.collectionFilter).toMatchObject({
      receivedMessages: 4,
      parsedMessages: 4,
      retainedMessages: 1
    });
    expect(collectedBody.digest.payload.messages).toHaveLength(1);
    expect(collectedBody.digest.payload.messages[0].ts).toBe("1710000002.000500");
    expect(collectedBody.digest.payload.candidates).toHaveLength(1);
    expect(collectedBody.digest.payload.candidates[0].ts).toBe("1710000002.000500");
  });

  test("manual Slack digest collection applies explicit scope overrides without persisting them", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const configured = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        workspaces: ["TWORK"],
        channels: ["C777"],
        mentions: ["U333"],
        keywords: ["deploy"]
      }
    });
    expect(configured.status).toBe(200);

    const blockedBySavedScope = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "TWORK",
        channelId: "C999",
        messages: [
          {
            ts: "1710000010.000400",
            userId: "U444",
            text: "P1 prepare the incident checklist before release"
          }
        ]
      }
    });
    expect(blockedBySavedScope.status).toBe(200);
    const blockedBody = await blockedBySavedScope.json();
    expect(blockedBody.collectionScopeSource).toBe("saved");
    expect(blockedBody.collectionFilter.retainedMessages).toBe(0);

    const manualOverride = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "TWORK",
        channelId: "C999",
        collectionScopeOverrides: {
          channels: ["C999"],
          mentions: ["U444"],
          keywords: ["incident"],
          channelThreadScopes: {
            C999: "full_thread_history"
          }
        },
        messages: [
          {
            ts: "1710000010.000400",
            userId: "U444",
            text: "P1 prepare the incident checklist before release"
          },
          {
            ts: "1710000011.000400",
            userId: "U333",
            text: "P1 prepare the deploy checklist before release"
          }
        ]
      }
    });
    expect(manualOverride.status).toBe(200);
    const manualBody = await manualOverride.json();
    expect(manualBody.collectionScopeSource).toBe("manual_override");
    expect(manualBody.collectionScope).toMatchObject({
      workspaces: ["TWORK"],
      channels: ["C999"],
      mentions: ["U444"],
      keywords: ["incident"],
      channelThreadScopes: {
        C999: "full_thread_history"
      }
    });
    expect(manualBody.threadCollectionMode).toBe("full_thread_history");
    expect(manualBody.collectionFilter).toMatchObject({
      receivedMessages: 2,
      parsedMessages: 2,
      retainedMessages: 1
    });
    expect(manualBody.digest.payload.messages[0].ts).toBe("1710000010.000400");

    const persisted = await request(runtime, "/api/settings/slack/collection-scope", { cookie: adminCookie });
    const persistedBody = await persisted.json();
    expect(persistedBody.collectionScope).toMatchObject({
      workspaces: ["TWORK"],
      channels: ["C777"],
      mentions: ["U333"],
      keywords: ["deploy"]
    });
  });

  test("manual Slack digest collection excludes messages outside explicit scope overrides", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const configured = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        workspaces: ["TWORK"],
        channels: ["C777"],
        mentions: ["U333"],
        keywords: ["deploy"]
      }
    });
    expect(configured.status).toBe(200);

    const manualOverride = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "TMANUAL",
        channelId: "CMANUAL",
        collectionScopeOverrides: {
          workspaces: ["TMANUAL"],
          channels: ["CMANUAL"],
          threads: ["1710000100.000100"],
          mentions: ["UMANUAL"],
          keywords: ["manual-review"]
        },
        messages: [
          {
            ts: "1710000100.000200",
            threadTs: "1710000100.000999",
            userId: "UOTHER",
            text: "P1 prepare the unrelated checklist before release"
          },
          {
            ts: "1710000100.000300",
            userId: "UOTHER",
            text: "heads up, this is still only general chatter"
          }
        ]
      }
    });
    expect(manualOverride.status).toBe(200);
    const manualBody = await manualOverride.json();
    expect(manualBody.collectionScopeSource).toBe("manual_override");
    expect(manualBody.collectionScope).toMatchObject({
      workspaces: ["TMANUAL"],
      channels: ["CMANUAL"],
      threads: ["1710000100.000100"],
      mentions: ["UMANUAL"],
      keywords: ["manual-review"]
    });
    expect(manualBody.collectionFilter).toMatchObject({
      receivedMessages: 2,
      parsedMessages: 2,
      retainedMessages: 0
    });
    expect(manualBody.digest.payload.messages).toEqual([]);
    expect(manualBody.digest.payload.candidates).toEqual([]);

    const persisted = await request(runtime, "/api/settings/slack/collection-scope", { cookie: adminCookie });
    const persistedBody = await persisted.json();
    expect(persistedBody.collectionScope).toMatchObject({
      workspaces: ["TWORK"],
      channels: ["C777"],
      mentions: ["U333"],
      keywords: ["deploy"]
    });
  });

  test("scheduled Slack collection targets exclude out-of-scope messages before candidate creation", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const configured = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        workspaces: ["TSCHEDULED"],
        channels: ["CSCHEDULED"],
        threads: ["1710000200.000100"],
        mentions: ["USCHEDULED"],
        keywords: ["scheduled-review"],
        channelThreadScopes: {
          CSCHEDULED: "full_thread_history"
        }
      }
    });
    expect(configured.status).toBe(200);

    const scope = await agentRequest(runtime, agent, "/api/agent/slack/collection-scope");
    expect(scope.status).toBe(200);
    const scopeBody = await scope.json();
    expect(scopeBody.collectionReady).toBe(true);
    expect(scopeBody.targets).toEqual([
      expect.objectContaining({
        workspaceId: "TSCHEDULED",
        channelId: "CSCHEDULED",
        threadCollectionMode: "full_thread_history"
      })
    ]);

    const target = scopeBody.targets[0];
    const scheduledCollect = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: target.workspaceId,
        channelId: target.channelId,
        threadCollectionMode: target.threadCollectionMode,
        messages: [
          {
            ts: "1710000200.000200",
            threadTs: "1710000200.000999",
            userId: "UOTHER",
            text: "P1 prepare the unrelated checklist before release"
          },
          {
            ts: "1710000200.000300",
            userId: "UOTHER",
            text: "please review this ordinary note later"
          }
        ]
      }
    });
    expect(scheduledCollect.status).toBe(200);
    const scheduledBody = await scheduledCollect.json();
    expect(scheduledBody.collectionScopeSource).toBe("saved");
    expect(scheduledBody.threadCollectionMode).toBe("full_thread_history");
    expect(scheduledBody.collectionFilter).toMatchObject({
      receivedMessages: 2,
      parsedMessages: 2,
      retainedMessages: 0
    });
    expect(scheduledBody.digest.payload.messages).toEqual([]);
    expect(scheduledBody.digest.payload.candidates).toEqual([]);
  });

  test("OpenClaw agents can read persisted Slack collection targets for manual and periodic collection", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const defaultScope = await agentRequest(runtime, agent, "/api/agent/slack/collection-scope");
    expect(defaultScope.status).toBe(200);
    const defaultScopeBody = await defaultScope.json();
    expect(defaultScopeBody.collectionReady).toBe(false);
    expect(defaultScopeBody.validation).toMatchObject({
      invalid: {
        channels: ["At least one Slack channel must be configured before collection."]
      },
      hasInvalid: true
    });
    expect(defaultScopeBody.targets).toEqual([]);

    const configured = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        workspaces: ["TWORK"],
        channels: ["CENG", "CPROD"],
        channelThreadScopes: {
          CENG: "parent_messages",
          CPROD: "full_thread_history"
        },
        threads: ["1710000000.000400"],
        mentions: ["U111", "@lead"],
        keywords: ["deploy", "incident"]
      }
    });
    expect(configured.status).toBe(200);

    await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "TWORK",
        channelId: "CENG",
        messages: [{ ts: "1710000000.000400", userId: "U111", text: "P1 prepare deploy checklist" }]
      }
    });
    const committedDigest = runtime.store
      .listSlackWorkspaceConnections()
      .find((workspace) => workspace.workspaceId === "TWORK");
    expect(committedDigest?.channels[0]?.channelId).toBe("CENG");

    const scope = await agentRequest(runtime, agent, "/api/agent/slack/collection-scope");
    expect(scope.status).toBe(200);
    const scopeBody = await scope.json();
    expect(scopeBody.collectionReady).toBe(true);
    expect(scopeBody.validation).toMatchObject({
      saved: {
        workspaces: ["TWORK"],
        channels: ["CENG", "CPROD"],
        threads: ["1710000000.000400"],
        mentions: ["U111", "@lead"],
        keywords: ["deploy", "incident"],
        channelThreadScopes: ["CENG=parent_messages", "CPROD=full_thread_history"]
      },
      hasInvalid: false,
      hasDuplicates: false
    });
    expect(scopeBody.collectionScope).toMatchObject({
      workspaces: ["TWORK"],
      channels: ["CENG", "CPROD"],
      channelThreadScopes: {
        CENG: "parent_messages",
        CPROD: "full_thread_history"
      },
      threads: ["1710000000.000400"],
      mentions: ["U111", "@lead"],
      keywords: ["deploy", "incident"]
    });
    expect(scopeBody.collectionScopeSchema).toMatchObject({
      version: "slack_collection_scope.v1",
      supportedTriggers: ["manual", "scheduled"],
      scheduledTarget: {
        expansion: "workspaces x channels",
        defaultThreadCollectionMode: "active_threads",
        cursorKey: "agentId + channelId"
      }
    });
    expect(scopeBody.targets).toEqual([
      expect.objectContaining({
        workspaceId: "TWORK",
        channelId: "CENG",
        threadCollectionMode: "parent_messages",
        cursor: null
      }),
      expect.objectContaining({
        workspaceId: "TWORK",
        channelId: "CPROD",
        threadCollectionMode: "full_thread_history",
        cursor: null
      })
    ]);
  });

  test("Slack workspace selector options are populated from observed OpenClaw workspace connections", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

    const connected = await agentRequest(runtime, agent, "/api/agent/connect/test", {
      method: "POST",
      body: {
        workspaceId: "TWORK",
        workspaceName: "Work Team",
        channelId: "CENG",
        channelName: "eng"
      }
    });
    expect(connected.status).toBe(200);

    const workspaces = await request(runtime, "/api/settings/slack/workspaces", { cookie: adminCookie });
    expect(workspaces.status).toBe(200);
    const workspaceBody = await workspaces.json();
    expect(workspaceBody.workspaces).toEqual([
      expect.objectContaining({
        workspaceId: "TWORK",
        workspaceName: "Work Team",
        agentId: agent.id,
        agentName: "openclaw",
        channels: [
          expect.objectContaining({
            channelId: "CENG",
            channelName: "eng"
          })
        ],
        status: "connected"
      })
    ]);

    const observedChannel = await agentRequest(runtime, agent, "/api/agent/slack/digest/collect", {
      method: "POST",
      body: {
        workspaceId: "TWORK",
        workspaceName: "Work Team",
        channelId: "CPROD",
        channelName: "prod",
        messages: []
      }
    });
    expect(observedChannel.status).toBe(200);
    const observedWorkspaces = await request(runtime, "/api/settings/slack/workspaces", { cookie: adminCookie });
    const observedWorkspaceBody = await observedWorkspaces.json();
    expect(observedWorkspaceBody.workspaces[0].channels).toHaveLength(2);
    expect(observedWorkspaceBody.workspaces[0].channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelId: "CPROD", channelName: "prod" }),
        expect.objectContaining({ channelId: "CENG", channelName: "eng" })
      ])
    );

    const updated = await request(runtime, "/api/settings/slack/collection-scope", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        workspaces: ["TWORK"]
      }
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.collectionScope.workspaces).toEqual(["TWORK"]);
  });

  test("GitHub settings persist and disabled sync records a skipped run without network", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);

    const updated = await request(runtime, "/api/settings/github", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        enabled: false,
        autoCreateIssues: true,
        labels: ["task-manager"],
        rules: [{ repo: "acme/web", projectLabel: "frontend" }],
        assigneesByOwner: { Alice: "alice-gh" }
      }
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.github.enabled).toBe(false);
    expect(updatedBody.github.autoCreateIssues).toBe(true);
    expect(updatedBody.github.labels).toEqual(["task-manager"]);
    expect(updatedBody.github.rules[0].repo).toBe("acme/web");
    expect(updatedBody.github.assigneesByOwner.Alice).toBe("alice-gh");

    const sync = await request(runtime, "/api/integrations/github/sync", {
      method: "POST",
      cookie: adminCookie,
      body: {}
    });
    expect(sync.status).toBe(200);
    const syncBody = await sync.json();
    expect(syncBody.status).toBe("skipped");
    expect(syncBody.summary.reason).toBe("disabled");
  });

  test("agent-created coding tasks auto-create GitHub issues", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");
    process.env.GITHUB_TOKEN = "gh_test_token";

    await request(runtime, "/api/settings/github", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        enabled: true,
        autoCreateIssues: true,
        labels: ["task-manager"],
        rules: [{ repo: "acme/web", projectLabel: "frontend", codeIndicators: ["retry"] }]
      }
    });

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      });
      return new Response(JSON.stringify({
        number: 42,
        html_url: "https://github.com/acme/web/issues/42",
        state: "open"
      }), { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const proposed = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: {
        context: {
          channelId: "C123",
          threadTs: "1710000000.000900",
          messageTs: "1710000000.000900",
          authorId: "U111",
          messages: [{ userId: "U111", text: "태스크로 만들어줘: implement API retry", ts: "1710000000.000900" }]
        },
        confirmed: true
      }
    });
    expect(proposed.status).toBe(200);
    const proposedBody = await proposed.json();
    expect(proposedBody.task.category).toBe("coding");
    expect(proposedBody.task.githubRef).toBe("acme/web#42");
    expect(proposedBody.githubSync.status).toBe("created");
    expect(calls).toHaveLength(1);
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall!.url).toBe("https://api.github.com/repos/acme/web/issues");
    expect(firstCall!.body.labels).toEqual(["task-manager", "frontend", "category:coding", "priority:P2", "status:confirmed"]);
    expect(String(firstCall!.body.body)).toContain(`Task Manager ID: ${proposedBody.task.id}`);

    const created = await request(runtime, `/api/tasks/${proposedBody.task.id}`, { cookie: adminCookie });
    const createdBody = await created.json();
    const markdown = readFileSync(createdBody.task.markdownPath, "utf8");
    expect(markdown).toContain('category: "coding"');
    expect(markdown).toContain('github_ref: "acme/web#42"');
  });

  test("general tasks are not auto-created as GitHub issues", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    process.env.GITHUB_TOKEN = "gh_test_token";

    await request(runtime, "/api/settings/github", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        enabled: true,
        autoCreateIssues: true,
        rules: [{ repo: "acme/web", codeIndicators: ["api"] }]
      }
    });

    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const created = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: adminCookie,
      body: {
        title: "Prepare stakeholder agenda",
        description: "Collect agenda items for the weekly sync.",
        status: "confirmed",
        category: "general"
      }
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.task.category).toBe("general");
    expect(createdBody.task.githubRef).toBe(null);
    expect(createdBody.githubSync).toMatchObject({ status: "skipped", reason: "not-coding" });
    expect(fetchCount).toBe(0);
  });

  test("GitHub issue webhooks update linked task status", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";

    await request(runtime, "/api/settings/github", {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        enabled: true,
        autoUpdateTaskStatusFromGitHub: true,
        autoCompleteClosedIssues: true
      }
    });

    const created = await request(runtime, "/api/tasks", {
      method: "POST",
      cookie: adminCookie,
      body: {
        title: "Fix webhook status sync",
        description: "Implement GitHub issue webhook status sync.",
        status: "in_progress",
        category: "coding",
        githubRef: "acme/web#7"
      }
    });
    const createdBody = await created.json();
    expect(createdBody.task.status).toBe("in_progress");

    const closedPayload = {
      action: "closed",
      repository: { full_name: "acme/web" },
      issue: {
        number: 7,
        state: "closed",
        html_url: "https://github.com/acme/web/issues/7",
        labels: []
      }
    };
    const closed = await githubWebhook(runtime, closedPayload);
    expect(closed.status).toBe(200);
    const closedBody = await closed.json();
    expect(closedBody.sync.status).toBe("updated");
    expect(closedBody.sync.task.status).toBe("done");

    const reopenedPayload = {
      ...closedPayload,
      action: "reopened",
      issue: { ...closedPayload.issue, state: "open" }
    };
    const reopened = await githubWebhook(runtime, reopenedPayload);
    expect(reopened.status).toBe(200);
    const reopenedBody = await reopened.json();
    expect(reopenedBody.sync.status).toBe("updated");
    expect(reopenedBody.sync.task.status).toBe("in_progress");

    const final = await request(runtime, `/api/tasks/${createdBody.task.id}`, { cookie: adminCookie });
    const finalBody = await final.json();
    expect(finalBody.task.status).toBe("in_progress");
    expect(finalBody.task.githubRef).toBe("acme/web#7");
  });

  test("setup can automatically install plugin files into a local agent workspace", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const workspacePath = mkdtempSync(join(tmpdir(), "tm-agent-workspace-"));
    tempDirs.push(workspacePath);
    mkdirSync(join(workspacePath, "plugins", "task-manager"), { recursive: true });
    writeFileSync(join(workspacePath, "plugins", "task-manager", "task-manager-plugin.ts"), "export {};\n");
    mkdirSync(join(workspacePath, "plugins", "shared"), { recursive: true });
    writeFileSync(join(workspacePath, "plugins", "shared", "task-manager-client.ts"), "export {};\n");

    const response = await request(runtime, "/api/setup/agent/install", {
      method: "POST",
      cookie: adminCookie,
      body: {
        type: "openclaw",
        workspacePath,
        runReload: false,
        regenerateToken: true
      }
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agent.name).toBe("OpenClaw");
    expect(body.install.ok).toBe(true);
    expect(body.install.reload.ran).toBe(false);
    expect(body.install.removedLegacy).toContain(join(workspacePath, "plugins", "task-manager"));
    expect(existsSync(join(workspacePath, "skills", "task-manager", "task-manager-skill.ts"))).toBe(true);
    expect(existsSync(join(workspacePath, "skills", "shared", "task-manager-client.ts"))).toBe(true);
    expect(existsSync(join(workspacePath, "skills", "task-manager", "openclaw-task-manager.json"))).toBe(true);
    expect(existsSync(join(workspacePath, "plugins", "task-manager"))).toBe(false);
    expect(existsSync(join(workspacePath, "plugins", "shared", "task-manager-client.ts"))).toBe(false);

    const env = readFileSync(join(workspacePath, "skills", "task-manager", "task-manager.env"), "utf8");
    expect(env).toContain(`TASK_MANAGER_AGENT_ID=${body.agent.id}`);
    expect(env).toContain(`TASK_MANAGER_API_TOKEN=${body.token}`);
    expect(env).toContain("TASK_MANAGER_SLACK_TASKIFICATION_PATH=/api/agent/task/propose");
    const manifest = JSON.parse(
      readFileSync(join(workspacePath, "skills", "task-manager", "openclaw-task-manager.json"), "utf8")
    );
    expect(manifest.intake.slackTaskification.endpoint).toBe(
      "http://localhost:3011/api/agent/task/propose"
    );
    expect(manifest.intake.slackTaskification.handler).toBe("handleMessage");
    expect(manifest.handlers.scheduledSlackCollection).toBe("runScheduledSlackCollection");
    expect(manifest.schedule.slackCollection).toMatchObject({
      handler: "runScheduledSlackCollection",
      intervalSeconds: 300,
      scopeHandler: "getScheduledSlackCollectionScope",
      commitDigests: true,
      createTasks: true
    });
    expect(manifest.authentication).toEqual({
      type: "bearer",
      tokenEnv: "TASK_MANAGER_API_TOKEN",
      agentIdHeader: "x-agent-id",
      agentIdEnv: "TASK_MANAGER_AGENT_ID"
    });
    expect(JSON.stringify(manifest)).not.toContain(body.token);
    expect(body.connectTest.ok).toBe(true);

    const uninstall = await request(runtime, "/api/setup/agent/uninstall", {
      method: "POST",
      cookie: adminCookie,
      body: {
        type: "openclaw",
        workspacePath,
        runReload: false
      }
    });
    expect(uninstall.status).toBe(200);
    const uninstallBody = await uninstall.json();
    expect(uninstallBody.uninstall.ok).toBe(true);
    expect(uninstallBody.tokenRevoked).toBe(true);
    expect(existsSync(join(workspacePath, "skills", "task-manager"))).toBe(false);
    expect(existsSync(join(workspacePath, "skills", "shared", "task-manager-client.ts"))).toBe(false);

    const oldTokenCheck = await agentRequest(
      runtime,
      { id: body.agent.id, token: body.token },
      "/api/agent/connect/test",
      {
        method: "POST",
        body: { source: "old-token" }
      }
    );
    expect(oldTokenCheck.status).toBe(401);
  });

  test("setup detects workspace from environment when path is omitted", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const workspacePath = mkdtempSync(join(tmpdir(), "tm-openclaw-detected-"));
    tempDirs.push(workspacePath);
    process.env.OPENCLAW_WORKSPACE = workspacePath;

    try {
      const detected = await request(runtime, "/api/setup/agent/workspaces?type=openclaw", {
        cookie: adminCookie
      });
      expect(detected.status).toBe(200);
      const detectedBody = await detected.json();
      expect(detectedBody.selected.path).toBe(workspacePath);

      const response = await request(runtime, "/api/setup/agent/install", {
        method: "POST",
        cookie: adminCookie,
        body: {
          type: "openclaw",
          runReload: false,
          regenerateToken: true
        }
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.install.workspacePath).toBe(workspacePath);
      expect(existsSync(join(workspacePath, "skills", "task-manager", "task-manager.env"))).toBe(true);
    } finally {
      delete process.env.OPENCLAW_WORKSPACE;
    }
  });

  test("setup detects workspace from task-manager environment variable", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const workspacePath = mkdtempSync(join(tmpdir(), "tm-openclaw-mounted-"));
    tempDirs.push(workspacePath);
    process.env.TASK_MANAGER_OPENCLAW_WORKSPACE = workspacePath;

    try {
      const detected = await request(runtime, "/api/setup/agent/workspaces?type=openclaw", {
        cookie: adminCookie
      });
      expect(detected.status).toBe(200);
      const detectedBody = await detected.json();
      expect(detectedBody.selected.path).toBe(workspacePath);
      expect(detectedBody.selected.source).toBe("env");
    } finally {
      delete process.env.TASK_MANAGER_OPENCLAW_WORKSPACE;
    }
  });

  test("GitHub OpenClaw install guide supports pre-server install without secrets", async () => {
    const guide = readFileSync(join(process.cwd(), "docs", "install", "openclaw-agent-install.md"), "utf8");
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "docs", "install", "openclaw-agent-install.manifest.json"), "utf8")
    );

    expect(guide).toContain("before Agent Task Manager is running");
    expect(guide).toContain("npx @jaesong/agent-task-manager setup");
    expect(guide).toContain("Clean Uninstall Flow");
    expect(guide).toContain("/api/setup/agent/uninstall");
    expect(guide).toContain("atm uninstall");
    expect(guide).toContain("gh auth login");
    expect(guide).toContain("cloudflared tunnel login");
    expect(guide).not.toContain("tmagt_");
    expect(manifest.phase).toBe("pre-server");
    expect(manifest.secretPolicy.agentToken).toContain("Do not ask");
    expect(manifest.installCommand).toContain("--bootstrap");
    expect(manifest.uninstall.preferred.apiCalls.some((step: { path?: string }) => step.path === "/api/setup/agent/uninstall")).toBe(true);
    expect(manifest.uninstall.fileOnlyFallback.limitation).toContain("cannot revoke");
    expect(manifest.forbiddenSlackOutputs).toContain("TASK_MANAGER_API_TOKEN");
  });

  test("bootstrap environment creates admin and installs OpenClaw skill idempotently", async () => {
    const runtime = await makeRuntime();
    const workspacePath = mkdtempSync(join(tmpdir(), "tm-openclaw-bootstrap-"));
    tempDirs.push(workspacePath);

    const first = await bootstrapFromEnv(runtime, {
      TASK_MANAGER_BOOTSTRAP: "true",
      TASK_MANAGER_ADMIN_EMAIL: "admin@example.com",
      TASK_MANAGER_ADMIN_PASSWORD: "password123",
      TASK_MANAGER_OPENCLAW_WORKSPACE: workspacePath,
      TASK_MANAGER_OPENCLAW_RUN_RELOAD: "false",
      TASK_MANAGER_SLACK_PERMISSIONS_REVIEWED: "true",
      TASK_MANAGER_PUBLIC_ACCESS_MODE: "remote",
      TASK_MANAGER_PUBLIC_URL: "https://tasks.example.com",
      TASK_MANAGER_CLOUDFLARE_TUNNEL_TOKEN: "cloudflared service install cf_tunnel_token_bootstrap"
    });

    expect(first.ok).toBe(true);
    expect(first.admin.status).toBe("created");
    expect(first.openclaw.status).toBe("installed");
    expect(runtime.store.isSetupLocked()).toBe(true);
    expect(runtime.store.getSetupReviewSettings().slackPermissionsReviewedAt).toBeTruthy();
    expect(runtime.store.getPublicAccessSettings().tunnelTokenPreview).toBe("cf_tunne...trap");

    const envPath = join(workspacePath, "skills", "task-manager", "task-manager.env");
    const env = readEnvFile(envPath);
    expect(env.TASK_MANAGER_AGENT_ID).toBe(first.openclaw.agentId);
    expect(env.TASK_MANAGER_API_TOKEN).toBeTruthy();
    const agentId = env.TASK_MANAGER_AGENT_ID!;
    const agentToken = env.TASK_MANAGER_API_TOKEN!;

    const connect = await agentRequest(
      runtime,
      { id: agentId, token: agentToken },
      "/api/agent/connect/test",
      {
        method: "POST",
        body: { source: "bootstrap" }
      }
    );
    expect(connect.status).toBe(200);

    const second = await bootstrapFromEnv(runtime, {
      TASK_MANAGER_BOOTSTRAP: "true",
      TASK_MANAGER_OPENCLAW_WORKSPACE: workspacePath,
      TASK_MANAGER_OPENCLAW_RUN_RELOAD: "false"
    });
    expect(second.ok).toBe(true);
    expect(second.admin.status).toBe("existing");
    expect(second.openclaw.status).toBe("existing");
    expect(readFileSync(envPath, "utf8")).toBe(
      Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n"
    );
  });
});

async function makeRuntime(overrides: Partial<AppConfig> = {}): Promise<Runtime> {
  const dataDir = mkdtempSync(join(tmpdir(), "tm-core-"));
  tempDirs.push(dataDir);
  const runtime = await createRuntime({ dataDir, publicBaseUrl: "http://localhost:3011", ...overrides });
  runtimes.push(runtime);
  return runtime;
}

async function createAdmin(runtime: Runtime): Promise<string> {
  const response = await request(runtime, "/api/setup/admin", {
    method: "POST",
    body: { email: "admin@example.com", password: "password123" }
  });
  expect(response.status).toBe(201);
  return cookieHeader(response);
}

async function createAgent(runtime: Runtime, cookie: string, type: "openclaw") {
  const response = await request(runtime, "/api/settings/agents", {
    method: "PATCH",
    cookie,
    body: { type, name: type, regenerateToken: true }
  });
  const body = await response.json();
  expect(body.quickStart.env).toContain(`export TASK_MANAGER_AGENT_ID=${body.agent.id}`);
  expect(body.quickStart.env).toContain(`export TASK_MANAGER_API_TOKEN=${body.token}`);
  expect(body.quickStart.smokeTest.join("\n")).toContain("/api/agent/connect/test");
  return { id: body.agent.id as string, token: body.token as string };
}

async function request(
  runtime: Runtime,
  path: string,
  options: { method?: string; cookie?: string; body?: unknown } = {}
): Promise<Response> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return runtime.app.handle(new Request(`http://localhost${path}`, init));
}

function cookieHeader(response: Response): string {
  const raw = response.headers.get("set-cookie");
  if (!raw) throw new Error("Response did not include a session cookie");
  return raw
    .split(/,(?=\s*[^;,]+=)/)
    .map((part) => part.split(";")[0]?.trim())
    .filter((part): part is string => Boolean(part))
    .join("; ");
}

async function agentRequest(
  runtime: Runtime,
  agent: { id: string; token: string },
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const headers = new Headers({
    "x-agent-id": agent.id,
    authorization: `Bearer ${agent.token}`
  });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return runtime.app.handle(new Request(`http://localhost${path}`, init));
}

function inviteTokenFromAction(action: Record<string, unknown>): string {
  const blocks = Array.isArray(action.blocks) ? action.blocks as Array<Record<string, unknown>> : [];
  for (const block of blocks) {
    const elements = Array.isArray(block.elements) ? block.elements as Array<Record<string, unknown>> : [];
    const button = elements.find((element) => typeof element.url === "string");
    if (button?.url) {
      return new URL(String(button.url)).pathname.split("/").filter(Boolean).at(-1) ?? "";
    }
  }
  throw new Error("Invite URL button not found");
}

async function githubWebhook(runtime: Runtime, payload: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(payload);
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return runtime.app.handle(new Request("http://localhost/api/integrations/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "delivery-test",
      "x-github-event": "issues",
      "x-hub-signature-256": signature
    },
    body
  }));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function readEnvFile(path: string): Record<string, string> {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce<Record<string, string>>((env, line) => {
      const index = line.indexOf("=");
      if (index === -1) return env;
      env[line.slice(0, index)] = line.slice(index + 1);
      return env;
    }, {});
}
