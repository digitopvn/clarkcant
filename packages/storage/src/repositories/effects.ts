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

export function effectsForTask(db: Database, taskId: string): EffectRecord[] {
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM effects WHERE task_id = ? ORDER BY prepared_at",
    taskId,
  );
  return rows.map((row) => ({
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
  }));
}

/** Effects whose outcome is undetermined, for the reconciliation queue (T05). */
export function unsettledEffects(db: Database, nodeId: string): EffectRecord[] {
  const rows = allRows<{ task_id: string }>(
    db,
    "SELECT DISTINCT task_id FROM effects WHERE executor_node_id = ? AND state IN ('prepared','submitted','unknown')",
    nodeId,
  );
  return rows.flatMap((row) => effectsForTask(db, row.task_id));
}
