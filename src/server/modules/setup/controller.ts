import { spawnSync } from "node:child_process";
import { Elysia } from "elysia";
import type { ServerContext } from "../../context";
import { parseAgentType } from "../../shared/parsers";
import type { PublicAccessSettings } from "../../shared/types";
import { buildAgentQuickStart } from "../../services/agent-onboarding.service";
import {
  bestAgentWorkspace,
  detectAgentWorkspaces,
  installAgentPlugin,
  uninstallAgentPlugin
} from "../../services/agent-plugin-installer.service";
import { authCookieHeaders } from "../../services/auth.service";
import type { UpsertAgentInput } from "../../repositories/task-store.repository";
import { asRecord, booleanValue, jsonResponse, stringValue, tokenPreview } from "../../shared/utils";

export function setupController({ auth, config, store, requireAdmin }: ServerContext) {
  return new Elysia({ name: "setup.controller" })
    .get("/api/setup/status", () => ({
      setupLocked: store.isSetupLocked(),
      storage: store.storageHealth(),
      agents: store.listAgents(),
      channelPolicies: store.listChannelPolicies(),
      review: store.getSetupReviewSettings(),
      publicAccess: withDefaultLocalServiceUrl(store.getPublicAccessSettings(), config)
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
    .patch("/api/setup/review", async ({ request, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const slackPermissionsReviewed = booleanValue(input.slackPermissionsReviewed);
      return {
        review: store.updateSetupReviewSettings({
          slackPermissionsReviewedAt: slackPermissionsReviewed === false ? null : new Date().toISOString()
        })
      };
    })
    .post("/api/setup/admin", async ({ body }) => {
      if (store.isSetupLocked()) {
        return jsonResponse({ error: "Setup is already locked" }, 409);
      }

      const input = asRecord(body);
      const email = stringValue(input.email)?.trim();
      const password = stringValue(input.password);

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ error: "A valid admin email is required, for example admin@example.com" }, 400);
      }

      if (!password || password.length < 8) {
        return jsonResponse({ error: "Password must be at least 8 characters" }, 400);
      }

      const response = await auth.auth.api.signUpEmail({
        body: { email, password, name: email },
        asResponse: true
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { message?: string; error?: string; code?: string } | null;
        const message = failure?.message || failure?.error || "Admin creation failed";
        return jsonResponse(
          {
            error: message,
            code: failure?.code
          },
          response.status
        );
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
      if (!type) return jsonResponse({ error: "Agent type must be openclaw" }, 400);

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
      if (!type) return jsonResponse({ error: "Agent type must be openclaw" }, 400);

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
      if (!type) return jsonResponse({ error: "Agent type must be openclaw" }, 400);

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
    .get("/api/setup/public-access", async ({ request }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const publicAccess = withDefaultLocalServiceUrl(store.getPublicAccessSettings(), config);
      return {
        publicAccess,
        guide: buildCloudflareGuide(publicAccess, null),
        diagnostics: diagnoseCloudflared()
      };
    })
    .patch("/api/setup/public-access", async ({ request, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const mode = stringValue(input.mode) === "remote" ? "remote" : "quick";
      const publicUrl = normalizeOptionalUrl(input.publicUrl, "Public URL");
      if (publicUrl instanceof Response) return publicUrl;
      const localServiceUrl = normalizeOptionalUrl(input.localServiceUrl, "Local service URL") ?? defaultLocalServiceUrl(config);
      if (localServiceUrl instanceof Response) return localServiceUrl;
      const tunnelToken = extractCloudflareTunnelToken(stringValue(input.tunnelToken) ?? stringValue(input.installCommand));
      const clearTunnelToken = booleanValue(input.clearTunnelToken) === true;
      const current = withDefaultLocalServiceUrl(store.getPublicAccessSettings(), config);
      const publicAccess = store.updatePublicAccessSettings({
        provider: "cloudflare",
        mode,
        publicUrl,
        localServiceUrl,
        tunnelName: stringValue(input.tunnelName),
        tunnelTokenConfigured: clearTunnelToken ? false : tunnelToken ? true : current.tunnelTokenConfigured,
        tunnelTokenPreview: clearTunnelToken ? null : tunnelToken ? tokenPreview(tunnelToken) : current.tunnelTokenPreview,
        accessProtected: booleanValue(input.accessProtected) ?? current.accessProtected
      });
      const normalized = withDefaultLocalServiceUrl(publicAccess, config);

      return {
        publicAccess: normalized,
        guide: buildCloudflareGuide(normalized, tunnelToken),
        diagnostics: diagnoseCloudflared()
      };
    })
    .post("/api/setup/public-access/test", async ({ request, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const saved = withDefaultLocalServiceUrl(store.getPublicAccessSettings(), config);
      const publicUrl = normalizeOptionalUrl(input.publicUrl, "Public URL") ?? saved.publicUrl;
      if (publicUrl instanceof Response) return publicUrl;
      return testPublicUrl(publicUrl);
    });
}

function defaultLocalServiceUrl(config: ServerContext["config"]): string {
  return `http://localhost:${config.port}`;
}

function withDefaultLocalServiceUrl(
  settings: PublicAccessSettings,
  config: ServerContext["config"]
): PublicAccessSettings {
  const fallback = defaultLocalServiceUrl(config);
  return {
    ...settings,
    localServiceUrl: settings.localServiceUrl || fallback
  };
}

function normalizeOptionalUrl(value: unknown, label: string): string | null | Response {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) {
      return jsonResponse({ error: `${label} must start with http:// or https://` }, 400);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return jsonResponse({ error: `${label} is not a valid URL` }, 400);
  }
}

function extractCloudflareTunnelToken(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const tokenMatch = /(?:^|\s)--token(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(trimmed);
  if (tokenMatch) return (tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[3] ?? "").trim() || null;
  const serviceMatch = /cloudflared(?:\.exe)?\s+service\s+install\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(trimmed);
  if (serviceMatch) return (serviceMatch[1] ?? serviceMatch[2] ?? serviceMatch[3] ?? "").trim() || null;
  return /\s/.test(trimmed) ? null : trimmed;
}

function buildCloudflareGuide(settings: PublicAccessSettings, tunnelToken: string | null) {
  const localServiceUrl = settings.localServiceUrl || "http://localhost:3011";
  return {
    quickTunnelCommand: `cloudflared tunnel --url ${shellQuote(localServiceUrl)}`,
    remoteRunCommand: tunnelToken ? `cloudflared tunnel run --token ${shellQuote(tunnelToken)}` : null,
    serviceInstallCommand: tunnelToken ? `cloudflared service install ${shellQuote(tunnelToken)}` : null,
    windowsServiceInstallCommand: tunnelToken ? `cloudflared.exe service install ${windowsQuote(tunnelToken)}` : null,
    cloudflareServiceUrl: localServiceUrl,
    publicUrl: settings.publicUrl,
    notes: [
      "Use Quick Tunnel only for temporary preview URLs.",
      "For production, create a remotely-managed Cloudflare Tunnel, set the public hostname service URL to the local service URL, then paste the install command or token here.",
      "Protect the hostname with Cloudflare Access before sharing it with the team."
    ]
  };
}

function diagnoseCloudflared() {
  const result = spawnSync("cloudflared", ["--version"], {
    encoding: "utf8",
    timeout: 2000
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    installed: result.status === 0,
    version: result.status === 0 ? output : null,
    message: result.status === 0 ? "cloudflared is available." : "cloudflared was not found on PATH."
  };
}

async function testPublicUrl(publicUrl: string | null) {
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
        error: error instanceof Error ? error.message : "Public access test failed"
      },
      502
    );
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}
