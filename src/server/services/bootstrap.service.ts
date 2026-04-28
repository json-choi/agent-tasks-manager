import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Runtime } from "../context";
import type { PublicAccessSettings } from "../shared/types";
import { nowIso, tokenPreview } from "../shared/utils";
import {
  bestAgentWorkspace,
  installAgentPlugin
} from "./agent-plugin-installer.service";

export interface BootstrapResult {
  enabled: boolean;
  ok: boolean;
  admin: BootstrapStepResult;
  storage: BootstrapStepResult;
  openclaw: BootstrapStepResult & {
    agentId?: string;
    workspacePath?: string;
    pluginPath?: string;
    envPath?: string;
    tokenPreview?: string;
  };
  publicAccess: BootstrapStepResult;
  review: BootstrapStepResult;
  errors: string[];
}

interface BootstrapStepResult {
  status: "disabled" | "skipped" | "created" | "updated" | "installed" | "existing" | "error";
  message: string;
}

interface BootstrapOptions {
  enabled: boolean;
  strict: boolean;
  adminEmail: string | null;
  adminPassword: string | null;
  openclawWorkspace: string | null;
  openclawCliPath: string | null;
  openclawRunReload: boolean;
  openclawForceInstall: boolean;
  openclawRegenerateToken: boolean | null;
  slackPermissionsReviewed: boolean | null;
  publicAccess: Partial<PublicAccessSettings> & { tunnelToken?: string | null };
}

export async function bootstrapFromEnv(
  runtime: Runtime,
  env: NodeJS.ProcessEnv = process.env
): Promise<BootstrapResult> {
  return bootstrapRuntime(runtime, bootstrapOptionsFromEnv(env));
}

export async function bootstrapRuntime(runtime: Runtime, options: BootstrapOptions): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    enabled: options.enabled,
    ok: true,
    admin: disabledStep(),
    storage: disabledStep(),
    openclaw: disabledStep(),
    publicAccess: disabledStep(),
    review: disabledStep(),
    errors: []
  };

  if (!options.enabled) return result;

  result.storage = runStep(result, () => {
    const storage = runtime.store.prepareStorage();
    return {
      status: storage.ok ? "existing" : "updated",
      message: storage.ok ? "Storage is ready." : `Storage prepared with ${storage.missing.length} missing paths repaired.`
    };
  });

  result.admin = await runAsyncStep(result, () => ensureAdmin(runtime, options));
  result.publicAccess = runStep(result, () => configurePublicAccess(runtime, options));
  result.review = runStep(result, () => configureSetupReview(runtime, options));
  result.openclaw = runStep(result, () => installOpenClaw(runtime, options));

  result.ok = result.errors.length === 0;
  if (!result.ok && options.strict) {
    throw new Error(`Bootstrap failed: ${result.errors.join("; ")}`);
  }

  return result;
}

export function bootstrapOptionsFromEnv(env: NodeJS.ProcessEnv): BootstrapOptions {
  const enabled = envFlag(env.TASK_MANAGER_BOOTSTRAP) || envFlag(env.TASK_MANAGER_BOOTSTRAP_ON_START);
  const tunnelToken = extractCloudflareTunnelToken(
    firstString(env.TASK_MANAGER_CLOUDFLARE_TUNNEL_TOKEN, env.TASK_MANAGER_CLOUDFLARE_INSTALL_COMMAND)
  );
  const publicAccessMode = firstString(env.TASK_MANAGER_PUBLIC_ACCESS_MODE);
  const publicAccess: BootstrapOptions["publicAccess"] = {};

  if (publicAccessMode === "remote" || publicAccessMode === "quick") publicAccess.mode = publicAccessMode;
  if (firstString(env.TASK_MANAGER_PUBLIC_URL)) publicAccess.publicUrl = firstString(env.TASK_MANAGER_PUBLIC_URL);
  if (firstString(env.TASK_MANAGER_LOCAL_SERVICE_URL)) {
    publicAccess.localServiceUrl = firstString(env.TASK_MANAGER_LOCAL_SERVICE_URL)!;
  }
  if (firstString(env.TASK_MANAGER_CLOUDFLARE_TUNNEL_NAME)) {
    publicAccess.tunnelName = firstString(env.TASK_MANAGER_CLOUDFLARE_TUNNEL_NAME);
  }
  if (parseEnvBoolean(env.TASK_MANAGER_PUBLIC_ACCESS_PROTECTED) !== null) {
    publicAccess.accessProtected = parseEnvBoolean(env.TASK_MANAGER_PUBLIC_ACCESS_PROTECTED)!;
  }
  if (tunnelToken) publicAccess.tunnelToken = tunnelToken;

  return {
    enabled,
    strict: envFlag(env.TASK_MANAGER_BOOTSTRAP_STRICT),
    adminEmail: firstString(env.TASK_MANAGER_ADMIN_EMAIL, env.ATM_ADMIN_EMAIL),
    adminPassword: firstString(env.TASK_MANAGER_ADMIN_PASSWORD, env.ATM_ADMIN_PASSWORD),
    openclawWorkspace: firstString(env.TASK_MANAGER_OPENCLAW_WORKSPACE, env.OPENCLAW_WORKSPACE),
    openclawCliPath: firstString(env.TASK_MANAGER_OPENCLAW_CLI, env.OPENCLAW_CLI),
    openclawRunReload: parseEnvBoolean(env.TASK_MANAGER_OPENCLAW_RUN_RELOAD) ?? true,
    openclawForceInstall: envFlag(env.TASK_MANAGER_OPENCLAW_FORCE_INSTALL),
    openclawRegenerateToken: parseEnvBoolean(env.TASK_MANAGER_OPENCLAW_REGENERATE_TOKEN),
    slackPermissionsReviewed: parseEnvBoolean(env.TASK_MANAGER_SLACK_PERMISSIONS_REVIEWED),
    publicAccess
  };
}

