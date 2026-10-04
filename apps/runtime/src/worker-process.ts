import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunRecord } from "@clarkcant/contracts";
import type { WorkerBriefEnvelope, WrittenFile } from "@clarkcant/app-worker";
import { BUILTIN_PROFILES, buildEnvironment, type ExecutionProfile } from "@clarkcant/execution-supervisor";

import { stopTree } from "./process-tree.ts";

/**
 * The environment profile a worker child runs under.
 *
 * `build` is the narrowest builtin profile that still lets the worker's own tools shell out to `git`
 * and read the filesystem (`PATH`, `HOME`, `LANG`, `TZ`, `CI`): no provider key, no SSH agent socket,
 * no cloud credential. Indexed once here, typed, rather than at every call site — `BUILTIN_PROFILES`
 * is keyed by string, and TypeScript cannot know the literal `"build"` is always present in it.
 */
const WORKER_ENV_PROFILE: ExecutionProfile = BUILTIN_PROFILES.build as ExecutionProfile;

/**
 * Starting a worker as a process.
 *
 * Background work runs in `apps/worker`, which owns one session per run and returns a record of what
 * it saw. The distinction that worker keeps — it never marks its own task succeeded — only holds if
 * the caller keeps it too, so this returns the record and nothing else. Deciding what the evidence
 * means for the task belongs to `@clarkcant/core`, not here.
 *
 * The brief travels as a file rather than as an argument: it carries a goal and a list of roots, and
 * a command line is a public thing on a shared machine.
 *
 * The exit code is part of the contract, not an accident. Exit 2 means the worker itself could not
 * run, which is this function's error. Exit 0 with a `not-verified` record means the worker ran and
 * demonstrated nothing, which is a result the caller has to judge — reporting an honest non-result
 * is a successful run of the worker, not a failure of it.
 */

/**
 * What a worker running a real model needs from the environment besides the `build` profile, on Windows only: the
 * system and profile directories without which Node cannot resolve a host, seed its random source, or find the home
 * directory the model runtime's configuration lives under. Directory names, not credentials.
 */
const WINDOWS_RUNTIME_VARIABLES: readonly string[] = [
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
];

/** Where the model runtime reads its provider and model configuration, named the way the Pi SDK reads it. */
export const MODEL_CONFIG_DIR_VARIABLE = "PI_CODING_AGENT_DIR";

/**
 * The environment a worker child starts with.
 *
 * The `build` profile, and for a real model the Windows directories it cannot run without and the directory its
 * provider configuration lives in. Never the provider key: that goes over stdin, so nothing the worker starts can
 * inherit it.
 */
export function workerEnvironment(
  adapter: "fake" | "real",
  agentDir: string | undefined,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = buildEnvironment(WORKER_ENV_PROFILE, source);
  if (adapter !== "real") return env;
  if (process.platform === "win32") {
    for (const name of WINDOWS_RUNTIME_VARIABLES) {
      const value = source[name];
      if (value !== undefined) env[name] = value;
    }
  }
  if (agentDir !== undefined) env[MODEL_CONFIG_DIR_VARIABLE] = agentDir;
  return env;
}

