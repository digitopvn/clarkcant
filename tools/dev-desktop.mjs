#!/usr/bin/env node
/**
 * The desktop app in development: a runtime node, the web client on a Vite dev server, and the Electron shell
 * pointed at both, with hot reload for everything the renderer draws.
 *
 *   pnpm dev:desktop [--data-dir ./.data] [--env-file <path>] [--port 8765] [--web-port 5173]
 *
 * Only the renderer reloads. A change to the shell's main process (`apps/desktop/src/*.mjs`) or to the runtime needs
 * this command started again, because neither is served by Vite.
 *
 * A port that is already taken ends the run rather than being worked around. Whatever holds it may be a server from
 * another checkout serving other code, and a desktop window quietly attached to that is harder to notice than an
 * error that names the port.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { argv, env, exit, execPath } from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

const dataDir = resolve(option("data-dir", join(ROOT, ".data")));
const envFile = option("env-file", undefined);
const nodePort = Number.parseInt(option("port", "8765"), 10);
const webPort = Number.parseInt(option("web-port", "5173"), 10);
const nodeUrl = `http://${HOST}:${nodePort}`;
const webUrl = `http://${HOST}:${webPort}`;

/** Whether something already accepts connections on the port. */
function portTaken(port) {
  return new Promise((settle) => {
    const socket = createConnection({ host: HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      settle(true);
    });
    socket.once("error", () => settle(false));
  });
}

/**
 * Poll a URL until it answers, or give up with the name of what never came up.
 *
 * Three minutes, not one: a cold runtime on a machine busy with a test run took just over sixty seconds, and a limit
 * that stops a healthy stack is worse than one that waits a little long for a broken one.
 */
async function waitFor(url, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((wake) => setTimeout(wake, 300));
  }
  throw new Error(`${label} did not answer on ${url} within ${timeoutMs / 1000}s`);
}

const children = [];

function start(label, command, args, extraEnv = {}, cwd = ROOT) {
  const child = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, stdio: "inherit" });
  children.push(child);
  child.once("exit", (code, signal) => {
    // Any one of the three stopping leaves the others serving a window that no longer works, so all of them stop.
    process.stderr.write(`${label} stopped (${signal ?? `exit ${code}`}); stopping the rest\n`);
    void shutdown(code ?? 0);
  });
  return child;
}

let stopping = false;
/**
 * Stop every child, then exit.
 *
 * Waits for them rather than exiting straight after the signal: an exit that races the children leaves them
 * reparented to launchd with their ports still held, which is exactly the leftover server the port check exists to
 * catch on the next run. A child that ignores SIGTERM for three seconds gets SIGKILL.
 */
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  const running = children.filter((child) => child.exitCode === null && child.signalCode === null);
  const exited = running.map((child) => new Promise((settle) => child.once("exit", settle)));
  for (const child of running) child.kill("SIGTERM");
  const timeout = new Promise((settle) => setTimeout(() => settle("timeout"), 3_000));
  if ((await Promise.race([Promise.all(exited), timeout])) === "timeout") {
    for (const child of running) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

for (const [port, label] of [
  [nodePort, "--port"],
  [webPort, "--web-port"],
]) {
  if (await portTaken(port)) {
    process.stderr.write(
      `Port ${port} is already in use. Stop whatever holds it (lsof -nP -iTCP:${port} -sTCP:LISTEN) or pass ${label} <other>.\n`,
    );
    exit(1);
  }
}

// `--env-file` for a checkout whose `.env` lives elsewhere, a worktree most of all: the runtime only reads `./.env`.
start(
  "runtime node",
  execPath,
  [
    ...(envFile === undefined ? [] : [`--env-file=${resolve(envFile)}`]),
    "apps/runtime/src/main.ts",
    "--data-dir",
    dataDir,
    "--port",
    String(nodePort),
    "--label",
    "dev",
  ],
  // Widget documents load their runtime bundle from the app's origin, which in development is the dev server.
  { CC_APP_ORIGIN: webUrl },
);

// Vite's own entry run by this Node, not through `pnpm exec`: a wrapper in between does not pass SIGTERM on, and the
// dev server outlived every stop.
const vite = join(ROOT, "apps/web/node_modules/vite/bin/vite.js");
start("vite dev server", execPath, [
  vite,
  "--port",
  String(webPort),
  "--strictPort",
  "--host",
  HOST,
], {}, join(ROOT, "apps/web"));

try {
  await Promise.all([waitFor(`${nodeUrl}/health`, "the runtime node"), waitFor(webUrl, "the vite dev server")]);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  await shutdown(1);
}

// The package's default export is the path of the Electron binary this checkout installed.
const electron = createRequire(join(ROOT, "apps/desktop/package.json"))("electron");
start("electron shell", electron, [
  join(ROOT, "apps/desktop"),
  "--dev",
  "--renderer-url",
  `${webUrl}/?gateway=${encodeURIComponent(nodeUrl)}`,
  "--node-url",
  nodeUrl,
  "--data-dir",
  dataDir,
]);
