import {
  type ApprovalId,
  type Instant,
  type LeaseId,
  type Principal,
  type RunId,
  type TaskId,
  approvalIdSchema,
  leaseIdSchema,
  nowInstant,
} from "@clarkcant/contracts";

import { type Database, oneRow, parseJson, toJson, transaction } from "@clarkcant/storage";

/**
 * Coordination primitives: resource leases, fencing epochs, idempotent
 * invocations, and approvals.
 *
 * These are grouped because they answer the same question from different angles:
 * who is allowed to act on a shared thing right now, and how do we know a stale
 * actor cannot act anyway.
 *
 * A lease is a mutual-exclusion device between cooperating processes. It is
 * explicitly not a sandbox: it cannot stop a shell script that already holds OS
 * permissions. The blueprint requires that distinction to be stated rather than
 * implied, so it is stated here and in the docs.
 */

export interface CoordinationDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
}

/* ------------------------------------------------------------------ *
 * Leases
 * ------------------------------------------------------------------ */

export interface LeaseRecord {
  leaseId: LeaseId;
  resourceNodeId: string;
  resourceId: string;
  resourceKind: string;
  holderRunId?: RunId;
  holderTaskId?: TaskId;
  epoch: number;
  acquiredAt: Instant;
  expiresAt: Instant;
}

export type AcquireResult =
  | { ok: true; lease: LeaseRecord }
  | { ok: false; code: "LEASE_HELD"; heldByRunId: string | undefined; expiresAt: string }
  | { ok: false; code: "EPOCH_REGRESSION"; message: string };

/**
 * Acquire exclusive use of one resource.
 *
 * The epoch is monotonic per resource and never reused, which is what makes
 * fencing work: a holder whose epoch is behind the current one must not act, even
 * if it still believes it holds the lease. The partial unique index on live
 * leases is the actual mutual exclusion; this function only decides the epoch and
 * reports the conflict in a form the UI can explain.
 */
