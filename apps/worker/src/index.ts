/**
 * @clarkcant/app-worker
 *
 * Worker host: runs one app-managed Pi session per run and reports what happened.
 *
 * The worker never owns task authority. It returns a `RunRecord` full of evidence and stops;
 * `@clarkcant/core` decides what that evidence means for the task. The distinction is load
 * bearing — if the worker could mark its own task succeeded, "the session ended" would become
 * indistinguishable from "the work was done", which is exactly the failure mode the evidence
 * model exists to prevent.
 *
 * Three rules shape this loop:
 *
 *   1. **A capability the brief does not grant is never registered**, not merely hidden from the
 *      model. A tool that is registered is reachable, so hiding is not a boundary.
 *   2. **Evidence is built from what a tool actually returned**, digested, rather than from the
 *      fact that a tool ran. "A tool was called" proves nothing about the world.
 *   3. **Settling is not succeeding.** A session that ends without producing evidence reports
 *      `not-verified`, and a run stopped by its budget says so instead of quietly reporting the
 *      work it did manage to do.
 */

import { createHash } from "node:crypto";

import { type Evidence, type Instant, runRecordSchema, type RunRecord } from "@clarkcant/contracts";
import type { PiAdapter, ToolDefinition, WorkerBrief, WorkerEvent, WorkerUsage } from "@clarkcant/pi-adapter";
import { z } from "zod";

/** Evidence is capped by the contract; one slot is reserved for a truncation note. */
const MAX_EVIDENCE = 64;
const EVIDENCE_LIMIT = MAX_EVIDENCE - 1;

/** How much of a tool's output is quoted into an evidence summary. */
const SUMMARY_OUTPUT_CHARS = 300;

/**
 * The brief as it crosses the process boundary.
 *
 * Validated rather than asserted: a brief arriving over the wire is untrusted input, and a
 * missing `taskRevision` or a negative budget should be rejected with a field-level message
 * rather than producing a run that silently misreports itself.
 */
export const workerBriefEnvelopeSchema = z.strictObject({
  runId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  taskRevision: z.int().nonnegative(),
  /** Fencing token for the lease held while this run executes. */
  leaseEpoch: z.int().nonnegative(),
  goal: z.string().min(1).max(4000),
  projectRoots: z.array(z.string().min(1).max(1000)).max(64),
  /**
   * The roots the worker may change, when that is fewer than it may read. Absent means every project root, which is
   * what a person's request in the conversation has always been given.
   */
  writableRoots: z.array(z.string().min(1).max(1000)).max(64).optional(),
  allowedCapabilityRefs: z.array(z.string().min(1).max(200)).max(256),
  maxWallClockMs: z.int().positive().optional(),
  maxTokens: z.int().positive().optional(),
  /**
   * The model this run is worked by, as the host chose it. Absent means the worker's own environment decides, which for a
   * dispatched worker is nothing at all: its environment carries no model and no key. Never a credential — the key for it
   * travels separately, over stdin, so this file can sit in a temporary directory without holding a secret.
   */
  model: z
    .strictObject({
      provider: z.string().min(1).max(100),
      id: z.string().min(1).max(200),
      thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    })
    .optional(),
  /** Set when this run retries an earlier one, so lineage is never lost. */
  replacesRunId: z.string().min(1).max(128).optional(),
  /**
   * How many items the host retrieved from the conversation for this task, read on demand over the host channel.
   * Absent or zero means nothing was retrieved and the worker offers no context tool. A count, never the text: the
   * brief sits in a temporary file, and what the worker reads is re-read by the host at the moment it asks.
   */
  contextItems: z.int().min(0).max(64).optional(),
  /**
   * Which kinds of request the host that started this process answers over its channel. Set by the host whenever it opens
   * one, so a worker given a channel only to read context does not offer `run_command` or `use_browser` tools the host
   * would refuse on every call. Absent means the channel, when there is one, carries every kind.
   */
  hostChannels: z.array(z.enum(["command", "browser", "context"])).max(3).optional(),
  /**
   * Project guidance the host found applies to this task (#433), stated after the goal: how to do the work in the
   * folders it was given. Guidance only — it grants nothing the rest of this brief does not.
   */
  instructions: z.string().min(1).max(8000).optional(),
});

// Derived from the schema rather than declared alongside it. Two declarations of the same shape
// drift, and the drift only shows up as a run that misreports a field it read wrong.
export type WorkerBriefEnvelope = z.infer<typeof workerBriefEnvelopeSchema>;

/**
 * A tool the worker may register.
 *
 * `capabilityRef` is what the brief grants; `proves` is what a successful call demonstrates.
 * Requiring `proves` is deliberate: a tool whose success demonstrates nothing cannot produce
 * evidence, so registering it would only produce activity that looks like progress.
 */
