import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSettings, AgentType, Diagnostic } from "../shared/types";

export interface AgentInstallInput {
  agent: AgentSettings;
  token: string;
  apiBaseUrl: string;
  workspacePath: string;
  cliPath?: string | null;
  runReload?: boolean;
}

export interface AgentInstallResult {
  ok: boolean;
  type: AgentType;
  workspacePath: string;
  pluginPath: string;
  sharedPath: string;
  envPath: string;
  manifestPath: string;
  copied: string[];
  removedLegacy: string[];
  env: string[];
  reload: {
    ran: boolean;
    ok: boolean;
    command: string[];
    stdout: string;
    stderr: string;
    exitCode: number | null;
  };
  diagnostics: Diagnostic[];
}

export interface AgentUninstallInput {
  type: AgentType;
  workspacePath: string;
  cliPath?: string | null;
  runReload?: boolean;
}

export interface AgentUninstallResult {
  ok: boolean;
  type: AgentType;
  workspacePath: string;
  pluginPath: string;
  sharedPath: string;
  envPath: string;
  manifestPath: string;
  removed: string[];
  removedLegacy: string[];
  retained: string[];
  reload: {
    ran: boolean;
    ok: boolean;
    command: string[];
    stdout: string;
    stderr: string;
    exitCode: number | null;
  };
  diagnostics: Diagnostic[];
}