export function acquireLease(
  deps: CoordinationDeps,
  input: {
    resourceNodeId: string;
    resourceId: string;
    resourceKind: string;
    holderRunId?: RunId;
    holderTaskId?: TaskId;
    ttlMs: number;
  },
): AcquireResult {
  return transaction(deps.db, () => {
    const at = deps.now();

    const live = oneRow<{ lease_id: string; holder_run_id: string | null; expires_at: string }>(
      deps.db,
      `SELECT lease_id, holder_run_id, expires_at FROM leases
        WHERE resource_node_id = ? AND resource_id = ? AND resource_kind = ? AND released_at IS NULL`,
      input.resourceNodeId,
      input.resourceId,
      input.resourceKind,
    );

    if (live) {
      // An expired lease is reclaimed rather than blocking forever; a crashed
      // holder must not be able to wedge a resource permanently.
      if (new Date(live.expires_at).getTime() > new Date(at).getTime()) {
        return {
          ok: false as const,
          code: "LEASE_HELD" as const,
          heldByRunId: live.holder_run_id ?? undefined,
          expiresAt: live.expires_at,
        };
      }
      deps.db.prepare("UPDATE leases SET released_at = ? WHERE lease_id = ?").run(at, live.lease_id);
    }

    const epochRow = oneRow<{ current_epoch: number }>(
      deps.db,
      "SELECT current_epoch FROM leases_epochs WHERE resource_node_id = ? AND resource_id = ?",
      input.resourceNodeId,
      input.resourceId,
    );
    const nextEpoch = Number(epochRow?.current_epoch ?? 0) + 1;

    if (epochRow) {
      deps.db
        .prepare("UPDATE leases_epochs SET current_epoch = ?, updated_at = ? WHERE resource_node_id = ? AND resource_id = ?")
        .run(nextEpoch, at, input.resourceNodeId, input.resourceId);
    } else {
      deps.db
        .prepare("INSERT INTO leases_epochs (resource_node_id, resource_id, current_epoch, updated_at) VALUES (?, ?, ?, ?)")
        .run(input.resourceNodeId, input.resourceId, nextEpoch, at);
    }

    const lease: LeaseRecord = {
      leaseId: leaseIdSchema.parse(deps.newId("lease")),
      resourceNodeId: input.resourceNodeId,
      resourceId: input.resourceId,
      resourceKind: input.resourceKind,
      ...(input.holderRunId === undefined ? {} : { holderRunId: input.holderRunId }),
      ...(input.holderTaskId === undefined ? {} : { holderTaskId: input.holderTaskId }),
      epoch: nextEpoch,
      acquiredAt: at,
      expiresAt: new Date(new Date(at).getTime() + input.ttlMs).toISOString() as Instant,
    };

    deps.db
      .prepare(
        `INSERT INTO leases
           (lease_id, resource_node_id, resource_id, resource_kind, holder_run_id, holder_task_id, epoch, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lease.leaseId,
        lease.resourceNodeId,
        lease.resourceId,
        lease.resourceKind,
        lease.holderRunId ?? null,
        lease.holderTaskId ?? null,
        lease.epoch,
        lease.acquiredAt,
        lease.expiresAt,
      );

    return { ok: true as const, lease };
  });
}

export function currentEpoch(deps: CoordinationDeps, resourceNodeId: string, resourceId: string): number {
  const row = oneRow<{ current_epoch: number }>(
    deps.db,
    "SELECT current_epoch FROM leases_epochs WHERE resource_node_id = ? AND resource_id = ?",
    resourceNodeId,
    resourceId,
  );
  return Number(row?.current_epoch ?? 0);
}

export function releaseLease(deps: CoordinationDeps, leaseId: LeaseId): boolean {
  const result = deps.db
    .prepare("UPDATE leases SET released_at = ? WHERE lease_id = ? AND released_at IS NULL")
    .run(deps.now(), leaseId);
  return Number(result.changes) > 0;
}

/**
 * Whether a holder may still act.
 *
 * This is the fencing check. A run carrying epoch 3 while the resource has moved
 * to epoch 4 has been superseded — most likely because its lease expired and
 * someone else took over — and must stop rather than write into a resource it no
 * longer owns.
 */
export function mayActUnderLease(
  deps: CoordinationDeps,
  input: { resourceNodeId: string; resourceId: string; heldEpoch: number },
): { allowed: true } | { allowed: false; code: "STALE_LEASE_EPOCH"; message: string } {
  const epoch = currentEpoch(deps, input.resourceNodeId, input.resourceId);
  if (input.heldEpoch < epoch) {
    return {
      allowed: false,
      code: "STALE_LEASE_EPOCH",
      message: `holder carries epoch ${input.heldEpoch} but the resource is at epoch ${epoch}; this holder has been fenced out`,
    };
  }
  return { allowed: true };
}

/* ------------------------------------------------------------------ *
 * Idempotent invocations
 * ------------------------------------------------------------------ */

export type InvocationOutcome =
  | { status: "accepted"; invocationId: string }
  | { status: "duplicate"; invocationId: string; recordedOutcome: string };

/**
 * Record a user-triggered invocation exactly once.
 *
 * A double click, a key repeat, or a retried HTTP request all present the same
 * client-generated `invocationId`. The primary key turns the second attempt into a
 * lookup of the first outcome instead of a second effect (acceptance test T43).
 */
export function recordInvocation(
  deps: CoordinationDeps,
  input: { invocationId: string; actionBindingId: string; instanceId: string; outcome: string },
): InvocationOutcome {
  return transaction(deps.db, () => {
    const existing = oneRow<{ outcome: string }>(
      deps.db,
      "SELECT outcome FROM action_invocations WHERE invocation_id = ?",
      input.invocationId,
    );
    if (existing) {
      return { status: "duplicate" as const, invocationId: input.invocationId, recordedOutcome: existing.outcome };
    }
    deps.db
      .prepare(
        "INSERT INTO action_invocations (invocation_id, action_binding_id, instance_id, outcome, recorded_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.invocationId, input.actionBindingId, input.instanceId, input.outcome, deps.now());
    return { status: "accepted" as const, invocationId: input.invocationId };
  });
}

/** Check an invocation before doing work, so a duplicate short-circuits early. */
export function lookupInvocation(
  deps: CoordinationDeps,
  invocationId: string,
): { found: false } | { found: true; outcome: string } {
  const row = oneRow<{ outcome: string }>(
    deps.db,
    "SELECT outcome FROM action_invocations WHERE invocation_id = ?",
    invocationId,
  );
  return row ? { found: true, outcome: row.outcome } : { found: false };
}

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

export interface ApprovalRecord {
  approvalId: ApprovalId;
  taskId?: string;
  effectId?: string;
  operationDigest: string;
  operationDescription: string;
  effectCategory: string;
  targetNodeId?: string;
  account?: string;
  decider: "user";
  decision: "pending" | "granted" | "denied" | "expired";
  requestedAt: Instant;
  expiresAt: Instant;
  decidedAt?: Instant;
}

export function requestApproval(
  deps: CoordinationDeps,
  input: {
    taskId?: string;
    effectId?: string;
    operationDigest: string;
    operationDescription: string;
    effectCategory: string;
    targetNodeId?: string;
    account?: string;
    ttlMs: number;
  },
): ApprovalRecord {
  const at = deps.now();
  const approval: ApprovalRecord = {
    approvalId: approvalIdSchema.parse(deps.newId("appr")),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.effectId === undefined ? {} : { effectId: input.effectId }),
    operationDigest: input.operationDigest,
    operationDescription: input.operationDescription,
    effectCategory: input.effectCategory,
    ...(input.targetNodeId === undefined ? {} : { targetNodeId: input.targetNodeId }),
    ...(input.account === undefined ? {} : { account: input.account }),
    // The model is never the decider. Typed as a literal so a caller cannot pass
    // anything else even by accident.
    decider: "user",
    decision: "pending",
    requestedAt: at,
    expiresAt: new Date(new Date(at).getTime() + input.ttlMs).toISOString() as Instant,
  };

  deps.db
    .prepare(
      `INSERT INTO approvals
         (approval_id, task_id, effect_id, operation_digest, operation_description, effect_category,
          target_node_id, account, decider, decision, requested_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      approval.approvalId,
      approval.taskId ?? null,
      approval.effectId ?? null,
      approval.operationDigest,
      approval.operationDescription,
      approval.effectCategory,
      approval.targetNodeId ?? null,
      approval.account ?? null,
      approval.decider,
      approval.decision,
      approval.requestedAt,
      approval.expiresAt,
    );

  return approval;
}

export type ApprovalDecision =
  | { ok: true; approval: ApprovalRecord }
  | {
      ok: false;
      code: "APPROVAL_EXPIRED" | "APPROVAL_FORGED" | "APPROVAL_ALREADY_DECIDED" | "NOT_HOME_AUTHORITY";
      message: string;
    };

/**
 * Decide a pending approval.
 *
 * `decidingPrincipal` must be a user principal that came from the authenticated
 * transport. Re-checking that here, rather than trusting the caller, is what keeps
 * the conductor's own tools from ever being able to approve their own effect
 * (acceptance test T41's sibling: forged approvals).
 */
export function decideApproval(
  deps: CoordinationDeps,
  input: {
    approvalId: string;
    decision: "granted" | "denied";
    decidingPrincipal: Principal;
    /** Digest the approver actually saw, so an approved plan cannot be swapped. */
    seenOperationDigest: string;
  },
): ApprovalDecision {
  return transaction(deps.db, () => {
    if (input.decidingPrincipal.kind !== "user") {
      return {
        ok: false as const,
        code: "APPROVAL_FORGED" as const,
        message: `principal kind ${input.decidingPrincipal.kind} may not decide an approval; only a user principal can`,
      };
    }

    const row = oneRow<Record<string, unknown>>(
      deps.db,
      "SELECT * FROM approvals WHERE approval_id = ?",
      input.approvalId,
    );
    if (!row) {
      return {
        ok: false as const,
        code: "APPROVAL_FORGED" as const,
        message: "approval does not exist",
      };
    }

    const decision = String(row.decision);
    if (decision !== "pending") {
      return {
        ok: false as const,
        code: "APPROVAL_ALREADY_DECIDED" as const,
        message: `approval was already ${decision}`,
      };
    }

    const expiresAt = String(row.expires_at) as Instant;
    if (new Date(deps.now()).getTime() >= new Date(expiresAt).getTime()) {
      deps.db.prepare("UPDATE approvals SET decision = 'expired' WHERE approval_id = ?").run(input.approvalId);
      return {
        ok: false as const,
        code: "APPROVAL_EXPIRED" as const,
        message: `approval expired at ${expiresAt}`,
      };
    }

    const storedDigest = String(row.operation_digest);
    if (storedDigest !== input.seenOperationDigest) {
      return {
        ok: false as const,
        code: "APPROVAL_FORGED" as const,
        message:
          "the digest the approver saw does not match the stored operation; the plan changed after it was displayed",
      };
    }

    const decidedAt = deps.now();

    /*
     * Only the conversation's home authority decides.
     *
     * The case the requirement names is an executor that needs an approval while the home is out of reach: it must
     * wait rather than approve its own work. An approval carries the task it belongs to, the task carries its
     * conversation, and the conversation carries the home node - so the refusal is the same whether the home is
     * merely elsewhere or actually unreachable, which is what lets it hold without a reachability probe this phase
     * does not have.
     */
    const approvingTask = row.task_id === null || row.task_id === undefined ? undefined : String(row.task_id);
    if (approvingTask !== undefined) {
      const authority = oneRow<{ home_node_id: string }>(
        deps.db,
        "SELECT authority.home_node_id AS home_node_id FROM tasks JOIN conversation_authority AS authority ON authority.conversation_id = tasks.conversation_id WHERE tasks.task_id = ?",
        approvingTask,
      );
      if (authority !== undefined && authority.home_node_id !== deps.nodeId) {
        return {
          ok: false as const,
          code: "NOT_HOME_AUTHORITY" as const,
          message: `node ${deps.nodeId} is not the home authority for that conversation (${authority.home_node_id}), so it waits rather than approving`,
        };
      }
    }

    deps.db
      .prepare("UPDATE approvals SET decision = ?, decided_at = ? WHERE approval_id = ?")
      .run(input.decision, decidedAt, input.approvalId);

    return {
      ok: true as const,
      approval: {
        approvalId: approvalIdSchema.parse(String(row.approval_id)),
        ...(row.task_id === null ? {} : { taskId: String(row.task_id) }),
        ...(row.effect_id === null ? {} : { effectId: String(row.effect_id) }),
        operationDigest: storedDigest,
        operationDescription: String(row.operation_description),
        effectCategory: String(row.effect_category),
        ...(row.target_node_id === null ? {} : { targetNodeId: String(row.target_node_id) }),
        ...(row.account === null ? {} : { account: String(row.account) }),
        decider: "user" as const,
        decision: input.decision,
        requestedAt: String(row.requested_at) as Instant,
        expiresAt,
        decidedAt,
      },
    };
  });
}

/**
 * Whether an approval still authorizes an execution.
 *
 * An approval is bound to one operation digest. Re-using it for a different
 * operation — even one that looks similar — is refused, which is the
 * "old task approval is not permanent for a pinned widget" rule.
 */
export function approvalAuthorizes(
  deps: CoordinationDeps,
  approvalId: ApprovalId,
  operationDigest: string,
): { authorized: true } | { authorized: false; reason: string } {
  const row = oneRow<{ decision: string; operation_digest: string; expires_at: string }>(
    deps.db,
    "SELECT decision, operation_digest, expires_at FROM approvals WHERE approval_id = ?",
    approvalId,
  );
  if (!row) return { authorized: false, reason: "approval not found" };
  if (row.decision !== "granted") return { authorized: false, reason: `approval is ${row.decision}` };
  if (row.operation_digest !== operationDigest) {
    return { authorized: false, reason: "approval was granted for a different operation digest" };
  }
  if (new Date(deps.now()).getTime() >= new Date(row.expires_at).getTime()) {
    return { authorized: false, reason: "approval has expired" };
  }
  return { authorized: true };
}

/* ------------------------------------------------------------------ *
 * Emergency stop
 * ------------------------------------------------------------------ */

/**
 * Record a local emergency stop.
 *
 * Stored on the node that is being controlled rather than on the node that
 * requested control, so a network partition cannot prevent a local stop from
 * taking effect (acceptance test T59).
 */
export function requestEmergencyStop(
  deps: CoordinationDeps,
  input: { scope: "all" | "automation" | "voice" | "execution"; reason: string },
): void {
  deps.db
    .prepare(
      `INSERT INTO emergency_stops (node_id, scope, requested_at, reason)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET scope = excluded.scope, requested_at = excluded.requested_at, reason = excluded.reason`,
    )
    .run(deps.nodeId, input.scope, deps.now(), input.reason);
}

export function emergencyStopActive(
  deps: CoordinationDeps,
): { active: false } | { active: true; scope: string; requestedAt: string; reason: string } {
  const row = oneRow<{ scope: string; requested_at: string; reason: string }>(
    deps.db,
    "SELECT scope, requested_at, reason FROM emergency_stops WHERE node_id = ?",
    deps.nodeId,
  );
  if (!row) return { active: false };
  return { active: true, scope: row.scope, requestedAt: row.requested_at, reason: row.reason };
}

export function clearEmergencyStop(deps: CoordinationDeps): void {
  deps.db.prepare("DELETE FROM emergency_stops WHERE node_id = ?").run(deps.nodeId);
}

export { nowInstant, parseJson, toJson, approvalIdSchema };
