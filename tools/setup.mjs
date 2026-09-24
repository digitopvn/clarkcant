#!/usr/bin/env node
/**
 * Interactive onboarding for a ClarkCant node.
 *
 * One script for macOS, Linux and Windows: it runs on the same Node the runtime needs, so there is
 * nothing else to install before it can speak. It checks the machine, asks the few questions a node
 * actually needs answered (how to run it, which model answers, where its data lives), writes `.env`,
 * installs dependencies and prints the exact command that starts the node.
 *
 * Two properties matter more than the prompts:
 *
 * - A value the operator already put in `.env` is kept unless they type a replacement, and the file's
 *   comments and unrelated lines survive. Onboarding twice must not undo configuration.
 * - A secret is never echoed back: not while typed, not in the summary, not in a log line. The summary
 *   says whether a key is set, which is all anyone reading the screen needs.
 *
 * Non-interactive use (CI, a VPS bootstrap) passes `--yes` with flags; see `--help`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout, platform, versions, argv, exit } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE = [22, 19, 0];

/** Providers the onboarding offers, and the variable that holds each one's key. */
export const PROVIDERS = [
  { id: "deepseek", label: "DeepSeek", keyVar: "DEEPSEEK_API_KEY", defaultModel: "deepseek-v4-flash" },
  { id: "google", label: "Google Gemini", keyVar: "GEMINI_API_KEY", defaultModel: "" },
  { id: "openai", label: "OpenAI", keyVar: "OPENAI_API_KEY", defaultModel: "" },
  { id: "openrouter", label: "OpenRouter", keyVar: "OPENROUTER_API_KEY", defaultModel: "" },
  { id: "none", label: "No model for now (scripted recipes and installed capabilities only)", keyVar: "", defaultModel: "" },
];

/** `a.b.c` compared against a minimum, as numbers rather than strings. */
export function meetsVersion(version, minimum) {
  const parts = version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < minimum.length; index += 1) {
    const have = parts[index] ?? 0;
    if (have !== minimum[index]) return have > minimum[index];
  }
  return true;
}

/**
 * Set variables in `.env` content without disturbing anything else in it.
 *
 * A line that assigns the name (commented-out or not) is replaced in place, so the value lands under the
 * comment that explains it; a name the file never mentions is appended. `undefined` leaves a name alone.
 */
export function upsertEnv(content, values) {
  const lines = content.split(/\r?\n/);
  const pending = new Map(Object.entries(values).filter(([, value]) => value !== undefined));
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[index] ?? "");
    const name = match?.[1];
    if (name === undefined || !pending.has(name)) continue;
    // A commented line is only taken over when no live assignment of the same name follows.
    const isComment = /^\s*#/.test(lines[index] ?? "");
    if (isComment && lines.slice(index + 1).some((line) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line))) continue;
    lines[index] = `${name}=${quoteEnv(pending.get(name))}`;
    pending.delete(name);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const [name, value] of pending) lines.push(`${name}=${quoteEnv(value)}`);
  return `${lines.join("\n")}\n`;
}

function quoteEnv(value) {
  return /[\s#"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Live (uncommented, non-empty) values in `.env` content. */
export function readEnv(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null) continue;
    let value = match[2] ?? "";
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted?.[2] !== undefined) value = quoted[2];
    if (value !== "" && !value.startsWith("#")) values[match[1]] = value;
  }
  return values;
}

export function parseFlags(args) {
  const flags = { yes: false, dryRun: false, skipInstall: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--skip-install") flags.skipInstall = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--mode") flags.mode = next();
    else if (arg === "--provider") flags.provider = next();
    else if (arg === "--model") flags.model = next();
    else if (arg === "--data-dir") flags.dataDir = next();
    else if (arg === "--label") flags.label = next();
    else if (arg === "--port") flags.port = next();
    else if (arg === "--domain") flags.domain = next();
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (flags.mode !== undefined && !["local", "docker", "docker-public"].includes(flags.mode)) {
    throw new Error(`--mode must be local, docker or docker-public, not ${flags.mode}`);
  }
  if (flags.provider !== undefined && !PROVIDERS.some((provider) => provider.id === flags.provider)) {
    throw new Error(`--provider must be one of ${PROVIDERS.map((provider) => provider.id).join(", ")}`);
  }
  return flags;
}

const HELP = `ClarkCant onboarding

Usage: node tools/setup.mjs [options]

  --mode <local|docker|docker-public>  how the node runs (default: local)
  --provider <id>                      deepseek, google, openai, openrouter or none
  --model <id>                         model id for the provider
  --data-dir <path>                    where identity, database and blobs live (local mode)
  --label <name>                       the node's display label
  --port <n>                           gateway port (default 8765)
  --domain <host>                      public hostname for docker-public (TLS via Caddy)
  --skip-install                       do not run pnpm install / docker compose build
  --dry-run                            show what would change, write nothing
  -y, --yes                            accept defaults; never prompt

A provider key is read from the environment variable the provider uses (for example
DEEPSEEK_API_KEY) when --yes is given, so it never has to appear on a command line.
`;