function ensureAdmin(runtime: Runtime, options: BootstrapOptions): Promise<BootstrapStepResult> {
  if (runtime.store.isSetupLocked()) {
    return Promise.resolve({ status: "existing", message: "Admin already exists." });
  }

  if (!options.adminEmail || !options.adminPassword) {
    return Promise.resolve({
      status: "skipped",
      message: "TASK_MANAGER_ADMIN_EMAIL and TASK_MANAGER_ADMIN_PASSWORD are required to create the first admin."
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.adminEmail)) {
    return Promise.resolve({ status: "error", message: "TASK_MANAGER_ADMIN_EMAIL must be a valid email address." });
  }

  if (options.adminPassword.length < 8) {
    return Promise.resolve({ status: "error", message: "TASK_MANAGER_ADMIN_PASSWORD must be at least 8 characters." });
  }

  return runtime.auth.auth.api
    .signUpEmail({
      body: { email: options.adminEmail, password: options.adminPassword, name: options.adminEmail },
      asResponse: true
    })
    .then(async (response) => {
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { message?: string; error?: string } | null;
        return {
          status: "error",
          message: failure?.message || failure?.error || `Admin creation failed with status ${response.status}.`
        };
      }

      runtime.store.recordAudit("admin.created", { email: options.adminEmail!.toLowerCase(), provider: "bootstrap" });
      runtime.store.refreshAppConfig();
      return { status: "created", message: "Admin created from bootstrap environment." };
    });
}

function configurePublicAccess(runtime: Runtime, options: BootstrapOptions): BootstrapStepResult {
  const patch = options.publicAccess;
  const hasPatch = Object.keys(patch).length > 0;
  if (!hasPatch) return { status: "skipped", message: "No public access bootstrap values provided." };

  const next: Partial<PublicAccessSettings> = { ...patch };
  next.localServiceUrl = next.localServiceUrl ?? `http://localhost:${runtime.config.port}`;
  if (patch.tunnelToken) {
    next.mode = next.mode ?? "remote";
    next.tunnelTokenConfigured = true;
    next.tunnelTokenPreview = tokenPreview(patch.tunnelToken);
    delete (next as { tunnelToken?: string }).tunnelToken;
  }

  runtime.store.updatePublicAccessSettings(next);
  return { status: "updated", message: "Public access settings updated from bootstrap environment." };
}

function configureSetupReview(runtime: Runtime, options: BootstrapOptions): BootstrapStepResult {
  if (options.slackPermissionsReviewed === null) {
    return { status: "skipped", message: "Slack permission review was not bootstrapped." };
  }

  runtime.store.updateSetupReviewSettings({
    slackPermissionsReviewedAt: options.slackPermissionsReviewed ? nowIso() : null
  });
  return {
    status: "updated",
    message: options.slackPermissionsReviewed
      ? "Slack permission review marked complete."
      : "Slack permission review marked incomplete."
  };
}

