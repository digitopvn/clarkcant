import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunRecord } from "@clarkcant/contracts";
import type { WorkerBriefEnvelope } from "@clarkcant/app-worker";
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

export interface WorkerProcessOptions {
  /** The worker's entry point. Defaults to the sibling app in this repository. */
  workerEntry?: string;
  nodeId: string;
  brief: WorkerBriefEnvelope;
  /** `fake` proves the wiring without a provider; `real` needs a model configured. */
  adapter?: "fake" | "real";
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
}

export interface WorkerProcessResult {
  adapter: string;
  adapterVersion: string | undefined;
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
    writeFileSync(briefPath, `${JSON.stringify(options.brief, null, 2)}\n`, "utf8");

    const args = [entry, "--brief", briefPath, "--node", options.nodeId, "--adapter", options.adapter ?? "fake"];
    if (options.dataDir !== undefined) args.push("--data-dir", options.dataDir);
    if (options.scriptPath !== undefined) args.push("--script", options.scriptPath);

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      // The child never inherits this process's environment wholesale: only the names the `build`
      // profile allows cross the boundary, so a provider key or an SSH agent socket sitting in this
      // node's own environment is not handed to code the worker's tools may invoke on the user's behalf.
      const child = (options.spawnImpl ?? spawn)(process.execPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildEnvironment(WORKER_ENV_PROFILE),
        // Its own process group, so a stop reaches what the worker's tools started as well as the worker.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      options.onChild?.(child);
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
      stopReason: parsed.stopReason,
      withheldCapabilities: parsed.withheldCapabilities,
      record: parsed.record,
      usage: parsed.usage,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface WorkerOutput {
  adapter: string;
  adapterVersion: string | undefined;
  stopReason: string;
  withheldCapabilities: string[];
  record: RunRecord;
  usage: { turns: number; tokens?: number };
}

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
    stopReason: typeof output.stopReason === "string" ? output.stopReason : "unknown",
    withheldCapabilities: Array.isArray(output.withheldCapabilities)
      ? output.withheldCapabilities.filter((one): one is string => typeof one === "string")
      : [],
    record: output.record as RunRecord,
    usage: parseUsage(output.usage),
  };
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