const color = (code) => (text) => (stdout.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = color("1");
const dim = color("2");
const green = color("32");
const yellow = color("33");
const red = color("31");

function which(command) {
  const result = spawnSync(platform === "win32" ? "where" : "which", [command], { encoding: "utf8" });
  return result.status === 0;
}

function versionOf(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: platform === "win32" });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
}

function run(command, args, options = {}) {
  process.stdout.write(dim(`$ ${command} ${args.join(" ")}\n`));
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell: platform === "win32", ...options });
  return result.status === 0;
}

function createPrompter(flags) {
  if (flags.yes) {
    return { text: async (_q, fallback = "") => fallback, choose: async (_q, options, index = 0) => options[index], confirm: async (_q, fallback = true) => fallback, secret: async () => "", close() {} };
  }
  /*
   * Lines are queued rather than awaited with `rl.question`, so answers piped in all at once (a script, a
   * test) are consumed one per prompt instead of being dropped while the next prompt is not yet asked.
   */
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  const queued = [];
  const waiting = [];
  let closed = false;
  let muted = false;
  rl.on("line", (line) => (waiting.length > 0 ? waiting.shift()(line) : queued.push(line)));
  rl.on("close", () => {
    closed = true;
    for (const resolveLine of waiting.splice(0)) resolveLine(undefined);
  });
  // Readline echoes typed characters through this method; a secret prompt silences it.
  const writeToOutput = rl._writeToOutput?.bind(rl);
  if (writeToOutput !== undefined) rl._writeToOutput = (text) => (muted ? undefined : writeToOutput(text));
  const line = async (prompt) => {
    stdout.write(prompt);
    const answer = queued.length > 0 ? queued.shift() : closed ? undefined : await new Promise((resolveLine) => waiting.push(resolveLine));
    if (answer === undefined) throw new Error("Input ended before setup finished. Nothing was written.");
    if (!stdin.isTTY) stdout.write("\n");
    return answer.trim();
  };
  return {
    async text(question, fallback = "") {
      const answer = await line(`${question}${fallback ? dim(` [${fallback}]`) : ""}: `);
      return answer === "" ? fallback : answer;
    },
    async choose(question, options, fallbackIndex = 0) {
      if (question) stdout.write(`${question}\n`);
      options.forEach((option, index) => stdout.write(`  ${index + 1}) ${option.label}\n`));
      for (;;) {
        const answer = await line(`Choose 1-${options.length}${dim(` [${fallbackIndex + 1}]`)}: `);
        if (answer === "") return options[fallbackIndex];
        const index = Number.parseInt(answer, 10) - 1;
        if (options[index] !== undefined) return options[index];
        stdout.write(yellow("  Not one of the choices; try again.\n"));
      }
    },
    async confirm(question, fallback = true) {
      const answer = (await line(`${question} ${dim(fallback ? "[Y/n]" : "[y/N]")}: `)).toLowerCase();
      return answer === "" ? fallback : answer.startsWith("y");
    },
    /** A secret: typed characters are not echoed, and an empty answer keeps what is there. */
    async secret(question) {
      muted = stdin.isTTY;
      try {
        return await line(`${question}: `);
      } finally {
        if (muted) stdout.write("\n");
        muted = false;
      }
    },
    close() {
      rl.close();
    },
  };
}

function checkMachine(mode) {
  const checks = [];
  checks.push({
    name: "Node.js",
    ok: meetsVersion(versions.node, MIN_NODE),
    detail: `v${versions.node} (needs ${MIN_NODE.join(".")}+, 24 recommended)`,
    required: true,
  });
  const pnpm = versionOf("pnpm");
  const corepack = which("corepack");
  checks.push({
    name: "pnpm",
    ok: pnpm !== undefined || corepack,
    detail: pnpm !== undefined ? `v${pnpm}` : corepack ? "missing; Corepack can provide it" : "missing, and Corepack is not available",
    required: mode === "local",
  });
  checks.push({ name: "git", ok: which("git"), detail: versionOf("git") ?? "missing", required: false });
  const docker = versionOf("docker");
  const compose = docker === undefined ? undefined : versionOf("docker", ["compose", "version"]);
  checks.push({
    name: "Docker Compose",
    ok: compose !== undefined,
    detail: compose ?? (docker ? "docker found, the compose plugin is missing" : "missing"),
    required: mode !== "local",
  });
  return checks;
}