export interface WorkerTool extends Omit<ToolDefinition, "execute"> {
  capabilityRef: string;
  proves: Evidence["kind"];
  /** What the tool did, plus, for a tool that wrote a file, which file and the digest of what it wrote. */
  execute: (params: Record<string, unknown>) => Promise<Awaited<ReturnType<ToolDefinition["execute"]>> & { wrote?: WrittenFile }>;
}

/** A file a tool wrote during the run: its resolved path, and the SHA-256 (hex) of the bytes it wrote. */
export interface WrittenFile {
  path: string;
  sha256: string;
}

/** The most written files one run reports; the rest are left out rather than flooding the host. */
export const MAX_OUTPUTS = 64;

export interface WorkerDeps {
  adapter: PiAdapter;
  /** The node this worker is executing for. Recorded, never chosen here. */
  nodeId: string;
  /** Every tool the host could offer. The brief's capabilities reduce this set. */
  availableTools: readonly WorkerTool[];
  now?: () => Instant;
  /**
   * How a turn is started. Defaults to `adapter.prompt`.
   *
   * A seam rather than a direct call so a test can model a session that never settles, and so
   * a retry policy can be added later without touching the budget logic.
   */
  drive?: (sessionId: string, goal: string) => Promise<void>;
  onEvent?: (event: WorkerEvent) => void;
  /**
   * Text that must never reach the run record, such as the provider key this worker was handed.
   *
   * Cut out of a message before it is shortened into a summary, not after: a provider error that quotes the key and is
   * cut in the middle of it would otherwise leave a prefix no exact-match redaction downstream can recognise.
   */
  secrets?: readonly string[];
  /**
   * Tools that read the task's own background from the host, such as `read_context`. Offered whatever the brief's
   * capabilities, because they read only what the host retrieved for this task, and never wrapped for evidence: a run
   * that only read its context demonstrated nothing.
   */
  contextTools?: readonly ToolDefinition[];
}

export type WorkerStopReason = "settled" | "wall-clock-budget" | "token-budget" | "failed";

export interface WorkerRunResult {
  record: RunRecord;
  sessionId: string;
  usage: { turns: number; tokens?: number };
  stopReason: WorkerStopReason;
  /**
   * Capability refs the brief did not grant. Reported so a caller can see what the worker was
   * denied rather than inferring it from a failure.
   */
  withheldCapabilities: string[];
  /** Session a later run should resume from, when the adapter offers one. */
  sessionFile: string | undefined;
  /**
   * The files this run wrote, each once with the digest of its last write, in the order first written. A host that
   * hands them on checks the digest against the file first, so one changed since is not passed off as this run's.
   */
  outputs: WrittenFile[];
}

export const WORKER_STATUS = "implemented-run-loop";

function digestOf(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

/**
 * JSON with keys in a stable order.
 *
 * Two calls with the same arguments must digest identically, otherwise a digest would depend on
 * property insertion order and stop being a usable "did this change?" signal.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `text` with every occurrence of each non-empty secret replaced by a marker that says something was removed. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret !== "") redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

/**
 * What a session has spent, in tokens: the adapter's total when it gives one, else the sum of the parts it does give.
 *
 * A real provider reports input, output and cache tokens separately and no total, so a budget read from the total alone
 * would never be reached by the one kind of session it exists for. Absent only when the adapter reports nothing at all,
 * so "spent nothing" and "this adapter does not say" stay two different answers.
 */
export function spentTokens(usage: WorkerUsage): number | undefined {
  if (usage.tokens !== undefined) return usage.tokens;
  const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].filter(
    (part): part is number => part !== undefined,
  );
  return parts.length === 0 ? undefined : parts.reduce((sum, part) => sum + part, 0);
}

/**
 * Run one worker session and return its evidence.
 *
 * Resolves for a run that accomplished nothing, because "nothing was demonstrated" is a result
 * the caller must judge. It rejects only when the worker could not run at all.
 */
