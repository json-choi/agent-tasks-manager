import { Elysia, t } from "elysia";
import type { ServerContext } from "../../context";
import { authCookieHeaders } from "../../services/auth.service";
import type { MemberInvitation } from "../../shared/types";
import { jsonResponse, stringValue } from "../../shared/utils";

export function invitationsController({ auth, store }: ServerContext) {
  return new Elysia({ name: "invitations.controller" })
    .get("/invite/:token", ({ params }) => {
      const invitation = store.getMemberInvitationByToken(params.token);
      return invitationHtmlResponse(invitationPage(params.token, invitation));
    })
    .post("/api/invitations/accept", async ({ body }) => {
      const token = stringValue(body.token);
      const email = stringValue(body.email)?.toLowerCase();
      const password = typeof body.password === "string" ? body.password : null;
      const name = stringValue(body.name);

      if (!token) return jsonResponse({ error: "Invitation token is required" }, 400);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ error: "A valid email is required" }, 400);
      }
      if (!password || password.length < 8) {
        return jsonResponse({ error: "Password must be at least 8 characters" }, 400);
      }

      const invitation = store.getMemberInvitationByToken(token);
      if (!invitation) return jsonResponse({ error: "Invitation not found" }, 404);
      if (invitation.status !== "pending") {
        return jsonResponse({ error: `Invitation is ${invitation.status}` }, 409);
      }

      const owner = store.getOwner(invitation.ownerId);
      if (!owner?.active || owner.slackUserId !== invitation.slackUserId) {
        return jsonResponse({ error: "Invitation owner is no longer active" }, 410);
      }
      if (store.hasMemberProfileForOwner(owner.id)) {
        store.revokeMemberInvitation(invitation.id);
        return jsonResponse({ error: "This Slack member already has an account" }, 409);
      }

      const claimed = store.claimMemberInvitation(invitation.id);
      if (!claimed) {
        const current = store.getMemberInvitation(invitation.id);
        return jsonResponse({ error: current ? `Invitation is ${current.status}` : "Invitation is no longer available" }, 409);
      }
      if (store.hasMemberProfileForOwner(owner.id)) {
        store.revokeMemberInvitation(invitation.id);
        return jsonResponse({ error: "This Slack member already has an account" }, 409);
      }

      const response = await auth.auth.api.signUpEmail({
        body: { email, password, name: name ?? owner.ownerName ?? email },
        asResponse: true
      });
      if (!response.ok) {
        store.releaseMemberInvitationClaim(invitation.id);
        const failure = await response.json().catch(() => null) as { message?: string; error?: string; code?: string } | null;
        return jsonResponse(
          { error: failure?.message || failure?.error || "Account creation failed", code: failure?.code },
          response.status
        );
      }

      const payload = await response.json() as {
        user?: { id: string; email: string; name: string; createdAt: string | Date };
      };
      if (!payload.user) {
        store.releaseMemberInvitationClaim(invitation.id);
        return jsonResponse({ error: "Account creation did not return a user" }, 500);
      }

      let profile: ReturnType<typeof store.createMemberProfile>;
      try {
        profile = store.createMemberProfile(payload.user.id, owner);
      } catch (error) {
        store.releaseMemberInvitationClaim(invitation.id);
        return jsonResponse({ error: error instanceof Error ? error.message : "Member profile creation failed" }, 409);
      }
      const accepted = store.completeMemberInvitation(invitation.id, { userId: payload.user.id, email });

      return jsonResponse(
        {
          user: payload.user,
          role: profile.role,
          owner,
          invitation: accepted,
          expiresAt: null
        },
        201,
        authCookieHeaders(response)
      );
    }, {
      body: t.Object({
        token: t.String(),
        email: t.String(),
        password: t.String(),
        name: t.Optional(t.String())
      })
    });
}

function invitationHtmlResponse(markup: string): Response {
  return new Response(markup, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}

function invitationPage(token: string, invitation: MemberInvitation | null): string {
  const title = "Create your Agent Task Manager account";
  const ownerName = invitation?.ownerName ?? "your workspace";
  const canAccept = invitation?.status === "pending";
  const statusText = invitation
    ? canAccept
      ? `Invitation for ${ownerName}`
      : `This invitation is ${invitation.status}.`
    : "This invitation link is invalid.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7fb; color: #172033; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { width: min(460px, calc(100% - 32px)); background: #fff; border: 1px solid #e5eaf1; border-radius: 8px; padding: 24px; box-shadow: 0 18px 44px rgba(16, 24, 40, 0.08); }
    h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.18; }
    p { color: #667085; line-height: 1.55; }
    form { display: grid; gap: 14px; margin-top: 20px; }
    label { display: grid; gap: 6px; font-weight: 700; font-size: 13px; color: #344054; }
    input { border: 1px solid #d0d5dd; border-radius: 8px; padding: 11px 12px; font: inherit; }
    button { border: 0; border-radius: 8px; background: #2563eb; color: #fff; padding: 12px 14px; font: inherit; font-weight: 800; cursor: pointer; }
    button:disabled { opacity: 0.65; cursor: wait; }
    .result { min-height: 22px; font-size: 13px; color: #667085; }
    .error { color: #b42318; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(statusText)}</p>
    ${canAccept ? `<form id="invite-form">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <label>Email
        <input name="email" type="email" autocomplete="email" required>
      </label>
      <label>Name
        <input name="name" autocomplete="name" value="${escapeHtml(ownerName)}">
      </label>
      <label>Password
        <input name="password" type="password" autocomplete="new-password" minlength="8" required>
      </label>
      <button type="submit">Create account</button>
      <div id="result" class="result" role="status"></div>
    </form>` : `<p class="result error">Ask the workspace owner to send a new invitation.</p>`}
  </main>
  ${canAccept ? `<script>
    const form = document.getElementById("invite-form");
    const result = document.getElementById("result");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      result.className = "result";
      result.textContent = "Creating account...";
      const payload = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await fetch("/api/invitations/accept", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || response.statusText);
        window.location.href = "/dashboard";
      } catch (error) {
        result.className = "result error";
        result.textContent = error instanceof Error ? error.message : "Account creation failed.";
        button.disabled = false;
      }
    });
  </script>` : ""}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
