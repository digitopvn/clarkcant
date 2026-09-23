import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunRecord } from "@clarkcant/contracts";
import type { WorkerBriefEnvelope } from "@clarkcant/app-worker";

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
  /** Injected so a test can drive a different entry point. */
  spawnImpl?: typeof spawn;
  /** Where the worker writes its transcript. Unset leaves the session in memory. */
  dataDir?: string;
}

export interface WorkerProcessResult {
  adapter: string;
  adapterVersion: string | undefined;
  stopReason: string;
  withheldCapabilities: string[];
  record: RunRecord;
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
  const directory = mkdtempSync(join(tmpdir(), "clarkcant-worker-run-"));
  const briefPath = join(directory, "brief.json");

  try {
    writeFileSync(briefPath, `${JSON.stringify(options.brief, null, 2)}\n`, "utf8");

    const args = [entry, "--brief", briefPath, "--node", options.nodeId, "--adapter", options.adapter ?? "fake"];
    if (options.dataDir !== undefined) args.push("--data-dir", options.dataDir);

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = (options.spawnImpl ?? spawn)(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`the worker did not finish within ${String(timeoutMs)} ms`));
      }, timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
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
  };
}

export const WORKER_PROCESS_STATUS = "implemented-process-dispatch";
