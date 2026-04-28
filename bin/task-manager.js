#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultInstallDir = path.join(homedir(), ".agent-tasks-manager");
const projectEntries = [
  "agent-plugin",
  "assets",
  "bin",
  "docs",
  "public",
  "src",
  "LICENSE",
  "README.md",
  "bun.lock",
  "install.sh",
  "package.json",
  "tsconfig.json"
];

const [command = "help", ...args] = process.argv.slice(2);

await main(command, args);

async function main(command, args) {
  switch (command) {
    case "setup":
      await setup(args);
      break;
    case "install":
      await install(args);
      break;
    case "start":
      start(args);
      break;
    case "run":
      runStack(args);
      break;
    case "worker":
      worker(args);
      break;
    case "stop":
      stop(args);
      break;
    case "uninstall":
      uninstall(args);
      break;
    case "doctor":
      doctor(args);
      break;
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      fail(`Unknown command: ${command}`);
  }
}

async function setup(argv) {
  const installConfig = await buildInstallConfig(parseOptions(argv));
  await ensurePortAvailable(installConfig.port);
  installProject(installConfig, { printRunCommand: false });

  console.log("Starting ATM...");
  const { stopAll } = startStackProcesses(installConfig.installDir);
  try {
    await waitForReady(installConfig.localBaseUrl);
  } catch (error) {
    stopAll("SIGTERM");
    fail(error instanceof Error ? error.message : "ATM did not become ready.");
  }

  const setupUrl = new URL("/setup", installConfig.publicBaseUrl).toString();
  console.log(`ATM is ready: ${setupUrl}`);
  if (installConfig.open) openUrl(setupUrl);
  console.log("Press Ctrl-C to stop ATM.");
}

async function install(argv) {
  const installConfig = await buildInstallConfig(parseOptions(argv));
  installProject(installConfig, { printRunCommand: true });
}

async function buildInstallConfig(options) {
  assertLocalOnly(options);
  const installDir = installPath(options);
  const port = await resolvePort(String(option(options, "port", process.env.PORT ?? "3011")));
  const localBaseUrl = `http://localhost:${port}`;
  const publicBaseUrl = String(option(options, "public-url", process.env.PUBLIC_BASE_URL ?? localBaseUrl));
  const currentEnv = readEnv(installDir);
  const authSecret = String(
    option(options, "auth-secret", process.env.BETTER_AUTH_SECRET ?? currentEnv.BETTER_AUTH_SECRET ?? randomSecret())
  );

  return {
    authSecret,
    installDir,
    localBaseUrl,
    open: flagEnabled(options, "open"),
    port,
    publicBaseUrl
  };
}

function installProject(config, { printRunCommand }) {
  const { authSecret, installDir, port, publicBaseUrl } = config;
  copyProject(installDir);
  writeEnv(installDir, {
    DATA_DIR: path.join(installDir, "data"),
    PORT: port,
    PUBLIC_BASE_URL: publicBaseUrl,
    BETTER_AUTH_SECRET: authSecret
  });

  requireCommand("bun", "Bun is required to install ATM.");
  run("bun", ["install"], { cwd: installDir });
  run("bun", ["run", "build"], { cwd: installDir });

  console.log(`ATM installed in ${installDir}`);
  console.log(`Setup URL: ${publicBaseUrl}/setup`);
  if (printRunCommand) console.log(`Run command: atm run --dir ${shellValue(installDir)}`);
}

function start(argv) {
  const options = parseOptions(argv);
  assertLocalOnly(options);
  const installDir = installPath(options);

  requireCommand("bun", "Bun is required to start ATM.");
  const env = { ...process.env, ...readEnv(installDir) };
  run("bun", ["src/server/index.ts"], { cwd: installDir, env });
}

function runStack(argv) {
  const options = parseOptions(argv);
  assertLocalOnly(options);
  const installDir = installPath(options);

  startStackProcesses(installDir);
}

function startStackProcesses(installDir) {
  requireCommand("bun", "Bun is required to run ATM.");
  const env = { ...process.env, ...readEnv(installDir) };
  const children = [
    spawn("bun", ["src/server/index.ts"], { cwd: installDir, env, stdio: "inherit" }),
    spawn("bun", ["src/worker/index.ts"], { cwd: installDir, env, stdio: "inherit" })
  ];
  let stopping = false;

  const stopAll = (signal) => {
    stopping = true;
    for (const child of children) {
      if (!child.killed) child.kill(signal);
    }
  };

  process.on("SIGINT", () => stopAll("SIGINT"));
  process.on("SIGTERM", () => stopAll("SIGTERM"));

  for (const child of children) {
    child.on("exit", (code) => {
      if (stopping) return;
      stopAll("SIGTERM");
      process.exit(code ?? 1);
    });
  }

  return { children, stopAll };
}

function worker(argv) {
  const options = parseOptions(argv);
  assertLocalOnly(options);
  const installDir = installPath(options);
  requireCommand("bun", "Bun is required to run the ATM worker.");
  const env = { ...process.env, ...readEnv(installDir) };
  run("bun", ["src/worker/index.ts"], { cwd: installDir, env });
}

function stop(argv) {
  const options = parseOptions(argv);
  assertLocalOnly(options);
  console.log("ATM runs in the foreground. Stop it with Ctrl-C in the terminal that started it.");
}