export interface WorkerProcessOptions {
  /** The worker's entry point. Defaults to the sibling app in this repository. */
  workerEntry?: string;
  nodeId: string;
  brief: WorkerBriefEnvelope;
  /** `fake` proves the wiring without a provider; `real` needs a model on the brief. */
  adapter?: "fake" | "real";
  /**
   * The provider key for the brief's model, with `adapter: "real"`.
   *
   * Written once to the child's stdin and the pipe closed: not an argument, which any process on the machine can list;
   * not the child's environment, which everything the worker starts would inherit; not a file, which outlives the run.
   * Absent leaves the worker to the model runtime's own configuration under `agentDir`.
   */
  credential?: string;
  /** The model runtime's configuration directory for a real model, when this node was given one. */
  agentDir?: string;
  /** Ceiling for the whole process, so a wedged worker cannot hold a run open forever. */
  timeoutMs?: number;
  /**
   * Ceiling on combined stdout+stderr bytes, so a worker that floods its own pipes cannot hold a run
   * open through sheer volume. Defaults to the `build` execution profile's ceiling — generous enough
   * for a worker's transcript and JSON record, and still bounded. Exceeding it kills the child.
   */
  maxOutputBytes?: number;
  /** Injected so a test can drive a different entry point. */
  spawnImpl?: typeof spawn;
  /** Where the worker writes its transcript. Unset leaves the session in memory. */
  dataDir?: string;
  /**
   * Path to a `ScriptedTurn[]` JSON file for the fake adapter (`@clarkcant/pi-adapter`'s `fake.ts`).
   * Ignored with `--adapter real`. Exists so a test can prove a real worker child process, not a fake
   * one substituted for `runWorker`, actually calls a registered tool and produces evidence.
   */
  scriptPath?: string;
  /**
   * Handed the live child the moment it is spawned, so a caller that dispatches tasks can track and
   * kill it later — `/stop` has no other way to reach a worker this function already returned control
   * of internally. Never used to read output: stdout and stderr are only available through the result.
   */
  onChild?: (child: ChildProcess) => void;
  /**
   * Where the worker's `run_command` requests are answered, when this run may run commands.
   *
   * Present means the child gets an IPC channel and nothing else changes: the worker never runs a command itself, it
   * sends the request here and reads the reply. Absent means no channel, and the worker offers no command tool at all.
   */
  onCommand?: (request: unknown) => Promise<unknown>;
  /**
   * Where the worker's `use_browser` requests are answered, when this run may use the browser.
   *
   * The same channel as commands: present opens it, and the host drives the browser for the worker. A kind of request
   * the host was given no answerer for is refused over the channel rather than left waiting.
   */
  onBrowser?: (request: unknown) => Promise<unknown>;
  /**
   * Where the worker's `read_context` requests are answered, when the host retrieved context for this task.
   *
   * The same channel again: the worker is told how many items there are and reads them on demand, so nothing is
   * expanded up front and every read goes back through the host's principal-scoped readers.
   */
  onContext?: (request: unknown) => Promise<unknown>;
}

/** The messages that cross the worker's IPC channel, a request and its reply per kind. Anything else is ignored. */
export const WORKER_COMMAND_REQUEST = "clarkcant.command.request";
export const WORKER_COMMAND_REPLY = "clarkcant.command.reply";
export const WORKER_BROWSER_REQUEST = "clarkcant.browser.request";
export const WORKER_BROWSER_REPLY = "clarkcant.browser.reply";
export const WORKER_CONTEXT_REQUEST = "clarkcant.context.request";
export const WORKER_CONTEXT_REPLY = "clarkcant.context.reply";

export interface WorkerProcessResult {
  adapter: string;
  adapterVersion: string | undefined;
  /** The `provider/id` a real-model worker says it ran. Absent for the scripted adapter. */
  model?: string;
  stopReason: string;
  withheldCapabilities: string[];
  record: RunRecord;
  /**
   * What the worker's own session spent, as `apps/worker` already tracks it (its own token budget
   * enforcement reads the same numbers). Optional because a caller that fakes a result — this
   * interface predates usage reporting, and other fakes in this repository still construct one
   * without it — has nothing to report; `tokens` is itself absent rather than zero when the adapter
   * never reports usage at all, so a caller enforcing a token budget can tell "spent nothing" apart
   * from "this adapter does not say".
   */
  usage?: { turns: number; tokens?: number };
  /**
   * The files the worker's tools wrote, each with the SHA-256 (hex) of its last write. Optional for the same reason as
   * `usage`: a fake result predating it has none to report.
   */
  outputs?: WrittenFile[];
}

/** The worker in this repository, resolved from this file rather than from the working directory. */
function defaultWorkerEntry(): string {
  return fileURLToPath(new URL("../../worker/src/main.ts", import.meta.url));
}

/**
 * Run one worker session in its own process and return its record.
 *
 * Rejects only when the worker could not run at all. A run that demonstrated nothing resolves,
 * because "nothing was demonstrated" is a fact the caller has to act on rather than an error.
 */
