import { Elysia } from "elysia";
import { adapterFor } from "../../adapters/agent-adapter";
import type { ServerContext } from "../../context";
import type { UpsertAgentInput } from "../../repositories/task-store.repository";
import { buildAgentQuickStart } from "../../services/agent-onboarding.service";
import { asStringMap, parseAgentType, parseChannelMode, parseGitHubRule } from "../../shared/parsers";
import { asRecord, booleanValue, jsonResponse, stringValue } from "../../shared/utils";

export function settingsController({ config, store, requireAdmin }: ServerContext) {
  return new Elysia({ name: "settings.controller" })
    .get("/api/settings/agents", async ({ request }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;
      return {
        agents: store.listAgents(),
        publicBaseUrl: config.publicBaseUrl
      };
    })
    .patch("/api/settings/agents", async ({ request, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const type = parseAgentType(input.type);
      if (!type) return jsonResponse({ error: "Agent type must be hermes or openclaw" }, 400);

      const upsertInput: UpsertAgentInput = { type };
      const id = stringValue(input.id);
      const name = stringValue(input.name);
      const cliPath = stringValue(input.cliPath);
      const configPath = stringValue(input.configPath);
      const workspacePath = stringValue(input.workspacePath);
      const regenerateToken = booleanValue(input.regenerateToken);

      if (id) upsertInput.id = id;
      if (name) upsertInput.name = name;
      if ("cliPath" in input) upsertInput.cliPath = cliPath;
      if ("configPath" in input) upsertInput.configPath = configPath;
      if ("workspacePath" in input) upsertInput.workspacePath = workspacePath;
      if (regenerateToken !== null) upsertInput.regenerateToken = regenerateToken;

      const result = store.upsertAgent(upsertInput);
      const adapter = adapterFor(type);

      return {
        agent: result.agent,
        token: result.token,
        diagnostics: adapter.diagnose(result.agent),
        install: adapter.installInstructions(result.agent, config.publicBaseUrl, result.token),
        quickStart: buildAgentQuickStart(result.agent, config.publicBaseUrl, result.token)
      };
    })
    .get("/api/settings/owners", async ({ request }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;
      return { owners: store.listOwners() };
    })
    .post("/api/settings/owners", async ({ request, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const ownerName = stringValue(input.ownerName);
      if (!ownerName) return jsonResponse({ error: "ownerName is required" }, 400);
      const aliases = Array.isArray(input.aliases)
        ? input.aliases.map((alias) => stringValue(alias)).filter((alias): alias is string => Boolean(alias))
        : stringValue(input.aliases)
          ? stringValue(input.aliases)!.split(",").map((alias) => alias.trim()).filter(Boolean)
          : [];
      const ownerInput = {
        ownerName,
        slackUserId: stringValue(input.slackUserId),
        aliases,
        active: booleanValue(input.active) ?? true
      };
      const ownerId = stringValue(input.id);
      return {
        owner: store.upsertOwner(ownerId ? { ...ownerInput, id: ownerId } : ownerInput)
      };
    })
    .get("/api/settings/github", async ({ request }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;
      return { github: store.getGitHubSettings() };
    })
    .patch("/api/settings/github", async ({ request, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const githubPatch: Partial<ReturnType<typeof store.getGitHubSettings>> = {};
      const enabled = booleanValue(input.enabled);
      const autoCreateIssues = booleanValue(input.autoCreateIssues);
      const autoUpdateTaskStatusFromGitHub = booleanValue(input.autoUpdateTaskStatusFromGitHub);
      const autoCompleteClosedIssues = booleanValue(input.autoCompleteClosedIssues);
      if (enabled !== null) githubPatch.enabled = enabled;
      if (autoCreateIssues !== null) githubPatch.autoCreateIssues = autoCreateIssues;
      if (autoUpdateTaskStatusFromGitHub !== null) {
        githubPatch.autoUpdateTaskStatusFromGitHub = autoUpdateTaskStatusFromGitHub;
      }
      if (autoCompleteClosedIssues !== null) githubPatch.autoCompleteClosedIssues = autoCompleteClosedIssues;
      if (Array.isArray(input.rules)) githubPatch.rules = input.rules.map((rule) => asRecord(rule)).map(parseGitHubRule);
      if (Array.isArray(input.labels)) {
        githubPatch.labels = input.labels.map((label) => stringValue(label)).filter((label): label is string => Boolean(label));
      }
      const assigneesByOwner = asStringMap(input.assigneesByOwner);
      if (assigneesByOwner) githubPatch.assigneesByOwner = assigneesByOwner;
      return {
        github: store.updateGitHubSettings(githubPatch)
      };
    })
    .get("/api/settings/channels", async ({ request }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;
      return {
        defaultMode: "manual_only",
        policies: store.listChannelPolicies()
      };
    })
    .patch("/api/settings/channels", async ({ request, body }) => {
      const auth = await requireAdmin(request);
      if ("response" in auth) return auth.response;

      const input = asRecord(body);
      const channelId = stringValue(input.channelId);
      const mode = parseChannelMode(input.mode);
      if (!channelId || !mode) {
        return jsonResponse({ error: "channelId and mode are required" }, 400);
      }

      return { policy: store.upsertChannelPolicy(channelId, mode) };
    });
}