function uninstall(argv) {
  const options = parseOptions(argv);
  assertLocalOnly(options);
  const installDir = installPath(options);
  const removeData = Boolean(options["remove-data"]);

  if (removeData) {
    rmSync(installDir, { recursive: true, force: true });
    console.log(`Removed ${installDir}`);
    return;
  }

  console.log(`Stopped ATM. Data and install files are preserved in ${installDir}.`);
  console.log("Run with --remove-data to remove the install directory.");
}

function doctor(argv) {
  const options = parseOptions(argv);
  assertLocalOnly(options);
  const installDir = installPath(options);
  const checks = [
    ["install_dir", existsSync(installDir), installDir],
    ["bun", commandOk("bun", ["--version"]), "required to install and run ATM"]
  ];

  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "ok" : "missing"} ${name} ${detail}`);
  }
}

function help() {
  console.log(`ATM · Agent Tasks Manager

Usage:
  atm setup   [--dir PATH] [--port 3011|auto] [--public-url URL] [--open]
  atm install [--dir PATH] [--port 3011|auto] [--public-url URL]
  atm start   [--dir PATH]
  atm run     [--dir PATH]
  atm worker  [--dir PATH]
  atm stop    [--dir PATH]
  atm uninstall [--dir PATH] [--remove-data]
  atm doctor [--dir PATH]

Defaults:
  --dir  ${defaultInstallDir}
`);
}

function copyProject(installDir) {
  const target = path.resolve(installDir);
  if (target.startsWith(`${packageDir}${path.sep}`)) {
    fail(`Choose an install directory outside the package directory: ${packageDir}`);
  }

  mkdirSync(target, { recursive: true });
  mkdirSync(path.join(target, "data"), { recursive: true });

  if (target === packageDir) return;

  for (const entry of projectEntries) {
    const source = path.join(packageDir, entry);
    if (!existsSync(source)) continue;
    cpSync(source, path.join(target, entry), {
      recursive: true,
      force: true,
      filter: (sourcePath) => {
        const relative = path.relative(packageDir, sourcePath);
        return !relative.startsWith("node_modules") && !relative.startsWith("data");
      }
    });
  }
}

function writeEnv(installDir, patch) {
  const envPath = path.join(installDir, ".env");
  const current = readEnv(installDir);
  const next = { ...current, ...patch };
  const body = Object.entries(next)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${envValue(value)}`)
    .join("\n");
  writeFileSync(envPath, `${body}\n`);
}

function randomSecret() {
  return randomBytes(32).toString("hex");
}

function readEnv(installDir) {
  const envPath = path.join(installDir, ".env");
  if (!existsSync(envPath)) return {};
  const entries = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      if (index === -1) return null;
      const key = line.slice(0, index).trim();
      const raw = line.slice(index + 1).trim();
      return [key, raw.replace(/^"(.*)"$/, "$1")];
    })
    .filter(Boolean);
  return Object.fromEntries(entries);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equals = withoutPrefix.indexOf("=");
    if (equals !== -1) {
      options[withoutPrefix.slice(0, equals)] = withoutPrefix.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[withoutPrefix] = true;
    } else {
      options[withoutPrefix] = next;
      index += 1;
    }
  }
  return options;
}

function installPath(options) {
  return path.resolve(String(option(options, "dir", process.env.TASK_MANAGER_DIR ?? defaultInstallDir)));
}

function option(options, key, fallback) {
  return options[key] === undefined ? fallback : options[key];
}

function flagEnabled(options, key) {
  return options[key] !== undefined && options[key] !== false && options[key] !== "false";
}

function assertLocalOnly(options) {
  if (options.mode === undefined || options.mode === "local") return;
  fail("Unsupported --mode value. ATM installs and runs with Bun only.");
}

async function resolvePort(rawPort) {
  if (rawPort === "auto") {
    for (let port = 3011; port <= 3099; port += 1) {
      if (await isPortAvailable(port)) return String(port);
    }
    fail("No available port found between 3011 and 3099.");
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail("--port must be a number between 1 and 65535, or auto.");
  }
  return String(port);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        server.close(() => resolve(true));
      });
    server.listen(port, "127.0.0.1");
  });
}

async function ensurePortAvailable(port) {
  if (await isPortAvailable(Number(port))) return;
  fail(`Port ${port} is already in use. Use --port auto or choose another --port.`);
}

async function waitForReady(publicBaseUrl) {
  const readyUrl = new URL("/ready", publicBaseUrl).toString();
  const deadline = Date.now() + 30000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const status = await requestStatus(readyUrl);
      if (status === 200) return;
      lastError = `status ${status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request failed";
    }
    await sleep(500);
  }

  throw new Error(`ATM did not become ready at ${readyUrl} (${lastError}).`);
}

function requestStatus(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(parsed, { method: "GET", timeout: 1000 }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });

    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openUrl(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", (error) => {
      const message = error instanceof Error ? error.message : "open failed";
      console.warn(`Could not open browser automatically: ${message}`);
    });
    child.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : "open failed";
    console.warn(`Could not open browser automatically: ${message}`);
  }
}

function requireCommand(name, message) {
  if (!commandOk(name, ["--version"])) fail(message);
}

function commandOk(name, args) {
  const result = spawnSync(name, args, { stdio: "ignore" });
  return result.status === 0;
}

function run(cmd, args, options = {}) {
  console.log(`$ ${cmd} ${args.map(shellValue).join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function envValue(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:-]+$/.test(text) ? text : JSON.stringify(text);
}

function shellValue(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:-]+$/.test(text) ? text : JSON.stringify(text);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
