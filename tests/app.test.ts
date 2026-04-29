import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyTaskCommand } from "../agent-plugin/shared/task-manager-client";
import { createRuntime } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import { bootstrapFromEnv } from "../src/server/services/bootstrap.service";

const runtimes: Runtime[] = [];
const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalGitHubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

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

  test("agent token flow proposes once per Slack thread and processes assignment/status", async () => {
    const runtime = await makeRuntime();
    const adminCookie = await createAdmin(runtime);
    const agent = await createAgent(runtime, adminCookie, "openclaw");

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

    const duplicate = await agentRequest(runtime, agent, "/api/agent/task/propose", {
      method: "POST",
      body: { context }
    });
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.duplicate).toBe(true);
    expect(duplicateBody.task.id).toBe(proposedBody.task.id);

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
    expect(committedBody.cursor.lastTs).toBe("1710000001.000400");
    expect(committedBody.actions[0].kind).toBe("thread_reply");

    const afterCommit = await request(runtime, "/api/tasks", { cookie: adminCookie });
    const afterCommitBody = await afterCommit.json();
    expect(afterCommitBody.tasks).toHaveLength(1);
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

async function makeRuntime(): Promise<Runtime> {
  const dataDir = mkdtempSync(join(tmpdir(), "tm-core-"));
  tempDirs.push(dataDir);
  const runtime = await createRuntime({ dataDir, publicBaseUrl: "http://localhost:3011" });
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
