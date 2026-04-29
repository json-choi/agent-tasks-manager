import { createHmac } from "node:crypto";
import type { AppConfig } from "../config/app-config";
import type { TaskStore } from "../repositories/task-store.repository";
import type { AgentSettings, MemberInvitation, OwnerMapping, OutboxItem, SlackAction } from "../shared/types";
import { compactText, newId } from "../shared/utils";

export interface EnqueueMemberInvitationsInput {
  store: TaskStore;
  config: AppConfig;
  ownerIds?: string[];
  resend?: boolean;
  createdByUserId?: string | null;
}

export interface EnqueueMemberInvitationsResult {
  ok: boolean;
  agent: AgentSettings | null;
  invitations: MemberInvitation[];
  outbox: OutboxItem[];
  skipped: Array<{ ownerId: string; reason: string }>;
}

export function enqueueMemberInvitations(input: EnqueueMemberInvitationsInput): EnqueueMemberInvitationsResult {
  const agent = inviteAgent(input.store);
  const result: EnqueueMemberInvitationsResult = {
    ok: Boolean(agent),
    agent,
    invitations: [],
    outbox: [],
    skipped: []
  };
  if (!agent) return result;

  const selectedOwnerIds = input.ownerIds ? new Set(input.ownerIds.filter(Boolean)) : null;
  const owners = input.store
    .listOwners()
    .filter((owner) => owner.active && owner.slackUserId)
    .filter((owner) => !selectedOwnerIds || selectedOwnerIds.has(owner.id));

  for (const owner of owners) {
    if (input.store.hasMemberProfileForOwner(owner.id)) {
      result.skipped.push({ ownerId: owner.id, reason: "member_exists" });
      continue;
    }

    const pending = input.store.getPendingMemberInvitationForOwner(owner.id);
    if (pending && !input.resend) {
      result.skipped.push({ ownerId: owner.id, reason: "pending_invitation" });
      continue;
    }
    if (pending && input.resend) input.store.revokeMemberInvitation(pending.id);

    const invitationId = newId("inv");
    const created = input.store.createMemberInvitation({
      id: invitationId,
      token: memberInvitationToken(input.config, invitationId),
      owner,
      createdByUserId: input.createdByUserId ?? null
    });
    const outbox = input.store.enqueueOutbox(agent.id, "slack.actions", {
      memberInvitationId: created.invitation.id,
      ownerId: owner.id
    });
    result.invitations.push(created.invitation);
    result.outbox.push(outbox);
  }

  return result;
}

export function invitationUrl(config: AppConfig, token: string): string {
  return new URL(`/invite/${encodeURIComponent(token)}`, config.publicBaseUrl).toString();
}

export function memberInvitationToken(config: AppConfig, invitationId: string): string {
  const signature = createHmac("sha256", config.authSecret)
    .update(`member-invitation:${invitationId}`)
    .digest("base64url");
  return `${invitationId}.${signature}`;
}

export function memberInviteAction(owner: OwnerMapping, url: string): SlackAction {
  const name = compactText(owner.ownerName, 72);
  return {
    kind: "dm",
    userId: owner.slackUserId,
    text: `You're invited to create an Agent Task Manager account for ${name}.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Agent Task Manager invitation*\nCreate your account for *${name}* to view and update your assigned tasks.`
        }
      },
      {
        type: "actions",
        block_id: `atm_member_invite_${owner.id}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Create account" },
            style: "primary",
            url,
            action_id: "atm_member_invite_open"
          }
        ]
      }
    ],
    metadata: {
      type: "atm.member_invitation",
      ownerId: owner.id
    }
  };
}

function inviteAgent(store: TaskStore): AgentSettings | null {
  return store.listAgents().find((agent) => agent.status === "connected") ?? store.listAgents()[0] ?? null;
}
