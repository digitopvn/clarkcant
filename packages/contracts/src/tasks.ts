import { z } from "zod";

import { instantSchema } from "./primitives.ts";

/**
 * Task and run lifecycle.
 *
 * Two invariants drive the shape of this table:
 *
 * 1. A worker going idle, an LLM finishing a turn, or a socket closing is never
 *    success. The only path into `succeeded` is `verifying` with recorded
 *    evidence. There is deliberately no `idle -> succeeded` edge to be tempted by.
 * 2. An external effect that may already have landed is never retried. The
 *    `uncertain` state exists so a timeout becomes a question for reconciliation
 *    instead of a silent second write.
 */

export const taskStateSchema = z.enum([
  "queued",
  "resolving",
  "waiting_input",
  "waiting_capability",
  "waiting_approval",
  "dispatched",
  "running",
  "pause_requested",
  "paused",
  "cancel_requested",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "uncertain",
  "reconciling",
]);
export type TaskState = z.infer<typeof taskStateSchema>;

export const TERMINAL_TASK_STATES = ["succeeded", "failed", "cancelled"] as const satisfies readonly TaskState[];

export function isTerminal(state: TaskState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

/**
 * States that hold no worker and therefore cost nothing while waiting. They must
 * still accept cancellation and must not spin: `waiting_capability` keeps a
 * continuation (envelope.ts), not a live agent loop.
 */
export const PARKED_TASK_STATES = [
  "waiting_input",
  "waiting_capability",
  "waiting_approval",
  "paused",
] as const satisfies readonly TaskState[];

export function isParked(state: TaskState): boolean {
  return (PARKED_TASK_STATES as readonly TaskState[]).includes(state);
}

/**
 * Every event the reducer understands. Adding a state without adding its entry
 * and exit events fails the totality test in `test/task-machine.spec.ts`.
 */
export const taskEventSchema = z.enum([
  "resolve.start",
  "resolve.need_input",
  "resolve.need_capability",
  "resolve.need_approval",
  "resolve.ready",
  "resolve.failed",
  "input.provided",
  "capability.ready",
  "approval.granted",
  "dispatch.acknowledged",
  "dispatch.timed_out",
  "run.needs_approval",
  "run.approval_granted",
  "run.verifying",
  "verify.passed",
  "verify.failed",
  "pause.requested",
  "pause.reached",
  "resume.requested",
  "cancel.requested",
  "cancel.confirmed",
  "effect.unknown",
  "reconcile.start",
  "reconcile.succeeded",
  "reconcile.failed",
  "reconcile.cancelled",
  "reconcile.parked",
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;

/**
 * The transition table.
 *
 * `null` means the pair is not a legal transition and the reducer refuses it
 * rather than ignoring it — an ignored illegal event is indistinguishable from a
 * lost one at the UI layer.
 */
const TRANSITIONS: Record<TaskState, Partial<Record<TaskEvent, TaskState>>> = {
  queued: {
    "resolve.start": "resolving",
  },
  resolving: {
    "resolve.need_input": "waiting_input",
    "resolve.need_capability": "waiting_capability",
    "resolve.need_approval": "waiting_approval",
    "resolve.ready": "dispatched",
    // Resolution must not hang forever: a resolution failure is terminal and
    // leaves a run with explicit lineage rather than a task stuck forever.
    "resolve.failed": "failed",
  },
  waiting_input: {
    "input.provided": "resolving",
  },
  waiting_capability: {
    "capability.ready": "queued",
  },
  waiting_approval: {
    // Resolution parked before a worker ever ran; the resolver picks up again from `queued`.
    "approval.granted": "queued",
    // The execution-policy gate parked a run already dispatched; it resumes where it left off, on the same
    // execution node, rather than being resolved a second time.
    "run.approval_granted": "dispatched",
  },
  dispatched: {
    "dispatch.acknowledged": "running",
    // The executor never confirmed acceptance. Whether it started is unknown.
    "dispatch.timed_out": "uncertain",
  },
  running: {
    "run.verifying": "verifying",
    "pause.requested": "pause_requested",
    "effect.unknown": "uncertain",
    // The execution-policy gate needs a decision before this run's effect may happen. No evidence exists yet, so
    // this is not a failure - the task is parked exactly like an approval requested during resolution.
    "run.needs_approval": "waiting_approval",
  },
  pause_requested: {
    "pause.reached": "paused",
    "effect.unknown": "uncertain",
  },
  paused: {
    "resume.requested": "queued",
  },
  cancel_requested: {
    "cancel.confirmed": "cancelled",
    "effect.unknown": "uncertain",
  },
  verifying: {
    "verify.passed": "succeeded",
    "verify.failed": "failed",
    "effect.unknown": "uncertain",
  },
  uncertain: {
    "reconcile.start": "reconciling",
  },
  reconciling: {
    "reconcile.succeeded": "succeeded",
    "reconcile.failed": "failed",
    "reconcile.cancelled": "cancelled",
    "reconcile.parked": "paused",
  },
  succeeded: {},
  failed: {},
  cancelled: {},
};

/**
 * Cancellation is not a per-state privilege. Any non-terminal task can be asked
 * to stop; the request routes through `cancel_requested` so that the executor
 * gets a chance to confirm what actually happened.
 */
export function cancellationTarget(state: TaskState): TaskState | undefined {
  if (isTerminal(state)) return undefined;
  if (state === "cancel_requested") return undefined;
  return "cancel_requested";
}

export type TransitionOutcome =
  | { ok: true; state: TaskState; changed: boolean }
  | { ok: false; code: "ILLEGAL_TRANSITION"; message: string };

/**
 * Apply one task event.
 *
 * Cancellation is handled before the explicit table so that a non-terminal state
 * added later cannot forget to accept it.
 */
export function reduceTask(state: TaskState, event: TaskEvent): TransitionOutcome {
  if (event === "cancel.requested") {
    const target = cancellationTarget(state);
    if (!target) {
      return {
        ok: false,
        code: "ILLEGAL_TRANSITION",
        message: `task in terminal state ${state} cannot be cancelled`,
      };
    }
    return { ok: true, state: target, changed: target !== state };
  }

  const next = TRANSITIONS[state][event];
  if (!next) {
    return {
      ok: false,
      code: "ILLEGAL_TRANSITION",
      message: `event ${event} is not valid in state ${state}`,
    };
  }
  return { ok: true, state: next, changed: next !== state };
}

export function legalEvents(state: TaskState): TaskEvent[] {
  const explicit = Object.keys(TRANSITIONS[state]) as TaskEvent[];
  if (cancellationTarget(state)) return [...explicit, "cancel.requested"];
  return explicit;
}

export function statesReachableFrom(state: TaskState): TaskState[] {
  const targets = new Set<TaskState>();
  for (const event of legalEvents(state)) {
    const outcome = reduceTask(state, event);
    if (outcome.ok) targets.add(outcome.state);
  }
  return [...targets];
}

/**
 * Whether every declared state can actually be reached from the entry state.
 *
 * A state nothing can reach is either a missing transition or a leftover from a
 * design that changed. Both are worth failing a build over, because an unreachable
 * state means some recovery path the UI expects does not exist.
 */
export function allStatesReachable(entry: TaskState = "queued"): boolean {
  const seen = new Set<TaskState>([entry]);
  const queue: TaskState[] = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of statesReachableFrom(current)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return taskStateSchema.options.every((state) => seen.has(state));
}

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

export const evidenceSchema = z.strictObject({
  kind: z.enum([
    "exit-status",
    "file-diff",
    "file-version",
    "api-receipt",
    "read-after-write",
    "browser-observation",
    "test-output",
    "screenshot",
    "log-excerpt",
    "absent",
  ]),
  /** Opaque reference to the evidence blob, not the blob itself. */
  ref: z.string().min(1).max(300).optional(),
  digest: z.string().min(1).max(120).optional(),
  summary: z.string().min(1).max(1000),
  /**
   * `not-verified` is a first-class outcome. A task whose evidence is missing
   * reports this instead of a polished success card.
   */
  verdict: z.enum(["verified", "not-verified", "contradicted"]),
  observedAt: instantSchema,
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const runRecordSchema = z.strictObject({
  runId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  /** Revision of the task this run executed. A newer revision needs a new run. */
  taskRevision: z.int().nonnegative(),
  executionNodeId: z.string().min(1).max(128),
  /** Fencing token for the lease held while this run was executing. */
  leaseEpoch: z.int().nonnegative(),
  /** Lineage, so `terminal` never means "started from nowhere". */
  replacesRunId: z.string().min(1).max(128).optional(),
  startedAt: instantSchema,
  endedAt: instantSchema.optional(),
  evidence: z.array(evidenceSchema).max(64),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const taskRecordSchema = z.strictObject({
  taskId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(128),
  /** Node holding timeline authority for this task. Exactly one at a time. */
  homeNodeId: z.string().min(1).max(128),
  /** Node that has been chosen to execute. Assigned during resolution. */
  executionNodeId: z.string().min(1).max(128).optional(),
  state: taskStateSchema,
  revision: z.int().nonnegative(),
  /** User-facing goal, kept verbatim so re-resolution cannot quietly reword it. */
  goal: z.string().min(1).max(4000),
  /** Why the task is parked, shown in the system card. */
  parkedReason: z.string().min(1).max(500).optional(),
  /** Capability the task is waiting for, if parked on a capability. */
  waitingCapabilityRef: z.string().min(1).max(160).optional(),
  /** Install plan whose completion unblocks this task. */
  waitingInstallPlanId: z.string().min(1).max(128).optional(),
  activeRunId: z.string().min(1).max(128).optional(),
  /** Budget the task may consume before it must stop and explain. */
  budget: z
    .strictObject({
      maxWallClockMs: z.int().nonnegative().optional(),
      maxTokens: z.int().nonnegative().optional(),
      maxDelegationDepth: z.int().nonnegative().max(8),
    })
    .optional(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type TaskRecord = z.infer<typeof taskRecordSchema>;

/**
 * High-level classification used by the UI and by the conductor.
 *
 * `uncertain` is intentionally its own class: it demands disclosure, not a
 * retry button, so it is never merged into `failed`.
 */
export const taskDispositionSchema = z.enum([
  "in-progress",
  "needs-user",
  "needs-capability",
  "verifying",
  "uncertain",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskDisposition = z.infer<typeof taskDispositionSchema>;

export function dispositionOf(state: TaskState): TaskDisposition {
  switch (state) {
    case "queued":
    case "resolving":
    case "dispatched":
    case "running":
    case "pause_requested":
      return "in-progress";
    case "waiting_input":
    case "waiting_approval":
      return "needs-user";
    case "waiting_capability":
      return "needs-capability";
    case "paused":
      return "needs-user";
    case "cancel_requested":
      return "in-progress";
    case "verifying":
      return "verifying";
    case "uncertain":
    case "reconciling":
      return "uncertain";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/**
 * A task that can be resumed without re-sending a lost command.
 *
 * `stale` records that the original intent changed while the task was parked;
 * the caller must re-validate before resuming rather than blindly continuing the
 * old instruction (acceptance test T27).
 */
export const taskContinuationSchema = z.strictObject({
  taskId: z.string().min(1).max(128),
  taskRevision: z.int().nonnegative(),
  originalRequest: z.string().min(1).max(4000),
  expectedNextStep: z.string().min(1).max(2000),
  requiredCapabilityRef: z.string().min(1).max(160).optional(),
  workspaceResourceIds: z.array(z.string().min(1).max(200)).max(32),
  completedEffectIds: z.array(z.string().min(1).max(128)).max(256),
  verificationCriteria: z.array(z.string().min(1).max(500)).max(32),
  stale: z.boolean(),
});
export type TaskContinuation = z.infer<typeof taskContinuationSchema>;
