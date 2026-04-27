import { Elysia } from "elysia";
import type { ServerContext } from "../../context";
import { parseAgentType } from "../../shared/parsers";
import { buildAgentQuickStart } from "../../services/agent-onboarding.service";
import {
  bestAgentWorkspace,
  detectAgentWorkspaces,
  installAgentPlugin,
  uninstallAgentPlugin
} from "../../services/agent-plugin-installer.service";
import { authCookieHeaders } from "../../services/auth.service";
import type { UpsertAgentInput } from "../../repositories/task-store.repository";
import { asRecord, booleanValue, jsonResponse, stringValue } from "../../shared/utils";

export function setupController({ auth, config, store, requireAdmin }: ServerContext) {
  return new Elysia({ name: "setup.controller" })
    .get("/api/setup/status", () => ({
      setupLocked: store.isSetupLocked(),
      storage: store.storageHealth(),
      agents: store.listAgents(),
      channelPolicies: store.listChannelPolicies()
    }))
    .post("/api/setup/storage/check", async ({ request }) => {
      if (store.isSetupLocked()) {
        const auth = await requireAdmin(request);
        if ("response" in auth) return auth.response;
      }

      return {
        ok: true,
        storage: store.prepareStorage()
      };
    })
    .post("/api/setup/admin", async ({ body }) => {
      if (store.isSetupLocked()) {
        return jsonResponse({ error: "Setup is already locked" }, 409);
      }

      const input = asRecord(body);
      const email = stringValue(input.email);
      const password = stringValue(input.password);

      if (!email || !email.includes("@")) {
        return jsonResponse({ error: "A valid admin email is required" }, 400);
      }

      if (!password || password.length < 8) {
        return jsonResponse({ error: "Password must be at least 8 characters" }, 400);
      }

      const response = await auth.auth.api.signUpEmail({
        body: { email, password, name: email },
        asResponse: true
      });
      if (!response.ok) {
        return jsonResponse({ error: "Admin creation failed" }, response.status);
      }

      const payload = await response.json() as {
        token?: string;
        user?: { id: string; email: string; name: string; createdAt: string | Date };
      };
      store.recordAudit("admin.created", { email: email.toLowerCase(), provider: "better-auth" });
      store.refreshAppConfig();

      return jsonResponse(
        {
          setupLocked: true,
          admin: payload.user
            ? { id: payload.user.id, email: payload.user.email, name: payload.user.name, createdAt: payload.user.createdAt }
            : null,
          token: payload.token,
          expiresAt: null
        },
        201,
        authCookieHeaders(response)
      );
    })
    .get("/api/setup/agent/workspaces", async ({ request, query }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const type = parseAgentType(query.type);
      if (!type) return jsonResponse({ error: "Agent type must be hermes or openclaw" }, 400);

      const savedPaths = store
        .listAgents()
        .filter((agent) => agent.type === type)
        .map((agent) => agent.workspacePath);
      const candidates = detectAgentWorkspaces(type, { savedPaths });

      return {
        type,
        selected: candidates.find(
          (candidate) => candidate.exists && candidate.writable && candidate.confidence !== "low"
        ) ?? null,
        candidates
      };
    })
    .post("/api/setup/agent/install", async ({ request, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const type = parseAgentType(input.type);
      if (!type) return jsonResponse({ error: "Agent type must be hermes or openclaw" }, 400);

      const savedPaths = store
        .listAgents()
        .filter((agent) => agent.type === type)
        .map((agent) => agent.workspacePath);
      const detectedWorkspace = bestAgentWorkspace(type, { savedPaths });
      const workspacePath = stringValue(input.workspacePath) ?? detectedWorkspace?.path ?? null;
      if (!workspacePath) {
        return jsonResponse(
          {
            error: "Agent workspace path could not be detected",
            candidates: detectAgentWorkspaces(type, { savedPaths })
          },
          400
        );
      }

      const upsertInput: UpsertAgentInput = {
        type,
        regenerateToken: booleanValue(input.regenerateToken) ?? true,
        workspacePath
      };
      const id = stringValue(input.id);
      const name = stringValue(input.name);
      const cliPath = stringValue(input.cliPath);
      const configPath = stringValue(input.configPath);
      if (id) upsertInput.id = id;
      if (name) upsertInput.name = name;
      if ("cliPath" in input) upsertInput.cliPath = cliPath;
      if ("configPath" in input) upsertInput.configPath = configPath;

      const result = store.upsertAgent(upsertInput);
      if (!result.token) {
        return jsonResponse({ error: "A new agent token is required for automatic install" }, 400);
      }

      try {
        const installed = installAgentPlugin({
          agent: result.agent,
          token: result.token,
          apiBaseUrl: config.publicBaseUrl,
          workspacePath,
          cliPath,
          runReload: booleanValue(input.runReload) ?? true
        });

        store.markAgentSeen(result.agent.id);
        store.recordEvent(result.agent.id, "agent.plugin.installed", {
          workspacePath,
          pluginPath: installed.pluginPath,
          sharedPath: installed.sharedPath,
          envPath: installed.envPath,
          reload: installed.reload
        });

        return {
          ok: installed.ok,
          agent: store.getAgent(result.agent.id),
          token: result.token,
          install: installed,
          quickStart: buildAgentQuickStart(result.agent, config.publicBaseUrl, result.token),
          connectTest: {
            ok: Boolean(store.getAgentForAuth(result.agent.id, result.token)),
            serverTime: new Date().toISOString()
          }
        };
      } catch (error) {
        return jsonResponse(
          {
            error: error instanceof Error ? error.message : "Automatic plugin install failed"
          },
          500
        );
      }
    })
    .post("/api/setup/agent/uninstall", async ({ request, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const id = stringValue(input.id);
      const explicitType = parseAgentType(input.type);
      const existing = id ? store.getAgent(id) : null;
      const type = existing?.type ?? explicitType;
      if (!type) return jsonResponse({ error: "Agent type must be hermes or openclaw" }, 400);

      const matchingAgents = store.listAgents().filter((agent) => agent.type === type);
      const targetAgent = existing ?? matchingAgents.at(-1) ?? null;
      const savedPaths = matchingAgents.map((agent) => agent.workspacePath);
      const detectedWorkspace = bestAgentWorkspace(type, { savedPaths });
      const workspacePath =
        stringValue(input.workspacePath) ?? targetAgent?.workspacePath ?? detectedWorkspace?.path ?? null;

      if (!workspacePath) {
        return jsonResponse(
          {
            error: "Agent workspace path could not be detected",
            candidates: detectAgentWorkspaces(type, { savedPaths })
          },
          400
        );
      }

      try {
        const cliPath = stringValue(input.cliPath) ?? targetAgent?.cliPath ?? null;
        const uninstalled = uninstallAgentPlugin({
          type,
          workspacePath,
          cliPath,
          runReload: booleanValue(input.runReload) ?? true
        });
        const agent = targetAgent ? store.revokeAgentToken(targetAgent.id) : null;

        store.recordEvent(targetAgent?.id ?? null, "agent.plugin.uninstalled", {
          workspacePath,
          pluginPath: uninstalled.pluginPath,
          sharedPath: uninstalled.sharedPath,
          envPath: uninstalled.envPath,
          reload: uninstalled.reload,
          tokenRevoked: Boolean(agent)
        });

        return {
          ok: uninstalled.ok,
          agent,
          uninstall: uninstalled,
          tokenRevoked: Boolean(agent)
        };
      } catch (error) {
        return jsonResponse(
          {
            error: error instanceof Error ? error.message : "Automatic plugin uninstall failed"
          },
          500
        );
      }
    })
    .post("/api/setup/cloudflare/test", async ({ request, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const publicUrl = stringValue(input.publicUrl);
      if (!publicUrl) return { ok: true, skipped: true };

      try {
        const healthUrl = new URL("/health", publicUrl);
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
        return {
          ok: response.ok,
          status: response.status,
          url: healthUrl.toString()
        };
      } catch (error) {
        return jsonResponse(
          {
            ok: false,
            error: error instanceof Error ? error.message : "Cloudflare tunnel test failed"
          },
          502
        );
      }
    });
}