export async function runWorkerProcess(options: WorkerProcessOptions): Promise<WorkerProcessResult> {
  const entry = options.workerEntry ?? defaultWorkerEntry();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? WORKER_ENV_PROFILE.maxOutputBytes;
  const directory = mkdtempSync(join(tmpdir(), "clarkcant-worker-run-"));
  const briefPath = join(directory, "brief.json");

  try {
    const channel = options.onCommand !== undefined || options.onBrowser !== undefined || options.onContext !== undefined;
    // The worker is told which kinds this host answers, so it offers only the tools that can work.
    const hostChannels = [
      ...(options.onCommand === undefined ? [] : (["command"] as const)),
      ...(options.onBrowser === undefined ? [] : (["browser"] as const)),
      ...(options.onContext === undefined ? [] : (["context"] as const)),
    ];
    const brief = channel ? { ...options.brief, hostChannels } : options.brief;
    writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`, "utf8");

    const adapter = options.adapter ?? "fake";
    const credential = adapter === "real" && options.credential !== undefined && options.credential !== "" ? options.credential : undefined;
    const args = [entry, "--brief", briefPath, "--node", options.nodeId, "--adapter", adapter];
    if (options.dataDir !== undefined) args.push("--data-dir", resolvePath(options.dataDir));
    if (options.scriptPath !== undefined) args.push("--script", options.scriptPath);
    if (credential !== undefined) args.push("--credential-stdin");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      // The child never inherits this process's environment wholesale: only the names the `build`
      // profile allows cross the boundary, so a provider key or an SSH agent socket sitting in this
      // node's own environment is not handed to code the worker's tools may invoke on the user's behalf.
      const stdin = credential === undefined ? "ignore" : "pipe";
      const child = (options.spawnImpl ?? spawn)(process.execPath, args, {
        stdio:
          channel ? [stdin, "pipe", "pipe", "ipc"] : [stdin, "pipe", "pipe"],
        env: workerEnvironment(adapter, options.agentDir),
        // A real model's worker starts in this run's own empty directory, not wherever this node was started from, so
        // nothing that happens to sit around the node's working directory is the worker's working directory too.
        ...(adapter === "real" ? { cwd: directory } : {}),
        // Its own process group, so a stop reaches what the worker's tools started as well as the worker.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      options.onChild?.(child);
      if (credential !== undefined) {
        // A worker that died before reading its stdin makes this write fail; that worker's exit is the error worth
        // reporting, and it is reported through `close` below. The failure itself is never echoed: it could quote
        // what was being written.
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(JSON.stringify({ apiKey: credential }));
      }
      if (channel) {
        const answerers = [
          { request: WORKER_COMMAND_REQUEST, reply: WORKER_COMMAND_REPLY, answer: options.onCommand, what: "commands" },
          { request: WORKER_BROWSER_REQUEST, reply: WORKER_BROWSER_REPLY, answer: options.onBrowser, what: "the browser" },
          { request: WORKER_CONTEXT_REQUEST, reply: WORKER_CONTEXT_REPLY, answer: options.onContext, what: "retrieved context" },
        ];
        child.on("message", (message: unknown) => {
          if (message === null || typeof message !== "object") return;
          const envelope = message as { type?: unknown; id?: unknown; request?: unknown };
          const kind = answerers.find((candidate) => candidate.request === envelope.type);
          if (kind === undefined || typeof envelope.id !== "string") return;
          const id = envelope.id.slice(0, 64);
          const answer =
            kind.answer ??
            (async (): Promise<unknown> => ({ kind: "refused", text: `refused: this task was not given ${kind.what}` }));
          void answer(envelope.request)
            .catch((cause: unknown) => ({
              kind: "refused",
              text: `the host could not run it: ${cause instanceof Error ? cause.message : String(cause)}`,
            }))
            .then((reply) => {
              // A worker that exited while its request ran has nobody to read the reply.
              if (child.connected) child.send({ type: kind.reply, id, reply }, () => undefined);
            });
        });
      }
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        void stopTree(child);
        reject(new Error(`the worker did not finish within ${String(timeoutMs)} ms`));
      }, timeoutMs);

      const overCeiling = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void stopTree(child);
        reject(new Error(`the worker exceeded the output ceiling of ${String(maxOutputBytes)} bytes`));
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes > maxOutputBytes) return overCeiling();
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes > maxOutputBytes) return overCeiling();
        stderr += chunk;
      });

      child.on("error", (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`the worker could not be started: ${cause.message}`, { cause }));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });

    // A provider's error can quote the key it was sent, and everything the worker printed ends up in a task's record or
    // an error message. The key is cut out of both before either is read.
    if (credential !== undefined) {
      result.stdout = result.stdout.split(credential).join("[redacted]");
      result.stderr = result.stderr.split(credential).join("[redacted]");
    }

    // Exit 2 is the worker saying it could not run: an unreadable brief, or an adapter that is not
    // available. That is a failure here rather than a result, which is the whole point of separating
    // it from a run that produced no evidence.
    if (result.code === 2) {
      throw new Error(`the worker could not run: ${result.stderr.trim() || "no reason given"}`);
    }
    if (result.code !== 0) {
      throw new Error(`the worker exited with code ${String(result.code)}: ${result.stderr.trim() || "no detail given"}`);
    }

    const parsed = parseWorkerOutput(result.stdout);
    return {
      adapter: parsed.adapter,
      adapterVersion: parsed.adapterVersion,
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      stopReason: parsed.stopReason,
      withheldCapabilities: parsed.withheldCapabilities,
      record: parsed.record,
      usage: parsed.usage,
      outputs: parsed.outputs,
    };
  } finally {
    try {
      // Retried, because on Windows a worker being stopped still holds its working directory for a moment.
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A temporary directory left behind (it holds the brief, never a key) is not worth replacing the run's own result
      // or error with.
    }
  }
}

interface WorkerOutput {
  adapter: string;
  adapterVersion: string | undefined;
  model: string | undefined;
  stopReason: string;
  withheldCapabilities: string[];
  record: RunRecord;
  usage: { turns: number; tokens?: number };
  outputs: WrittenFile[];
}

/** The most written files read back from one run, the same bound the worker reports under. */
const MAX_WORKER_OUTPUTS = 64;

/**
 * Read the worker's record back.
 *
 * The output is this repository's own worker, but a process that printed a banner, or died between
 * two writes, would otherwise turn into a `SyntaxError` from the middle of a dispatch. An unreadable
 * record is reported as exactly that.
 */
function parseWorkerOutput(stdout: string): WorkerOutput {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("the worker printed no record");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start)) as unknown;
  } catch (cause) {
    throw new Error("the worker printed something that is not a record", { cause });
  }

  if (parsed === null || typeof parsed !== "object") throw new Error("the worker printed no record");
  const output = parsed as Partial<WorkerOutput>;
  if (output.record === undefined || typeof output.record !== "object") {
    throw new Error("the worker's output carries no run record");
  }

  return {
    adapter: typeof output.adapter === "string" ? output.adapter : "unknown",
    adapterVersion: typeof output.adapterVersion === "string" ? output.adapterVersion : undefined,
    model: typeof output.model === "string" && output.model.length <= 300 ? output.model : undefined,
    stopReason: typeof output.stopReason === "string" ? output.stopReason : "unknown",
    withheldCapabilities: Array.isArray(output.withheldCapabilities)
      ? output.withheldCapabilities.filter((one): one is string => typeof one === "string")
      : [],
    record: output.record as RunRecord,
    usage: parseUsage(output.usage),
    outputs: parseOutputs(output.outputs),
  };
}

/**
 * The files the worker says it wrote, each read as an absolute path and a SHA-256 in hex, and nothing else: whatever
 * is done with them later reads the file again and compares it with this digest, so an entry that is not both is left
 * out rather than guessed at.
 */
function parseOutputs(value: unknown): WrittenFile[] {
  if (!Array.isArray(value)) return [];
  const outputs: WrittenFile[] = [];
  for (const item of value.slice(0, MAX_WORKER_OUTPUTS)) {
    if (item === null || typeof item !== "object") continue;
    const { path, sha256 } = item as { path?: unknown; sha256?: unknown };
    if (typeof path !== "string" || path.length === 0 || path.length > 4096 || !isAbsolute(path)) continue;
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) continue;
    outputs.push({ path, sha256 });
  }
  return outputs;
}

/**
 * `usage` the same way every other field here is read: a caller-supplied ceiling has something to
 * compare against only when the number is real, so a malformed or absent field falls back to "no
 * turns, no token count" rather than throwing partway through an otherwise-readable record.
 */
function parseUsage(value: unknown): { turns: number; tokens?: number } {
  if (value === null || typeof value !== "object") return { turns: 0 };
  const usage = value as { turns?: unknown; tokens?: unknown };
  const turns = typeof usage.turns === "number" ? usage.turns : 0;
  return typeof usage.tokens === "number" ? { turns, tokens: usage.tokens } : { turns };
}

export const WORKER_PROCESS_STATUS = "implemented-process-dispatch";
