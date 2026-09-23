#!/usr/bin/env node
/**
 * Worker process entry point.
 *
 *   node apps/worker/src/main.ts --brief <file.json> [--node <id>] [--adapter fake|real]
 *
 * Reads a bounded brief, runs one worker session, and prints the run record. The exit code
 * distinguishes "the worker ran" from "the work was demonstrated": a run that produced no
 * evidence exits 0 with a `not-verified` verdict, because reporting an honest non-result is a
 * successful run of the worker, not a failure of it. Exit 2 means the worker itself could not
 * run.
 *
 * There is no live provider configured in this environment, so `--adapter real` reports its
 * unavailability instead of pretending.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FakePiAdapter, RealPiAdapter, modelFromEnv, type PiAdapter, type ScriptedTurn } from "@clarkcant/pi-adapter";

import { runWorker, workerBriefEnvelopeSchema, type WorkerBriefEnvelope, type WorkerDeps } from "./index.ts";
import { allWorkerTools } from "./tools.ts";

interface Args {
  briefPath: string | undefined;
  nodeId: string;
  adapter: "fake" | "real";
  /** Where the transcript is written. Unset means an in-memory session. */
  dataDir: string | undefined;
  /**
   * Path to a JSON array of `ScriptedTurn`s for the fake adapter. Only meaningful with
   * `--adapter fake`; a real provider has no script to read. Exists so a test can spawn the real
   * worker process and still drive a deterministic tool call, rather than only ever getting the fake
   * adapter's generic text reply.
   */
  scriptPath: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    briefPath: undefined,
    nodeId: "node_local",
    adapter: "fake",
    dataDir: undefined,
    scriptPath: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--brief" && value !== undefined) {
      args.briefPath = value;
      index += 1;
    } else if (flag === "--node" && value !== undefined) {
      args.nodeId = value;
      index += 1;
    } else if (flag === "--adapter" && (value === "fake" || value === "real")) {
      args.adapter = value;
      index += 1;
    } else if (flag === "--data-dir" && value !== undefined) {
      args.dataDir = value;
      index += 1;
    } else if (flag === "--script" && value !== undefined) {
      args.scriptPath = value;
      index += 1;
    }
  }
  return args;
}

/** Read and validate the fake adapter's script file, when one was given. */
function readScript(path: string | undefined): ScriptedTurn[] | undefined {
  if (path === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`the script is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
  if (!Array.isArray(parsed)) throw new Error("the script must be a JSON array of scripted turns");
  return parsed as ScriptedTurn[];
}

function readBrief(path: string | undefined): WorkerBriefEnvelope {
  const raw = path === undefined ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // Wrapped here rather than upstream so the message names the brief, which is the part the
    // caller has to fix. `cause` is attached so the underlying parse position survives.
    throw new Error(
      `the brief is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  // Validated against the schema rather than asserted: a brief arriving from another process is
  // untrusted input, and a missing revision should be a field-level error.
  const parsedBrief = workerBriefEnvelopeSchema.safeParse(parsed);
  if (!parsedBrief.success) {
    const detail = parsedBrief.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`the brief is not a valid worker brief: ${detail}`);
  }
  return parsedBrief.data;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  let envelope: WorkerBriefEnvelope;
  try {
    envelope = readBrief(args.briefPath);
  } catch (cause) {
    process.stderr.write(
      `worker: could not read the brief: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return 2;
  }

  // A worker started with no model configured says so rather than resolving one nobody chose.
  // The adapter refuses an unknown provider or model by name, and the environment is where the
  // credential for it has to be, so this is the whole of the worker's model configuration.
  const model = modelFromEnv(process.env);
  // A worker writes its transcript into the data directory it was given, so a later run can resume
  // it and the history index can read it. A fake adapter is left in memory: it has no transcript to
  // resume, and pretending otherwise would be a fixture imitating a fact.
  const adapter: PiAdapter =
    args.adapter === "real"
      ? new RealPiAdapter({
          cwd: process.cwd(),
          ...(model === undefined ? {} : { model }),
          ...(args.dataDir === undefined ? {} : { sessionDir: join(args.dataDir, "sessions") }),
        })
      : (() => {
          const script = readScript(args.scriptPath);
          return new FakePiAdapter(script === undefined ? {} : { script });
        })();
  const availability = await adapter.availability();
  if (!availability.available) {
    // Honest failure: an unavailable adapter is not a worker that ran and found nothing.
    process.stderr.write(
      `worker: the ${args.adapter} adapter is not available: ${availability.reason ?? "no reason given"}\n`,
    );
    return 2;
  }

  const deps: WorkerDeps = {
    adapter,
    nodeId: args.nodeId,
    availableTools: allWorkerTools(envelope.projectRoots),
  };

  const result = await runWorker(envelope, deps);

  process.stdout.write(
    `${JSON.stringify(
      {
        adapter: args.adapter,
        adapterVersion: availability.sdkVersion,
        stopReason: result.stopReason,
        usage: result.usage,
        withheldCapabilities: result.withheldCapabilities,
        record: result.record,
      },
      null,
      2,
    )}\n`,
  );

  const verdicts = result.record.evidence.map((item) => item.verdict);
  process.stderr.write(
    `worker: ${result.stopReason}; evidence ${verdicts.join(", ") || "none"}\n`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (cause: unknown) => {
    process.stderr.write(
      `worker: ${cause instanceof Error ? cause.stack : String(cause)}\n`,
    );
    process.exitCode = 2;
  },
);
