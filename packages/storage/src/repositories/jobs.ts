import {
  canTransitionJob,
  isOpenJobStatus,
  jobProgressSchema,
  jobRecordSchema,
  type JobOwner,
  type JobProgress,
  type JobRecord,
  type JobStatus,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow } from "../db.ts";

interface JobRow {
  job_id: string;
  node_id: string;
  owner_principal_id: string;
  conversation_id: string | null;
  instance_id: string;
  action_binding_id: string;
  package_id: string;
  package_generation: string;
  capability_ref: string;
  effect_category: string;
  status: JobStatus;
  progress_current: number | null;
  progress_total: number | null;
  progress_message: string | null;
  result_refs: string;
  output: string | null;
  error: string | null;
  node_boot_id: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

function fromRow(row: JobRow): JobRecord {
  const refs = JSON.parse(row.result_refs) as unknown;
  return jobRecordSchema.parse({
    jobId: row.job_id,
    nodeId: row.node_id,
    ownerPrincipalId: row.owner_principal_id,
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    instanceId: row.instance_id,
    actionBindingId: row.action_binding_id,
    packageId: row.package_id,
    packageGeneration: row.package_generation,
    capabilityRef: row.capability_ref,
    effectCategory: row.effect_category,
    status: row.status,
    ...(row.progress_current === null
      ? {}
      : { progress: { current: Number(row.progress_current), ...(row.progress_total === null ? {} : { total: Number(row.progress_total) }), ...(row.progress_message === null ? {} : { message: row.progress_message }) } }),
    resultRefs: refs,
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  });
}

export function insertJob(db: Database, record: JobRecord & { nodeBootId: string }): void {
  const { nodeBootId, ...snapshot } = record;
  const job = jobRecordSchema.parse(snapshot);
  db.prepare(
    `INSERT INTO jobs (job_id, node_id, owner_principal_id, conversation_id, instance_id, action_binding_id, package_id,
      package_generation, capability_ref, effect_category, status, result_refs, output, node_boot_id, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.jobId, job.nodeId, job.ownerPrincipalId, job.conversationId ?? null, job.instanceId, job.actionBindingId,
    job.packageId, job.packageGeneration, job.capabilityRef, job.effectCategory, job.status, JSON.stringify(job.resultRefs), job.output ?? null,
    nodeBootId, job.createdAt, job.startedAt ?? null, job.endedAt ?? null,
  );
}

export function getJob(db: Database, jobId: string): JobRecord | undefined {
  const row = oneRow<JobRow>(db, "SELECT * FROM jobs WHERE job_id = ?", jobId);
  return row === undefined ? undefined : fromRow(row);
}

/** A copied JobRef is insufficient: principal, frame instance, fixed binding and generation must all match. */
export function getOwnedJob(db: Database, jobId: string, owner: JobOwner): JobRecord | undefined {
  const row = oneRow<JobRow>(
    db,
    `SELECT * FROM jobs WHERE job_id = ? AND owner_principal_id = ? AND instance_id = ?
      AND action_binding_id = ? AND package_generation = ?`,
    jobId, owner.ownerPrincipalId, owner.instanceId, owner.actionBindingId, owner.packageGeneration,
  );
  return row === undefined ? undefined : fromRow(row);
}

export function listOpenJobs(db: Database, nodeId: string, excludeBootId?: string): JobRecord[] {
  return allRows<JobRow>(
    db,
    "SELECT * FROM jobs WHERE node_id = ? AND status IN ('queued', 'running', 'waiting') AND (? IS NULL OR node_boot_id <> ?) ORDER BY created_at, rowid",
    nodeId, excludeBootId ?? null, excludeBootId ?? null,
  ).map(fromRow);
}

/** Progress is service-originated, bounded and monotonic; stale or malformed reports are refused. */
export function updateJobProgress(db: Database, input: { jobId: string; progress: JobProgress; at: string }): boolean {
  const checked = jobProgressSchema.safeParse(input.progress);
  if (!checked.success) return false;
  const progress = checked.data;
  const result = db.prepare(
    `UPDATE jobs SET status = 'running', progress_current = ?, progress_total = COALESCE(progress_total, ?), progress_message = ?,
      started_at = COALESCE(started_at, ?)
     WHERE job_id = ? AND status IN ('queued', 'running', 'waiting')
       AND (progress_current IS NULL OR progress_current <= ?)
       AND (progress_total IS NULL OR progress_total >= ?)
       AND (progress_total IS NULL OR ? IS NULL OR progress_total = ?)`,
  ).run(progress.current, progress.total ?? null, progress.message ?? null, input.at, input.jobId,
    progress.current, progress.current, progress.total ?? null, progress.total ?? null);
  return Number(result.changes) > 0;
}

export function transitionJob(db: Database, input: {
  jobId: string;
  status: JobStatus;
  at: string;
  resultRefs?: JobRecord["resultRefs"];
  output?: string;
  error?: string;
}): boolean {
  const current = getJob(db, input.jobId);
  if (current === undefined || !canTransitionJob(current.status, input.status)) return false;
  if (input.status !== "completed" && (input.resultRefs?.length ?? 0) > 0) {
    throw new Error("only a completed job may contain result artifacts");
  }
  const parsed = jobRecordSchema.shape.resultRefs.parse(input.resultRefs ?? current.resultRefs);
  const output = jobRecordSchema.shape.output.parse(input.output);
  const terminal = !isOpenJobStatus(input.status);
  const result = db.prepare(
    `UPDATE jobs SET status = ?, result_refs = ?, output = ?, error = ?, ended_at = ?, started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END
     WHERE job_id = ? AND status = ?`,
  ).run(input.status, JSON.stringify(parsed), output ?? null, input.error ?? null, terminal ? input.at : null,
    input.status, input.at, input.jobId, current.status);
  return Number(result.changes) > 0;
}

/** A prior process's live request cannot be resumed: mark it failed and leave effect reconciliation to the ledger. */
export function failInterruptedJobs(db: Database, input: { nodeId: string; currentBootId: string; at: string }): number {
  const result = db.prepare(
    `UPDATE jobs SET status = 'failed', error = 'The service stopped when the node restarted; it may have completed its effect. Review the service before retrying.', ended_at = ?
     WHERE node_id = ? AND node_boot_id <> ? AND status IN ('queued', 'running', 'waiting')`,
  ).run(input.at, input.nodeId, input.currentBootId);
  return Number(result.changes);
}