function installOpenClaw(
  runtime: Runtime,
  options: BootstrapOptions
): BootstrapResult["openclaw"] {
  const type = "openclaw" as const;
  const savedPaths = runtime.store
    .listAgents()
    .filter((agent) => agent.type === type)
    .map((agent) => agent.workspacePath);
  const detected = bestAgentWorkspace(type, { savedPaths });
  const workspacePath = options.openclawWorkspace ?? detected?.path ?? null;

  if (!workspacePath) {
    return {
      status: "skipped",
      message: "No OpenClaw workspace was provided or detected. Set TASK_MANAGER_OPENCLAW_WORKSPACE."
    };
  }

  const existing = runtime.store.listAgents().find((agent) => agent.type === type && agent.workspacePath === workspacePath)
    ?? runtime.store.listAgents().find((agent) => agent.type === type)
    ?? null;
  const envPath = join(workspacePath, "skills", "task-manager", "task-manager.env");
  const pluginPath = join(workspacePath, "skills", "task-manager");
  const canSkip = Boolean(existing?.apiTokenPreview) && existsSync(envPath) && !options.openclawForceInstall;
  if (canSkip) {
    const existingResult: BootstrapResult["openclaw"] = {
      status: "existing",
      message: "OpenClaw Task Manager skill is already installed.",
      agentId: existing!.id,
      workspacePath,
      pluginPath,
      envPath
    };
    if (existing!.apiTokenPreview) existingResult.tokenPreview = existing!.apiTokenPreview;
    return existingResult;
  }

  const shouldRegenerateToken = options.openclawRegenerateToken ?? true;
  const upsertInput = {
    type,
    name: existing?.name ?? "OpenClaw",
    cliPath: options.openclawCliPath ?? existing?.cliPath ?? null,
    workspacePath,
    regenerateToken: !existing || shouldRegenerateToken || options.openclawForceInstall
  };
  const upsert = runtime.store.upsertAgent(existing ? { ...upsertInput, id: existing.id } : upsertInput);

  if (!upsert.token) {
    return {
      status: "error",
      message: "OpenClaw install needs a fresh agent token. Set TASK_MANAGER_OPENCLAW_REGENERATE_TOKEN=true."
    };
  }

  const installed = installAgentPlugin({
    agent: upsert.agent,
    token: upsert.token,
    apiBaseUrl: runtime.config.publicBaseUrl,
    workspacePath,
    cliPath: options.openclawCliPath ?? upsert.agent.cliPath,
    runReload: options.openclawRunReload
  });

  runtime.store.markAgentSeen(upsert.agent.id);
  runtime.store.recordEvent(upsert.agent.id, "agent.plugin.installed", {
    workspacePath,
    pluginPath: installed.pluginPath,
    sharedPath: installed.sharedPath,
    envPath: installed.envPath,
    reload: installed.reload,
    source: "bootstrap"
  });

  return {
    status: installed.ok ? "installed" : "error",
    message: installed.ok
      ? "OpenClaw Task Manager skill installed from bootstrap environment."
      : installed.diagnostics.filter((diagnostic) => !diagnostic.ok).map((diagnostic) => diagnostic.message).join("; "),
    agentId: upsert.agent.id,
    workspacePath,
    pluginPath: installed.pluginPath,
    envPath: installed.envPath,
    tokenPreview: tokenPreview(upsert.token)
  };
}

function runStep<T extends BootstrapStepResult>(result: BootstrapResult, action: () => T): T {
  try {
    const step = action();
    if (step.status === "error") result.errors.push(step.message);
    return step;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bootstrap step failed.";
    result.errors.push(message);
    return { status: "error", message } as T;
  }
}

async function runAsyncStep<T extends BootstrapStepResult>(
  result: BootstrapResult,
  action: () => Promise<T>
): Promise<T> {
  try {
    const step = await action();
    if (step.status === "error") result.errors.push(step.message);
    return step;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bootstrap step failed.";
    result.errors.push(message);
    return { status: "error", message } as T;
  }
}

function disabledStep(): BootstrapStepResult {
  return { status: "disabled", message: "Bootstrap is disabled." };
}

function envFlag(value: string | undefined): boolean {
  return parseEnvBoolean(value) === true;
}

function parseEnvBoolean(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function firstString(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function extractCloudflareTunnelToken(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const tokenMatch = /(?:^|\s)--token(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(trimmed);
  if (tokenMatch) return (tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[3] ?? "").trim() || null;
  const serviceMatch = /cloudflared(?:\.exe)?\s+service\s+install\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(trimmed);
  if (serviceMatch) return (serviceMatch[1] ?? serviceMatch[2] ?? serviceMatch[3] ?? "").trim() || null;
  return trimmed;
}
