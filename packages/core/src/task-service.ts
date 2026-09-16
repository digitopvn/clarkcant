import {
  type ApprovalId,
  type CapabilityRef,
  type EffectCategory,
  type EffectRecord,
  type Evidence,
  type Grant,
  type Instant,
  type Principal,
  type ResourceRef,
  type TaskEvent,
  type TaskRecord,
  capabilityRefSchema,
  checkGrant,
  dispositionOf,
  evidenceSchema,
  reduceTask,
  taskStateSchema,
} from "@clarkcant/contracts";

import {
  type Database,
  acceptCommand,
  activeGrants,
  appendEvent,
  appendMessage,
  dispositionColumnFor,
  effectsForTask,
  getTask,
  transaction,
  upsertEffect,
  upsertTask,
} from "@clarkcant/storage";

/**
 * Task lifecycle service.
 *
 * The reducer in packages/contracts decides what state a task moves to. This
 * layer is what makes that decision durable, ordered and observable: it writes
 * the state change, the event, and any resulting effect in one transaction, and
 * it refuses the moves that would let the system lie about what happened.
 */

export interface TaskServiceDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
}

export interface CreateTaskInput {
  conversationId: TaskRecord["conversationId"];
  goal: string;
  principal: Principal;
  budget?: TaskRecord["budget"];
}

export function createTask(deps: TaskServiceDeps, input: CreateTaskInput): TaskRecord {
  const at = deps.now();
  const task: TaskRecord = {
    taskId: deps.newId("task") as TaskRecord["taskId"],
    conversationId: input.conversationId,
    homeNodeId: deps.nodeId as TaskRecord["homeNodeId"],
    state: "queued",
    revision: 0,
    goal: input.goal,
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    createdAt: at,
    updatedAt: at,
  };

  withEvent(deps, task, "task.created", { goal: task.goal, principalId: input.principal.principalId }, () => {
    upsertTask(deps.db, task);
  });
  return task;
}

function withEvent(
  deps: TaskServiceDeps,
  task: TaskRecord,
  kind: string,
  payload: Record<string, unknown>,
  write: () => void,
): number {
  return transaction(deps.db, () => {
    write();
    return appendEvent(deps.db, {
      eventId: deps.newId("evt"),
      kind,
      stream: "task",
      nodeId: deps.nodeId,
      conversationId: task.conversationId,
      taskId: task.taskId,
      document: { taskId: task.taskId, state: task.state, revision: task.revision, ...payload },
      occurredAt: deps.now(),
    });
  });
}

export type ApplyEventResult =
  | { ok: true; task: TaskRecord; changed: boolean }
  | { ok: false; code: "ILLEGAL_TRANSITION"; message: string };

/**
 * Apply one lifecycle event to a task, persisting the result.
 *
 * The task row and the event log entry are written in a single transaction. If
 * they could diverge, a crash between them would leave a task whose state the
 * timeline does not explain — the kind of inconsistency that makes recovery
 * guesses rather than reasoning.
 */
export function applyTaskEvent(
  deps: TaskServiceDeps,
  taskId: string,
  event: TaskEvent,
  change: Partial<Pick<TaskRecord, "parkedReason" | "waitingCapabilityRef" | "waitingInstallPlanId" | "executionNodeId" | "activeRunId">> = {},
  /**
   * Extra writes that must land in the same transaction as the state change.
   *
   * Exists so a caller never has to open a second transaction around this one: an
   * external effect marked `unknown` while the task still reads `running` would let
   * the UI show progress for an outcome nobody knows.
   */
  extraWrite?: () => void,
): ApplyEventResult {
  const existing = getTask(deps.db, taskId);
  if (!existing) {
    return {
      ok: false,
      code: "ILLEGAL_TRANSITION",
      message: `task ${taskId} does not exist`,
    };
  }

  const outcome = reduceTask(existing.state, event);
  if (!outcome.ok) {
    return { ok: false, code: "ILLEGAL_TRANSITION", message: outcome.message };
  }

  if (!outcome.changed && Object.keys(change).length === 0) {
    return { ok: true, task: existing, changed: false };
  }

  const at = deps.now();
  const next: TaskRecord = {
    ...existing,
    ...change,
    state: outcome.state,
    revision: existing.revision + 1,
    updatedAt: at,
  };

  withEvent(deps, next, "task.state_changed", { from: existing.state, event }, () => {
    upsertTask(deps.db, next);
    extraWrite?.();
  });

  return { ok: true, task: next, changed: true };
}

