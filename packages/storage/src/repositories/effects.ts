import {
  type EffectRecord,
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Effects
 * ------------------------------------------------------------------ */

export function upsertEffect(db: Database, effect: EffectRecord): void {
  db.prepare(
    `INSERT INTO effects
       (effect_id, task_id, run_id, executor_node_id, category, capability_ref,
        external_idempotency_key, external_supports_dedup, state, intent, operation_digest,
        prepared_at, submitted_at, settled_at, resolution, reconciliation_evidence, submit_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(effect_id) DO UPDATE SET
       state = excluded.state,
       submitted_at = excluded.submitted_at,
       settled_at = excluded.settled_at,
       resolution = excluded.resolution,
       reconciliation_evidence = excluded.reconciliation_evidence,
       submit_attempts = excluded.submit_attempts`,
  ).run(
    effect.effectId,
    effect.taskId,
    effect.runId ?? null,
    effect.executorNodeId,
    effect.category,
    effect.capabilityRef,
    effect.externalIdempotencyKey ?? null,
    effect.externalSupportsDedup ? 1 : 0,
    effect.state,
    effect.intent,
    effect.operationDigest,
    effect.preparedAt,
    effect.submittedAt ?? null,
    effect.settledAt ?? null,
    effect.resolution ?? null,
    effect.reconciliationEvidence ?? null,
    effect.submitAttempts,
  );
}

/** One effect by its id, or nothing when this node has no such row. */
export function getEffect(db: Database, effectId: string): EffectRecord | undefined {
  const [row] = allRows<Record<string, unknown>>(db, "SELECT * FROM effects WHERE effect_id = ?", effectId);
  return row === undefined ? undefined : effectFromRow(row);
}

export function effectsForTask(db: Database, taskId: string): EffectRecord[] {
  return allRows<Record<string, unknown>>(db, "SELECT * FROM effects WHERE task_id = ? ORDER BY prepared_at", taskId).map(
    effectFromRow,
  );
}

function effectFromRow(row: Record<string, unknown>): EffectRecord {
  return {
    effectId: String(row.effect_id) as EffectRecord["effectId"],
    taskId: String(row.task_id) as EffectRecord["taskId"],
    ...(row.run_id === null ? {} : { runId: String(row.run_id) as NonNullable<EffectRecord["runId"]> }),
    executorNodeId: String(row.executor_node_id) as EffectRecord["executorNodeId"],
    category: String(row.category) as EffectRecord["category"],
    capabilityRef: String(row.capability_ref) as EffectRecord["capabilityRef"],
    ...(row.external_idempotency_key === null
      ? {}
      : { externalIdempotencyKey: String(row.external_idempotency_key) }),
    externalSupportsDedup: Number(row.external_supports_dedup) === 1,
    state: String(row.state) as EffectRecord["state"],
    intent: String(row.intent),
    operationDigest: String(row.operation_digest),
    preparedAt: String(row.prepared_at) as EffectRecord["preparedAt"],
    ...(row.submitted_at === null ? {} : { submittedAt: String(row.submitted_at) as Instant }),
    ...(row.settled_at === null ? {} : { settledAt: String(row.settled_at) as Instant }),
    ...(row.resolution === null ? {} : { resolution: String(row.resolution) as NonNullable<EffectRecord["resolution"]> }),
    ...(row.reconciliation_evidence === null
      ? {}
      : { reconciliationEvidence: String(row.reconciliation_evidence) }),
    submitAttempts: Number(row.submit_attempts),
  };
}

/**
 * Effects whose outcome is undetermined, for the reconciliation queue (T05).
 *
 * Only the unsettled rows themselves: a task with one unknown push and one confirmed one has one effect to reconcile,
 * and counting its settled siblings would report work that is already done.
 */
export function unsettledEffects(db: Database, nodeId: string): EffectRecord[] {
  return allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM effects WHERE executor_node_id = ? AND state IN ('prepared','submitted','unknown') ORDER BY prepared_at",
    nodeId,
  ).map(effectFromRow);
}

/** Effects this node executed whose outcome is `unknown`, prepared at or after `since`, oldest first. */
export function unknownEffectsSince(db: Database, nodeId: string, since: Instant): EffectRecord[] {
  return allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM effects WHERE executor_node_id = ? AND state = 'unknown' AND prepared_at >= ? ORDER BY prepared_at",
    nodeId,
    since,
  ).map(effectFromRow);
}

/**
 * Whether a conversation holds an effect for this capability and operation whose outcome nobody knows yet: handed off
 * and not settled (`submitted`), or settled as `unknown` and not yet answered by the person. A caller that must never
 * repeat an action of unknown outcome refuses a second one while this is true.
 */
export function hasUnsettledEffect(
  db: Database,
  input: { conversationId: string; capabilityRef: string; operationDigest: string },
): boolean {
  return (
    allRows<Record<string, unknown>>(
      db,
      `SELECT 1 AS found FROM effects e JOIN tasks t ON t.task_id = e.task_id
        WHERE t.conversation_id = ? AND e.capability_ref = ? AND e.operation_digest = ? AND e.state IN ('submitted','unknown')
        LIMIT 1`,
      input.conversationId,
      input.capabilityRef,
      input.operationDigest,
    ).length > 0
  );
}
