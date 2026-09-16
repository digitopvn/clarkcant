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
import type { PiAdapter, ToolDefinition, WorkerBrief, WorkerEvent } from "@clarkcant/pi-adapter";
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
  allowedCapabilityRefs: z.array(z.string().min(1).max(200)).max(256),
  maxWallClockMs: z.int().positive().optional(),
  maxTokens: z.int().positive().optional(),
  /** Set when this run retries an earlier one, so lineage is never lost. */
  replacesRunId: z.string().min(1).max(128).optional(),
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
export interface WorkerTool extends ToolDefinition {
  capabilityRef: string;
  proves: Evidence["kind"];
}

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

  const brief: WorkerBrief = {
    goal: envelope.goal,
    projectRoots: envelope.projectRoots,
    allowedCapabilityRefs: envelope.allowedCapabilityRefs,
    ...(envelope.maxWallClockMs === undefined ? {} : { maxWallClockMs: envelope.maxWallClockMs }),
    ...(envelope.maxTokens === undefined ? {} : { maxTokens: envelope.maxTokens }),
  };

  const handle = await deps.adapter.createWorkerSession(brief);

  // Rule 2: evidence is captured where the tool result exists, so the digest is of real output.
  const observed: Evidence[] = [];
  const failures: Evidence[] = [];

  const recordFailure = (toolName: string, ref: string, message: string): void => {
    failures.push({
      kind: "log-excerpt",
      ref,
      summary: `${toolName} failed: ${truncate(message, SUMMARY_OUTPUT_CHARS)}`,
      verdict: "contradicted",
      observedAt: now(),
    });
  };

  for (const tool of permitted) {
    await deps.adapter.registerTool(handle.sessionId, {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (params: Record<string, unknown>) => {
        const ref = `worker:${handle.sessionId}:${tool.name}`;
        try {
          const result = await tool.execute(params);
          observed.push({
            kind: tool.proves,
            ref,
            digest: digestOf([tool.name, stableJson(params), result.text]),
            summary: `${tool.name} reported: ${truncate(result.text, SUMMARY_OUTPUT_CHARS)}`,
            verdict: "verified",
            observedAt: now(),
          });
          return result;
        } catch (cause) {
          recordFailure(tool.name, ref, describe(cause));
          throw cause;
        }
      },
    });
  }

  await deps.adapter.setActiveTools(handle.sessionId, [...permittedNames]);

  // A tool the adapter says failed is a contradiction even if it never reached our wrapper.
  const unsubscribe = deps.adapter.subscribe(handle.sessionId, (event) => {
    deps.onEvent?.(event);
    if (event.type === "error") {
      recordFailure("session", `worker:${handle.sessionId}`, event.message);
    }
    if (event.type === "tool-end" && event.isError && permittedNames.has(event.toolName)) {
      recordFailure(event.toolName, `worker:${handle.sessionId}:${event.toolCallId}`, "tool reported an error");
    }
  });

  const drive = deps.drive ?? ((sessionId: string, goal: string) => deps.adapter.prompt(sessionId, goal));

  let stopReason: WorkerStopReason = "settled";
  try {
    const budgetMs = envelope.maxWallClockMs;
    if (budgetMs === undefined) {
      await drive(handle.sessionId, envelope.goal);
    } else {
      // Rule 3, in the small: exceeding the budget stops the run rather than being noticed
      // afterwards, so a runaway worker cannot spend without a limit.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          (async (): Promise<"settled"> => {
            await drive(handle.sessionId, envelope.goal);
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
    recordFailure("session", `worker:${handle.sessionId}`, describe(cause));
  }

  const usage = deps.adapter.usage(handle.sessionId);

  if (
    stopReason === "settled" &&
    envelope.maxTokens !== undefined &&
    (usage.tokens ?? 0) > envelope.maxTokens
  ) {
    stopReason = "token-budget";
    await deps.adapter.abort(
      handle.sessionId,
      `token budget of ${envelope.maxTokens} exceeded at ${usage.tokens ?? 0}`,
    );
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
    // mistake the evidence model exists to catch.
    evidence.push({
      kind: "absent",
      summary: "the session settled without producing any verifiable evidence; this is not a result",
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
    sessionFile: undefined,
  };
}