/** Task states whose moves are driven by the scheduler rather than by a user. */
export function advanceResolving(
  deps: TaskServiceDeps,
  taskId: string,
  decision:
    | { kind: "needs-input"; prompt: string }
    | { kind: "needs-capability"; capabilityRef: CapabilityRef; installPlanId?: string }
    | { kind: "needs-approval"; approvalId: ApprovalId }
    | { kind: "ready"; executionNodeId: string },
): ApplyEventResult {
  switch (decision.kind) {
    case "needs-input":
      return applyTaskEvent(deps, taskId, "resolve.need_input", { parkedReason: decision.prompt });
    case "needs-capability":
      return applyTaskEvent(deps, taskId, "resolve.need_capability", {
        parkedReason: `waiting for capability ${decision.capabilityRef}`,
        waitingCapabilityRef: decision.capabilityRef,
        ...(decision.installPlanId === undefined ? {} : { waitingInstallPlanId: decision.installPlanId }),
      });
    case "needs-approval":
      return applyTaskEvent(deps, taskId, "resolve.need_approval", {
        parkedReason: `waiting for approval ${decision.approvalId}`,
      });
    case "ready":
      return applyTaskEvent(deps, taskId, "resolve.ready", { executionNodeId: decision.executionNodeId });
  }
}

/* ------------------------------------------------------------------ *
 * Evidence and success
 * ------------------------------------------------------------------ */

/**
 * Record evidence for a run.
 *
 * The schema already refuses a `verified` verdict without a description, so the
 * only thing this adds is the guarantee that a task cannot be marked succeeded
 * while the effect ledger still holds an unsettled row. A clean worker exit is
 * not evidence that an external write landed.
 */
