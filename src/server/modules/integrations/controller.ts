import { Elysia } from "elysia";
import type { ServerContext } from "../../context";
import { runGitHubSync, summarizeGitHubWebhook, verifyGitHubSignature } from "../../services/github-sync.service";
import { jsonResponse } from "../../shared/utils";

export function integrationsController({ store, requireAdmin }: ServerContext) {
  return new Elysia({ name: "integrations.controller" })
    .post("/api/integrations/github/sync", async ({ request }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const result = await runGitHubSync(store);
      return result.status === "error" ? jsonResponse(result, 502) : result;
    })
    .post("/api/integrations/github/webhook", async ({ request }) => {
      const bodyText = await request.text();
      const secret = process.env.GITHUB_WEBHOOK_SECRET ?? process.env.OPENCLAW_GITHUB_WEBHOOK_SECRET ?? "";
      if (!secret) return jsonResponse({ error: "GitHub webhook secret is not configured" }, 503);
      const signature = request.headers.get("x-hub-signature-256") ?? "";
      if (!verifyGitHubSignature(bodyText, signature, secret)) {
        return jsonResponse({ error: "Invalid GitHub webhook signature" }, 401);
      }

      const event = request.headers.get("x-github-event") ?? "unknown";
      const payload = JSON.parse(bodyText || "{}") as Record<string, unknown>;
      store.recordEvent(null, "github.webhook", {
        event,
        ...summarizeGitHubWebhook(payload)
      });
      const result = await runGitHubSync(store);
      return { ok: true, event, sync: result };
    });
}
