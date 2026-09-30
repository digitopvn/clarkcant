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
 * `--adapter real` runs the model the brief names (else `CC_MODEL_PROVIDER`/`CC_MODEL_ID`), and a worker given
 * neither exits 2 rather than letting the SDK pick one nobody chose. With `--credential-stdin`, the provider's key is
 * read from stdin as `{"apiKey":"…"}` before anything else happens: never from an argument, which any process on the
 * machine can list, and never from the environment, which everything this process started would inherit.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FakePiAdapter,
  RealPiAdapter,
  modelFromEnv,
  type ModelSelection,
  type PiAdapter,
  type ScriptedTurn,
} from "@clarkcant/pi-adapter";

import {
  redactSecrets,
  runWorker,
  workerBriefEnvelopeSchema,
  type WorkerBriefEnvelope,
  type WorkerDeps,
} from "./index.ts";
import { allWorkerTools, processBrowserChannel, processCommandChannel } from "./tools.ts";

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
  /** Whether the host writes the provider key to stdin. */
  credentialStdin: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    briefPath: undefined,
    nodeId: "node_local",
    adapter: "fake",
    dataDir: undefined,
    scriptPath: undefined,
    credentialStdin: false,
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
    } else if (flag === "--credential-stdin") {
      args.credentialStdin = true;
    }
  }
  return args;
}

/** The key this process was handed, once read: cut out of everything it prints, including a crash's stack. */
const secrets: string[] = [];

function write(stream: NodeJS.WriteStream, text: string): void {
  stream.write(redactSecrets(text, secrets));
}

/** A key is a line of text; anything longer than this on stdin is not one. */
const MAX_CREDENTIAL_BYTES = 16 * 1024;

/**
 * The provider key the host wrote to stdin, read whole and then left only in the returned value.
 *
 * Nothing about it is ever written out: a malformed handoff is reported by what was wrong with its shape, never by what
 * it contained.
 */
async function readCredential(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    size += buffer.length;
    if (size > MAX_CREDENTIAL_BYTES) throw new Error(`the credential handoff is longer than ${String(MAX_CREDENTIAL_BYTES)} bytes`);
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("the credential handoff is not JSON");
  }
  const apiKey = parsed !== null && typeof parsed === "object" ? (parsed as { apiKey?: unknown }).apiKey : undefined;
  if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error("the credential handoff carries no key");
  return apiKey.trim();
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

  // The key first, before anything else runs, so it is never held any longer or anywhere wider than it has to be.
  let apiKey: string | undefined;
  if (args.credentialStdin) {
    try {
      apiKey = await readCredential();
    } catch (cause) {
      process.stderr.write(`worker: could not read the credential: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      return 2;
    }
    secrets.push(apiKey);
  }

  // A worker started with no model says so rather than resolving one nobody chose. The model is the host's choice,
  // carried on the brief; the environment is the fallback for a worker started by hand. The adapter refuses an unknown
  // provider or model by name.
  const briefed = envelope.model;
  const model: ModelSelection | undefined =
    briefed === undefined
      ? modelFromEnv(process.env)
      : {
          provider: briefed.provider,
          id: briefed.id,
          ...(briefed.thinkingLevel === undefined ? {} : { thinkingLevel: briefed.thinkingLevel }),
        };
  if (args.adapter === "real" && model === undefined) {
    process.stderr.write("worker: the real adapter was asked for, but no model was given to this worker\n");
    return 2;
  }
  // A worker writes its transcript into the data directory it was given, so a later run can resume
  // it and the history index can read it. A fake adapter is left in memory: it has no transcript to
  // resume, and pretending otherwise would be a fixture imitating a fact.
  const adapter: PiAdapter =
    args.adapter === "real"
      ? new RealPiAdapter({
          cwd: process.cwd(),
          // A worker is given its tools by the host and nothing else: no extension, skill, prompt template or
          // instructions file found on this machine is loaded into it.
          isolated: true,
          ...(model === undefined ? {} : { model }),
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(args.dataDir === undefined ? {} : { sessionDir: join(args.dataDir, "sessions") }),
        })
      : (() => {
          const script = readScript(args.scriptPath);
          return new FakePiAdapter(script === undefined ? {} : { script });
        })();
  const availability = await adapter.availability();
  if (!availability.available) {
    // Honest failure: an unavailable adapter is not a worker that ran and found nothing.
    write(
      process.stderr,
      `worker: the ${args.adapter} adapter is not available: ${availability.reason ?? "no reason given"}\n`,
    );
    return 2;
  }

  // Commands and the browser go to the host that started this process, over the channel it opened, and only when it
  // opened one. The brief's capabilities still decide which of the tools this run is offered.
  const commands = processCommandChannel();
  const browser = processBrowserChannel();
  const deps: WorkerDeps = {
    adapter,
    nodeId: args.nodeId,
    secrets,
    availableTools: allWorkerTools(envelope.projectRoots, {
      ...(envelope.writableRoots === undefined ? {} : { writableRoots: envelope.writableRoots }),
      ...(commands === undefined ? {} : { commands }),
      ...(browser === undefined ? {} : { browser }),
    }),
  };

  const result = await runWorker(envelope, deps);

  write(
    process.stdout,
    `${JSON.stringify(
      {
        adapter: args.adapter,
        adapterVersion: availability.sdkVersion,
        // Which model did the work, so the host can write it down. Never the key.
        ...(args.adapter === "real" && model !== undefined ? { model: `${model.provider}/${model.id}` } : {}),
        stopReason: result.stopReason,
        usage: result.usage,
        withheldCapabilities: result.withheldCapabilities,
        record: result.record,
        outputs: result.outputs,
      },
      null,
      2,
    )}\n`,
  );

  const verdicts = result.record.evidence.map((item) => item.verdict);
  write(process.stderr, `worker: ${result.stopReason}; evidence ${verdicts.join(", ") || "none"}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
    // An open IPC channel would keep a finished worker alive; the host reads the record on exit.
    if (process.connected) process.disconnect();
  },
  (cause: unknown) => {
    write(process.stderr, `worker: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
    process.exitCode = 2;
    if (process.connected) process.disconnect();
  },
);