export function recordEvidence(
  deps: TaskServiceDeps,
  input: { taskId: string; evidence: Omit<Evidence, "observedAt"> & { observedAt?: Instant } },
): { evidence: Evidence; blocked: EffectRecord | undefined } {
  const parsed = evidenceSchema.parse({
    ...input.evidence,
    observedAt: input.evidence.observedAt ?? deps.now(),
  });

  const effects = effectsForTask(deps.db, input.taskId);
  const blocked = effects.find(
    (effect) => effect.state === "prepared" || effect.state === "submitted" || effect.state === "unknown",
  );

  const task = getTask(deps.db, input.taskId);
  if (task) {
    withEvent(deps, task, "evidence.recorded", { verdict: parsed.verdict, kind: parsed.kind }, () => {
      deps.db
        .prepare(
          `INSERT INTO evidence (evidence_id, run_id, kind, verdict, summary, ref, digest, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deps.newId("evi"),
          task.activeRunId ?? null,
          parsed.kind,
          parsed.verdict,
          parsed.summary,
          parsed.ref ?? null,
          parsed.digest ?? null,
          parsed.observedAt,
        );
    });
  }

  return { evidence: parsed, blocked };
}

export type SuccessCheck =
  | { allowed: true; evidenceId: string }
  | { allowed: false; code: "NO_EVIDENCE" | "EFFECT_UNSETTLED" | "EVIDENCE_CONTRADICTED"; message: string };

/**
 * Gate the only transition into `succeeded`.
 *
 * This is where the blueprint's "worker idle, LLM turn finished, socket closed is
 * not success" rule becomes executable. There is no path to success that skips
 * this function, and it demands positive evidence with no unsettled effect.
 */
export function checkSuccessPreconditions(
  deps: TaskServiceDeps,
  taskId: string,
  evidence: readonly Evidence[],
): SuccessCheck {
  if (evidence.length === 0) {
    return {
      allowed: false,
      code: "NO_EVIDENCE",
      message: "no evidence recorded; a finished run is not by itself a successful outcome",
    };
  }
  const contradicted = evidence.find((entry) => entry.verdict === "contradicted");
  if (contradicted) {
    return {
      allowed: false,
      code: "EVIDENCE_CONTRADICTED",
      message: `evidence contradicts the expected outcome: ${contradicted.summary}`,
    };
  }
  const verified = evidence.find((entry) => entry.verdict === "verified");
  if (!verified) {
    return {
      allowed: false,
      code: "NO_EVIDENCE",
      message:
        "evidence was recorded but nothing was verified; the result must be reported as not-verified rather than as success",
    };
  }
  const unsettled = effectsForTask(deps.db, taskId).find(
    (effect) => effect.state === "prepared" || effect.state === "submitted" || effect.state === "unknown",
  );
  if (unsettled) {
    return {
      allowed: false,
      code: "EFFECT_UNSETTLED",
      message: `effect ${unsettled.effectId} is still ${unsettled.state}; reconcile it before reporting success`,
    };
  }
  return { allowed: true, evidenceId: verified.ref ?? verified.kind };
}

/* ------------------------------------------------------------------ *
 * Effects
 * ------------------------------------------------------------------ */

export interface PrepareEffectInput {
  taskId: string;
  runId?: string;
  executorNodeId: string;
  category: EffectCategory;
  capabilityRef: CapabilityRef;
  intent: string;
  operationDigest: string;
  externalIdempotencyKey?: string;
  externalSupportsDedup: boolean;
}

export function prepareEffect(deps: TaskServiceDeps, input: PrepareEffectInput): EffectRecord {
  const effect: EffectRecord = {
    effectId: deps.newId("eff") as EffectRecord["effectId"],
    taskId: input.taskId as EffectRecord["taskId"],
    ...(input.runId === undefined ? {} : { runId: input.runId as NonNullable<EffectRecord["runId"]> }),
    executorNodeId: input.executorNodeId as EffectRecord["executorNodeId"],
    category: input.category,
    capabilityRef: input.capabilityRef,
    ...(input.externalIdempotencyKey === undefined
      ? {}
      : { externalIdempotencyKey: input.externalIdempotencyKey }),
    externalSupportsDedup: input.externalSupportsDedup,
    state: "prepared",
    intent: input.intent,
    operationDigest: input.operationDigest,
    preparedAt: deps.now(),
    submitAttempts: 0,
  };
  upsertEffect(deps.db, effect);
  return effect;
}

/**
 * Mark an effect unknown and record the uncertain task state.
 *
 * Both writes happen together: an effect flagged `unknown` while the task still
 * says `running` would let the UI show a task as progressing when its outcome is
 * genuinely undetermined.
 */
export function markEffectUnknown(
  deps: TaskServiceDeps,
  effectId: string,
  reason: string,
): ApplyEventResult {
  const row = deps.db
    .prepare("SELECT task_id, state FROM effects WHERE effect_id = ?")
    .get(effectId) as { task_id: string; state: string } | undefined;
  if (!row) {
    return {
      ok: false,
      code: "ILLEGAL_TRANSITION",
      message: `effect ${effectId} does not exist`,
    };
  }
  // The effect update rides inside applyTaskEvent's transaction rather than opening its
  // own, so the ledger row and the task state cannot diverge if the process dies between
  // them.
  return applyTaskEvent(deps, row.task_id, "effect.unknown", {}, () => {
    deps.db
      .prepare("UPDATE effects SET state = 'unknown', reconciliation_evidence = ? WHERE effect_id = ?")
      .run(reason, effectId);
  });
}

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

export interface AuthorizationRequest {
  capabilityRef: string;
  resource?: ResourceRef & { access: "read" | "write" | "admin" };
  dataClass?: Grant["allowedDataClasses"][number];
  delegationDepth?: number;
}

export type AuthorizationDecision =
  | { allowed: true; grant: Grant }
  | {
      allowed: false;
      code:
        | "UNAUTHENTICATED"
        | "NO_GRANT"
        | "GRANT_EXPIRED"
        | "GRANT_REVOKED"
        | "GRANT_SCOPE_VIOLATION";
      message: string;
    };

/**
 * Authorize an invocation against the sender's live grants.
 *
 * The receiver's own policy is applied separately; this only establishes what the
 * caller was allowed to ask for. Keeping the two apart is what stops a sender
 * from widening its own authority by phrasing a request differently.
 */
export function authorize(
  deps: TaskServiceDeps,
  input: { principal: Principal; senderNodeId: string; request: AuthorizationRequest },
): AuthorizationDecision {
  if (input.principal.kind === "peer-node" && !input.principal.peer) {
    return {
      allowed: false,
      code: "UNAUTHENTICATED",
      message: "a peer principal must carry verified peer identity from the transport",
    };
  }

  const ref = capabilityRefSchema.parse(input.request.capabilityRef);
  const grants = activeGrants(deps.db, input.senderNodeId, deps.now());
  if (grants.length === 0) {
    return {
      allowed: false,
      code: "NO_GRANT",
      message: `no live grant from ${input.senderNodeId}`,
    };
  }

  let lastFailure: AuthorizationDecision | undefined;
  for (const grant of grants) {
    const decision = checkGrant(grant, {
      capabilityRef: ref,
      at: deps.now(),
      ...(input.request.resource === undefined
        ? {}
        : {
            resource: {
              nodeId: input.request.resource.nodeId,
              resourceId: input.request.resource.resourceId,
              kind: input.request.resource.kind,
              access: input.request.resource.access,
            },
          }),
      ...(input.request.dataClass === undefined ? {} : { dataClass: input.request.dataClass }),
      ...(input.request.delegationDepth === undefined
        ? {}
        : { delegationDepth: input.request.delegationDepth }),
    });
    if (decision.allowed) return decision;
    lastFailure = { allowed: false, code: decision.code, message: decision.message };
  }

  return (
    lastFailure ?? {
      allowed: false,
      code: "GRANT_SCOPE_VIOLATION",
      message: "no grant covers this request",
    }
  );
}

/**
 * Whether a delegated task may be re-delegated.
 *
 * A→B→C must not inherit trust from A→B. Depth is carried in the grant and
 * reduced at every hop, so a task started at depth 0 in a depth-2 grant can be
 * forwarded twice and then stops (acceptance test T07).
 */
export function mayDelegateFurther(grant: Grant, currentDepth: number): boolean {
  return currentDepth < grant.maxDelegationDepth;
}

export { appendMessage, acceptCommand };

/**
 * Assert that the storage layer's disposition column still agrees with the contract
 * reducer.
 *
 * The storage layer mirrors the state-to-disposition mapping so that listing tasks for
 * the UI does not have to import the reducer into a query path. Two copies of a mapping
 * need a check rather than a comment, so this is asserted by the test suite; a state
 * added to the contract without updating the mirror fails the build.
 */
export function approveTaskStatesAreConsistent(): boolean {
  for (const state of taskStateSchema.options) {
    if (dispositionColumnFor(state) !== dispositionOf(state)) return false;
  }
  return true;
}