function printChecks(checks) {
  for (const check of checks) {
    const mark = check.ok ? green("✓") : check.required ? red("✗") : yellow("•");
    stdout.write(`  ${mark} ${check.name.padEnd(15)} ${dim(check.detail)}\n`);
  }
}

async function main() {
  let flags;
  try {
    flags = parseFlags(argv.slice(2));
  } catch (error) {
    stdout.write(`${red(error.message)}\n\n${HELP}`);
    exit(2);
  }
  if (flags.help) {
    stdout.write(HELP);
    return;
  }

  const ask = createPrompter(flags);
  try {
    stdout.write(`\n${bold("ClarkCant setup")} ${dim(`— ${platform}, repository ${ROOT}`)}\n`);
    stdout.write(dim("Nothing is written until the summary step. Ctrl+C leaves everything as it was.\n\n"));

    // Step 1: how the node runs.
    stdout.write(bold("1/5  How should this node run?\n"));
    const modes = [
      { id: "local", label: "On this machine with Node.js (development, a desktop)" },
      { id: "docker", label: "In Docker on this machine (loopback only)" },
      { id: "docker-public", label: "In Docker behind Caddy with automatic HTTPS (a VPS with a domain)" },
    ];
    const mode = flags.mode ?? (await ask.choose("", modes, 0)).id;

    // Step 2: machine check, for the mode chosen.
    stdout.write(`\n${bold("2/5  Checking this machine\n")}`);
    const checks = checkMachine(mode);
    printChecks(checks);
    const blocking = checks.filter((check) => check.required && !check.ok);
    if (blocking.length > 0) {
      stdout.write(`\n${red(`Cannot continue: ${blocking.map((check) => check.name).join(", ")} missing or too old.`)}\n`);
      stdout.write("See docs/installation.md for how to install them on this platform. Nothing was changed.\n");
      exit(1);
    }

    // Step 3: the model.
    const envPath = join(ROOT, ".env");
    const envExists = existsSync(envPath);
    const current = envExists ? readEnv(readFileSync(envPath, "utf8")) : {};
    stdout.write(`\n${bold("3/5  Which model answers conversations?\n")}`);
    if (envExists) stdout.write(dim("  An existing .env was found; its values are the defaults, and Enter keeps them.\n"));
    const currentProvider = PROVIDERS.findIndex((provider) => provider.id === current.CC_MODEL_PROVIDER);
    const provider =
      flags.provider !== undefined
        ? PROVIDERS.find((candidate) => candidate.id === flags.provider)
        : await ask.choose("", PROVIDERS, currentProvider >= 0 ? currentProvider : 0);
    const updates = {};
    if (provider.id === "none") {
      updates.CC_MODEL_PROVIDER = "";
      updates.CC_MODEL_ID = "";
    } else {
      const sameProvider = current.CC_MODEL_PROVIDER === provider.id;
      const modelDefault = flags.model ?? (sameProvider ? current.CC_MODEL_ID : undefined) ?? provider.defaultModel;
      let model = await ask.text(`  Model id for ${provider.label}`, modelDefault ?? "");
      while (model === "" && !flags.yes) {
        stdout.write(yellow("  A provider needs a model; the node will not pick one for you.\n"));
        model = await ask.text(`  Model id for ${provider.label}`);
      }
      if (model === "") throw new Error(`--provider ${provider.id} needs --model`);
      updates.CC_MODEL_PROVIDER = provider.id;
      updates.CC_MODEL_ID = model;
      const hasKey = current[provider.keyVar] !== undefined || process.env[provider.keyVar] !== undefined;
      const typed = await ask.secret(`  ${provider.keyVar}${hasKey ? " (Enter keeps the one already set)" : " (Enter to add it later)"}`);
      if (typed !== "") updates[provider.keyVar] = typed;
      else if (flags.yes && process.env[provider.keyVar] && !current[provider.keyVar]) updates[provider.keyVar] = process.env[provider.keyVar];
    }

    // Step 4: where the node lives.
    stdout.write(`\n${bold("4/5  Node identity and storage\n")}`);
    const label = flags.label ?? (await ask.text("  Label shown for this node", current.CLARKCANT_LABEL ?? "my clark"));
    const port = flags.port ?? (await ask.text("  Gateway port", current.CLARKCANT_PORT ?? "8765"));
    if (!/^\d{2,5}$/.test(port) || Number(port) > 65535) throw new Error(`Port ${port} is not a TCP port`);
    updates.CLARKCANT_LABEL = label;
    updates.CLARKCANT_PORT = port;
    let dataDir;
    if (mode === "local") {
      dataDir = flags.dataDir ?? (await ask.text("  Data directory (identity, database, blobs)", current.CLARKCANT_DATA_DIR ?? "./.data"));
      updates.CLARKCANT_DATA_DIR = dataDir;
    }
    if (mode === "docker-public") {
      const domain = flags.domain ?? (await ask.text("  Public domain that points at this server (for HTTPS)", current.CLARKCANT_DOMAIN ?? ""));
      if (domain === "") throw new Error("docker-public needs a domain whose DNS points at this server");
      updates.CLARKCANT_DOMAIN = domain;
    }

    // Step 5: summary, write, install.
    stdout.write(`\n${bold("5/5  Summary\n")}`);
    const shown = { ...current, ...updates };
    const rows = [
      ["Mode", mode],
      ["Model", provider.id === "none" ? "none (scripted only)" : `${updates.CC_MODEL_PROVIDER} / ${updates.CC_MODEL_ID}`],
      ["API key", provider.keyVar === "" ? "not needed" : shown[provider.keyVar] || process.env[provider.keyVar] ? "set (hidden)" : yellow("not set — the node starts and reports the model unreachable")],
      ["Label", label],
      ["Port", port],
      ...(dataDir ? [["Data dir", dataDir]] : []),
      ...(updates.CLARKCANT_DOMAIN ? [["Domain", updates.CLARKCANT_DOMAIN]] : []),
      [".env", envExists ? "update in place (other lines kept)" : "create from .env.example"],
    ];
    for (const [name, value] of rows) stdout.write(`  ${name.padEnd(9)} ${value}\n`);

    if (flags.dryRun) {
      stdout.write(`\n${yellow("Dry run: nothing written.")}\n`);
      return;
    }
    if (!(await ask.confirm("\nWrite .env and continue?", true))) {
      stdout.write("Stopped. Nothing was written.\n");
      return;
    }

    if (!envExists) copyFileSync(join(ROOT, ".env.example"), envPath);
    writeFileSync(envPath, upsertEnv(readFileSync(envPath, "utf8"), updates));
    // Owner-only, because it now holds a provider key. A no-op on Windows, where ACLs decide.
    if (platform !== "win32") chmodSync(envPath, 0o600);
    stdout.write(`${green("✓")} wrote .env ${dim("(gitignored; never commit it)")}\n`);

    const start = startCommand(mode, { dataDir, label, port });
    if (!flags.skipInstall && (await ask.confirm(mode === "local" ? "Install dependencies now (pnpm install)?" : "Build the Docker image now?", true))) {
      const ok = mode === "local" ? installLocal() : run("docker", ["compose", ...composeFiles(mode), "build"]);
      if (!ok) {
        stdout.write(`\n${red("The install step failed.")} .env was kept. Fix the error above, then run it again: ${bold("pnpm onboard --skip-install")} skips straight to the summary.\n`);
        exit(1);
      }
    }

    stdout.write(`\n${green(bold("Ready."))} Start the node with:\n\n  ${bold(start)}\n\n`);
    if (mode === "local") {
      stdout.write(`Open ${bold(`http://127.0.0.1:${port}`)} once it prints its identity. The bearer token is in ${dataDir}/identity.json.\n`);
    } else if (mode === "docker") {
      stdout.write(`Open ${bold(`http://127.0.0.1:${port}`)}. Read the token with: docker compose exec clarkcant cat /data/identity.json\n`);
    } else {
      stdout.write(`Open ${bold(`https://${updates.CLARKCANT_DOMAIN}`)} once Caddy has issued the certificate (ports 80 and 443 must be open).\n`);
    }
    stdout.write(dim("Guide: docs/installation.md\n"));
  } finally {
    ask.close();
  }
}

function composeFiles(mode) {
  return mode === "docker-public" ? ["-f", "docker-compose.yml", "-f", "docker/compose.public.yml"] : [];
}

function startCommand(mode, { dataDir, label, port }) {
  if (mode !== "local") return ["docker compose", ...composeFiles(mode), "up -d"].join(" ");
  const quote = (value) => (/[\s"']/.test(value) ? `"${value}"` : value);
  return `node apps/runtime/src/main.ts --data-dir ${quote(dataDir)} --label ${quote(label)} --port ${port}`;
}

function installLocal() {
  if (versionOf("pnpm") === undefined && !run("corepack", ["enable"])) {
    stdout.write(yellow("corepack enable failed; on Linux/macOS it may need sudo, on Windows an elevated shell.\n"));
    return false;
  }
  if (!run("pnpm", ["install", "--frozen-lockfile"])) return false;
  // The browser client, so the node serves its own interface at the gateway port.
  return run("pnpm", ["run", "build"]);
}

if (resolve(argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    stdout.write(`\n${red(error instanceof Error ? error.message : String(error))}\n`);
    exit(1);
  });
}