export interface AgentWorkspaceCandidate {
  path: string;
  source: "saved" | "env" | "common";
  confidence: "high" | "medium" | "low";
  score: number;
  exists: boolean;
  writable: boolean;
  reasons: string[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function detectAgentWorkspaces(
  type: AgentType,
  options: { savedPaths?: Array<string | null>; env?: NodeJS.ProcessEnv } = {}
): AgentWorkspaceCandidate[] {
  const env = options.env ?? process.env;
  const rawCandidates: Array<{ path: string | null | undefined; source: AgentWorkspaceCandidate["source"]; reason: string }> = [];

  for (const savedPath of options.savedPaths ?? []) {
    rawCandidates.push({ path: savedPath, source: "saved", reason: "Previously saved agent workspace." });
  }

  for (const key of envKeysFor(type)) {
    const value = env[key];
    if (!value) continue;
    rawCandidates.push({
      path: key.endsWith("_CONFIG") ? dirname(value) : value,
      source: "env",
      reason: `${key} is set.`
    });
  }

  for (const path of commonWorkspacePaths(type)) {
    rawCandidates.push({ path, source: "common", reason: "Common workspace location." });
  }

  const seen = new Set<string>();
  return rawCandidates
    .map((candidate) => {
      if (!candidate.path) return null;
      const resolved = resolve(candidate.path);
      if (seen.has(resolved)) return null;
      seen.add(resolved);
      return scoreWorkspaceCandidate(type, resolved, candidate.source, candidate.reason);
    })
    .filter((candidate): candidate is AgentWorkspaceCandidate => Boolean(candidate))
    .filter((candidate) => candidate.exists || candidate.source !== "common")
    .sort((a, b) => b.score - a.score);
}

export function bestAgentWorkspace(
  type: AgentType,
  options: { savedPaths?: Array<string | null>; env?: NodeJS.ProcessEnv } = {}
): AgentWorkspaceCandidate | null {
  return (
    detectAgentWorkspaces(type, options).find(
      (candidate) => candidate.exists && candidate.writable && candidate.confidence !== "low"
    ) ?? null
  );
}

export function installAgentPlugin(input: AgentInstallInput): AgentInstallResult {
  const layout = pluginLayout(input.agent.type, input.workspacePath);
  const sourceDir = join(repoRoot, "agent-plugin", input.agent.type);
  const sharedSourceDir = join(repoRoot, "agent-plugin", "shared");

  if (!existsSync(sourceDir)) {
    throw new Error(`Plugin source is missing: ${sourceDir}`);
  }

  if (!existsSync(sharedSourceDir)) {
    throw new Error(`Shared plugin source is missing: ${sharedSourceDir}`);
  }

  mkdirSync(layout.basePath, { recursive: true });
  cpSync(sourceDir, layout.pluginPath, { recursive: true, force: true });
  cpSync(sharedSourceDir, layout.sharedPath, { recursive: true, force: true });
  const removedLegacy = removeLegacyAgentPlugin(input.workspacePath);

  const env = [
    `TASK_MANAGER_API_URL=${input.apiBaseUrl}`,
    `TASK_MANAGER_AGENT_ID=${input.agent.id}`,
    `TASK_MANAGER_API_TOKEN=${input.token}`
  ];
  writeFileSync(layout.envPath, `${env.join("\n")}\n`, { mode: 0o600 });
  writeFileSync(layout.manifestPath, JSON.stringify(openClawIntegrationManifest(input.apiBaseUrl), null, 2) + "\n", {
    mode: 0o600
  });

  const reloadCommand = reloadCommandFor(input.agent.type, input.cliPath, "install");
  const reload = input.runReload === false ? skippedReload(reloadCommand) : runReload(reloadCommand);
  const diagnostics: Diagnostic[] = [
    {
      ok: existsSync(layout.pluginPath),
      label: "Plugin files",
      message: layout.pluginPath
    },
    {
      ok: existsSync(layout.sharedPath),
      label: "Shared client",
      message: layout.sharedPath
    },
    {
      ok: existsSync(layout.envPath),
      label: "Environment file",
      message: layout.envPath
    },
    {
      ok: existsSync(layout.manifestPath),
      label: "OpenClaw integration manifest",
      message: layout.manifestPath
    },
    {
      ok: true,
      label: "Legacy plugin",
      message: removedLegacy.length ? `Removed ${removedLegacy.join(", ")}.` : "No legacy plugin files found."
    },
    {
      ok: true,
      label: "Message route",
      message: "OpenClaw must call task-manager.handleMessage for Slack message events."
    },
    {
      ok: true,
      label: "Interaction route",
      message: "OpenClaw must call task-manager.handleInteraction for Slack block actions."
    },
    {
      ok: true,
      label: "Outbox worker",
      message: "OpenClaw must call task-manager.pollOutbox on a short schedule to deliver DMs and thread updates."
    },
    {
      ok: reload.ran ? reload.ok : true,
      label: "Reload",
      message: reload.ran
        ? reload.ok
          ? "Reload command completed."
          : reload.stderr || reload.stdout || "Reload command failed."
        : "Reload command was skipped."
    }
  ];

  return {
    ok: diagnostics.every((diagnostic) => diagnostic.ok),
    type: input.agent.type,
    workspacePath: input.workspacePath,
    pluginPath: layout.pluginPath,
    sharedPath: layout.sharedPath,
    envPath: layout.envPath,
    manifestPath: layout.manifestPath,
    copied: [layout.pluginPath, layout.sharedPath, layout.manifestPath],
    removedLegacy,
    env,
    reload,
    diagnostics
  };
}

export function uninstallAgentPlugin(input: AgentUninstallInput): AgentUninstallResult {
  const layout = pluginLayout(input.type, input.workspacePath);
  const sharedClientPath = join(layout.sharedPath, "task-manager-client.ts");
  const removed: string[] = [];
  const removedLegacy: string[] = [];
  const retained: string[] = [];

  if (existsSync(layout.pluginPath)) {
    rmSync(layout.pluginPath, { recursive: true, force: true });
    removed.push(layout.pluginPath);
  }

  if (existsSync(sharedClientPath)) {
    rmSync(sharedClientPath, { force: true });
    removed.push(sharedClientPath);
  }

  if (directoryExists(layout.sharedPath)) {
    const remaining = readdirSync(layout.sharedPath);
    if (remaining.length === 0) {
      rmSync(layout.sharedPath, { recursive: true, force: true });
      removed.push(layout.sharedPath);
    } else {
      retained.push(layout.sharedPath);
    }
  }

  const reloadCommand = reloadCommandFor(input.type, input.cliPath, "uninstall");
  const reload = input.runReload === false ? skippedReload(reloadCommand) : runReload(reloadCommand);
  const diagnostics: Diagnostic[] = [
    {
      ok: !existsSync(layout.pluginPath),
      label: "Plugin files",
      message: !existsSync(layout.pluginPath) ? "Removed." : `${layout.pluginPath} still exists.`
    },
    {
      ok: !existsSync(layout.envPath),
      label: "Environment file",
      message: !existsSync(layout.envPath) ? "Removed." : `${layout.envPath} still exists.`
    },
    {
      ok: !existsSync(layout.manifestPath),
      label: "OpenClaw integration manifest",
      message: !existsSync(layout.manifestPath) ? "Removed." : `${layout.manifestPath} still exists.`
    },
    {
      ok: !existsSync(sharedClientPath),
      label: "Shared client",
      message: !existsSync(sharedClientPath) ? "Removed." : `${sharedClientPath} still exists.`
    },
    {
      ok: reload.ran ? reload.ok : true,
      label: "Reload",
      message: reload.ran
        ? reload.ok
          ? "Reload command completed."
          : reload.stderr || reload.stdout || "Reload command failed."
        : "Reload command was skipped."
    }
  ];

  return {
    ok: diagnostics.every((diagnostic) => diagnostic.ok),
    type: input.type,
    workspacePath: input.workspacePath,
    pluginPath: layout.pluginPath,
    sharedPath: layout.sharedPath,
    envPath: layout.envPath,
    manifestPath: layout.manifestPath,
    removed,
    removedLegacy,
    retained,
    reload,
    diagnostics
  };
}

function envKeysFor(type: AgentType): string[] {
  assertOpenClaw(type);
  return [
    "TASK_MANAGER_OPENCLAW_WORKSPACE",
    "OPENCLAW_WORKSPACE",
    "OPENCLAW_HOME",
    "OPENCLAW_AGENT_HOME",
    "OPENCLAW_CONFIG"
  ];
}

function commonWorkspacePaths(type: AgentType): string[] {
  assertOpenClaw(type);
  const home = homedir();
  return [
    join(home, ".openclaw"),
    join(home, ".config", "openclaw"),
    join(home, "openclaw"),
    join(home, "OpenClaw"),
    "/agent-workspaces/openclaw",
    "/agent-workspaces/OpenClaw",
    "/mnt/agent-workspaces/openclaw",
    "/workspaces/openclaw",
    "/opt/openclaw",
    "/srv/openclaw",
    "/var/lib/openclaw",
    "/usr/local/openclaw"
  ];
}

function scoreWorkspaceCandidate(
  type: AgentType,
  path: string,
  source: AgentWorkspaceCandidate["source"],
  initialReason: string
): AgentWorkspaceCandidate {
  const reasons = [initialReason];
  const exists = directoryExists(path);
  const writable = exists ? isWritable(path) : false;
  let score = source === "saved" ? 80 : source === "env" ? 75 : 35;

  if (exists) {
    score += 20;
    reasons.push("Directory exists.");
  }

  if (writable) {
    score += 15;
    reasons.push("Directory is writable.");
  }

  assertOpenClaw(type);
  const pluginParent = join(path, "skills");
  if (directoryExists(pluginParent)) {
    score += 20;
    reasons.push("Contains a skills directory.");
  }

  for (const configName of configNamesFor(type)) {
    if (existsSync(join(path, configName))) {
      score += 10;
      reasons.push(`Contains ${configName}.`);
      break;
    }
  }

  const confidence: AgentWorkspaceCandidate["confidence"] =
    score >= 95 ? "high" : score >= 65 ? "medium" : "low";

  return {
    path,
    source,
    confidence,
    score,
    exists,
    writable,
    reasons
  };
}

function configNamesFor(type: AgentType): string[] {
  assertOpenClaw(type);
  return ["openclaw.yml", "openclaw.yaml", "config.yml", "config.yaml", ".env"];
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function pluginLayout(type: AgentType, workspacePath: string) {
  assertOpenClaw(type);
  const basePath = join(workspacePath, "skills");
  return {
    basePath,
    pluginPath: join(basePath, "task-manager"),
    sharedPath: join(basePath, "shared"),
    envPath: join(basePath, "task-manager", "task-manager.env"),
    manifestPath: join(basePath, "task-manager", "openclaw-task-manager.json")
  };
}

function removeLegacyAgentPlugin(workspacePath: string): string[] {
  const removed: string[] = [];
  const legacyPluginPath = join(workspacePath, "plugins", "task-manager");
  const legacyPluginMarker = join(legacyPluginPath, "task-manager-plugin.ts");
  const legacySharedPath = join(workspacePath, "plugins", "shared");
  const legacySharedClientPath = join(legacySharedPath, "task-manager-client.ts");

  if (existsSync(legacyPluginMarker)) {
    rmSync(legacyPluginPath, { recursive: true, force: true });
    removed.push(legacyPluginPath);
  }

  if (existsSync(legacySharedClientPath)) {
    rmSync(legacySharedClientPath, { force: true });
    removed.push(legacySharedClientPath);
  }

  if (directoryExists(legacySharedPath) && readdirSync(legacySharedPath).length === 0) {
    rmSync(legacySharedPath, { recursive: true, force: true });
    removed.push(legacySharedPath);
  }

  return removed;
}

function reloadCommandFor(
  type: AgentType,
  cliPath?: string | null,
  action: "install" | "uninstall" = "install"
): string[] {
  assertOpenClaw(type);
  const cli = cliPath?.trim() || "openclaw";
  return [cli, "skills", "reload"];
}

function openClawIntegrationManifest(apiBaseUrl: string) {
  return {
    name: "task-manager",
    runtime: "openclaw",
    apiBaseUrl,
    skill: "./task-manager-skill.ts",
    env: "./task-manager.env",
    handlers: {
      slackMessage: "handleMessage",
      slackInteraction: "handleInteraction",
      scheduledOutbox: "pollOutbox"
    },
    requiredSlackCapabilities: [
      "read channel messages",
      "read thread replies",
      "post thread replies",
      "send DMs",
      "receive block action interactions"
    ],
    smokeTests: [
      "connect-test",
      "thread-reply-action",
      "dm-assignment-action",
      "interaction-forwarding",
      "outbox-polling"
    ]
  };
}

function assertOpenClaw(type: AgentType): void {
  if (type !== "openclaw") {
    throw new Error(`Only OpenClaw is supported. Received: ${type}`);
  }
}

function skippedReload(command: string[]) {
  return {
    ran: false,
    ok: true,
    command,
    stdout: "",
    stderr: "",
    exitCode: null
  };
}

function runReload(command: string[]) {
  try {
    const result = Bun.spawnSync(command);
    return {
      ran: true,
      ok: result.exitCode === 0,
      command,
      stdout: new TextDecoder().decode(result.stdout).trim(),
      stderr: new TextDecoder().decode(result.stderr).trim(),
      exitCode: result.exitCode
    };
  } catch (error) {
    return {
      ran: true,
      ok: false,
      command,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Reload command failed.",
      exitCode: null
    };
  }
}
