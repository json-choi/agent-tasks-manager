#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
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

switch (command) {
  case "install":
    install(args);
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

function install(argv) {
  const options = parseOptions(argv);
  assertLocalOnly(options);
  const installDir = installPath(options);
  const port = String(option(options, "port", process.env.PORT ?? "3011"));
  const publicBaseUrl = String(option(options, "public-url", process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`));
  const currentEnv = readEnv(installDir);
  const authSecret = String(
    option(options, "auth-secret", process.env.BETTER_AUTH_SECRET ?? currentEnv.BETTER_AUTH_SECRET ?? randomSecret())
  );

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
  console.log(`Run command: atm run --dir ${shellValue(installDir)}`);
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
  atm install [--dir PATH] [--port 3011] [--public-url URL]
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

function assertLocalOnly(options) {
  if (options.mode === undefined || options.mode === "local") return;
  fail("Unsupported --mode value. ATM installs and runs with Bun only.");
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