export async function runWorker(
  envelope: WorkerBriefEnvelope,
  deps: WorkerDeps,
): Promise<WorkerRunResult> {
  const now = deps.now ?? ((): Instant => new Date().toISOString() as Instant);
  const startedAt = now();

  // Rule 1: the brief reduces the tool set before anything is registered.
  const permitted = deps.availableTools.filter((tool) =>
    envelope.allowedCapabilityRefs.includes(tool.capabilityRef),
  );
  const withheld = new Set<string>();
  for (const tool of deps.availableTools) {
    if (!envelope.allowedCapabilityRefs.includes(tool.capabilityRef)) withheld.add(tool.capabilityRef);
  }
  const withheldCapabilities = [...withheld];
  const permittedNames = new Set(permitted.map((tool) => tool.name));

  // Rule 2: evidence is captured where the tool result exists, so the digest is of real output.
  const observed: Evidence[] = [];
  const failures: Evidence[] = [];
  // Keyed by path, so a file written twice is reported once with what it holds now.
  const outputs = new Map<string, string>();

  const recordFailure = (toolName: string, ref: string, message: string): void => {
    failures.push({
      kind: "log-excerpt",
      ref,
      summary: `${toolName} failed: ${truncate(redactSecrets(message, deps.secrets), SUMMARY_OUTPUT_CHARS)}`,
      verdict: "contradicted",
      observedAt: now(),
    });
  };

  // Filled in once the session exists. A tool is only ever called after the prompt, which is after that.
  let sessionId = "";

  /*
   * The permitted tools, wrapped so each call leaves evidence, and handed over when the session is created.
   *
   * At creation rather than added afterwards: a real session fixes its tool registry when it is created, and a tool
   * appended later never reaches the allowlist the system prompt is written from, so a model would be told it has no
   * tools and invent some. Rule 1 still holds, because only the permitted tools are in this list at all.
   */
  const customTools: ToolDefinition[] = permitted.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    execute: async (params: Record<string, unknown>) => {
      const ref = `worker:${sessionId}:${tool.name}`;
      try {
        const { wrote, ...result } = await tool.execute(params);
        if (wrote !== undefined && (outputs.has(wrote.path) || outputs.size < MAX_OUTPUTS)) {
          outputs.set(wrote.path, wrote.sha256);
        }
        observed.push({
          kind: tool.proves,
          ref,
          digest: digestOf([tool.name, stableJson(params), result.text]),
          summary: `${tool.name} reported: ${truncate(redactSecrets(result.text, deps.secrets), SUMMARY_OUTPUT_CHARS)}`,
          verdict: "verified",
          observedAt: now(),
        });
        return result;
      } catch (cause) {
        recordFailure(tool.name, ref, describe(cause));
        throw cause;
      }
    },
  }));
  const contextTools = (deps.contextTools ?? []).filter((tool) => !permittedNames.has(tool.name));
  customTools.push(...contextTools);

  const brief: WorkerBrief = {
    goal: envelope.goal,
    projectRoots: envelope.projectRoots,
    allowedCapabilityRefs: envelope.allowedCapabilityRefs,
    customTools,
    ...(envelope.maxWallClockMs === undefined ? {} : { maxWallClockMs: envelope.maxWallClockMs }),
    ...(envelope.maxTokens === undefined ? {} : { maxTokens: envelope.maxTokens }),
  };

  const handle = await deps.adapter.createWorkerSession(brief);
  sessionId = handle.sessionId;

  // Narrowed to exactly the permitted names and the context readers: anything the adapter added on its own is not this
  // run's to offer.
  await deps.adapter.setActiveTools(handle.sessionId, [...permittedNames, ...contextTools.map((tool) => tool.name)]);

  /*
   * The token budget, checked after every turn rather than once the session has settled.
   *
   * A real model spends as it goes, so a ceiling read only at the end is a bill, not a limit. Crossing it aborts the
   * session, which cancels the provider call in flight, and the run reports the budget as why it stopped.
   */
  let budgetStop: WorkerStopReason | undefined;
  const overTokenBudget = (): number | undefined => {
    if (envelope.maxTokens === undefined) return undefined;
    const spent = spentTokens(deps.adapter.usage(handle.sessionId));
    return spent !== undefined && spent > envelope.maxTokens ? spent : undefined;
  };

  // A tool the adapter says failed is a contradiction even if it never reached our wrapper.
  const unsubscribe = deps.adapter.subscribe(handle.sessionId, (event) => {
    deps.onEvent?.(event);
    if (event.type === "error") {
      // The abort this run asked for is the budget's doing, which the run reports as its own reason.
      if (budgetStop === undefined) recordFailure("session", `worker:${handle.sessionId}`, event.message);
    }
    if (event.type === "tool-end" && event.isError && permittedNames.has(event.toolName)) {
      recordFailure(event.toolName, `worker:${handle.sessionId}:${event.toolCallId}`, "tool reported an error");
    }
    if (event.type === "turn-end" && budgetStop === undefined) {
      const spent = overTokenBudget();
      if (spent !== undefined) {
        budgetStop = "token-budget";
        void deps.adapter
          .abort(handle.sessionId, `token budget of ${String(envelope.maxTokens)} exceeded at ${String(spent)}`)
          .catch(() => undefined);
      }
    }
  });

  const drive = deps.drive ?? ((id: string, goal: string) => deps.adapter.prompt(id, goal));
  // The goal first, then the project's guidance for it, so the request is what the run reads before anything else.
  const prompt = envelope.instructions === undefined ? envelope.goal : `${envelope.goal}\n\n${envelope.instructions}`;

  let stopReason: WorkerStopReason = "settled";
  try {
    const budgetMs = envelope.maxWallClockMs;
    if (budgetMs === undefined) {
      await drive(handle.sessionId, prompt);
    } else {
      // Rule 3, in the small: exceeding the budget stops the run rather than being noticed
      // afterwards, so a runaway worker cannot spend without a limit.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          (async (): Promise<"settled"> => {
            await drive(handle.sessionId, prompt);
            return "settled";
          })(),
          new Promise<"wall-clock">((resolve) => {
            timer = setTimeout(() => resolve("wall-clock"), budgetMs);
          }),
        ]);
        if (outcome === "wall-clock") {
          stopReason = "wall-clock-budget";
          await deps.adapter.abort(
            handle.sessionId,
            `wall-clock budget of ${budgetMs} ms exceeded`,
          );
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } catch (cause) {
    stopReason = "failed";
    if (budgetStop === undefined) recordFailure("session", `worker:${handle.sessionId}`, describe(cause));
  }
  if (budgetStop !== undefined) stopReason = budgetStop;

  const adapterUsage = deps.adapter.usage(handle.sessionId);
  const tokens = spentTokens(adapterUsage);
  const usage = tokens === undefined ? { turns: adapterUsage.turns } : { turns: adapterUsage.turns, tokens };

  // The last turn's spend is only known once it ends, so a session that settled past its budget is still stopped by it.
  if (stopReason === "settled" && envelope.maxTokens !== undefined && tokens !== undefined && tokens > envelope.maxTokens) {
    stopReason = "token-budget";
    await deps.adapter.abort(handle.sessionId, `token budget of ${String(envelope.maxTokens)} exceeded at ${String(tokens)}`);
  }

  unsubscribe();
  await deps.adapter.dispose(handle.sessionId);

  const evidence: Evidence[] = [...observed, ...failures];

  if (evidence.length > EVIDENCE_LIMIT) {
    // Truncation is reported rather than silent: a caller that cannot see the dropped evidence
    // would be reading an incomplete account of the run.
    const dropped = evidence.length - EVIDENCE_LIMIT;
    evidence.length = EVIDENCE_LIMIT;
    evidence.push({
      kind: "log-excerpt",
      summary: `${dropped} further evidence entries were collected and dropped at the contract limit`,
      verdict: "not-verified",
      observedAt: now(),
    });
  }

  if (stopReason !== "settled") {
    const why =
      stopReason === "wall-clock-budget"
        ? "its wall-clock budget"
        : stopReason === "token-budget"
          ? "its token budget"
          : "a failure before the session settled";
    evidence.push({
      kind: "absent",
      summary: `the run was stopped by ${why}; the work is unfinished and this run does not report it as done`,
      verdict: "not-verified",
      observedAt: now(),
    });
  } else if (evidence.length === 0) {
    // A settled session produced no proof of anything. Reporting success here is precisely the
    // mistake the evidence model exists to catch. Every call of a permitted tool leaves evidence,
    // so a run that had tools and none here answered without calling one: said plainly, because the
    // work was only ever going to be done through those tools, and a model that cannot call tools
    // ends exactly like this.
    evidence.push({
      kind: "absent",
      summary:
        permitted.length > 0
          ? `the model answered without using any of its tools (${[...permittedNames].join(", ")}), so nothing was done; ` +
            "this is not a result, and the model may not be able to call tools"
          : "the session settled without producing any verifiable evidence; this is not a result",
      verdict: "not-verified",
      observedAt: now(),
    });
  }

  const record = runRecordSchema.parse({
    runId: envelope.runId,
    taskId: envelope.taskId,
    taskRevision: envelope.taskRevision,
    executionNodeId: deps.nodeId,
    leaseEpoch: envelope.leaseEpoch,
    ...(envelope.replacesRunId === undefined ? {} : { replacesRunId: envelope.replacesRunId }),
    startedAt,
    endedAt: now(),
    evidence,
  });

  return {
    record,
    sessionId: handle.sessionId,
    usage,
    stopReason,
    withheldCapabilities,
    // The real path, so a caller can resume the run instead of repeating it. Reporting `undefined`
    // here meant every run started from nothing, which is also why there was no transcript to
    // search.
    sessionFile: handle.sessionFile,
    outputs: [...outputs].map(([path, sha256]) => ({ path, sha256 })),
  };
}
