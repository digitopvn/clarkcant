import type { Instant } from "@clarkcant/contracts";

import type { Database } from "./db.ts";

/**
 * What this node did, written down as it happens.
 *
 * The audit trail answers the question asked after something surprising: what ran, when, and how it ended. It is
 * deliberately shallow — five fields and a reference — because a record that holds arguments, output or a
 * transcript would be a second copy of everything the rest of this design works to keep out of one place. A secret
 * that appears in the audit is a secret that has leaked, so nothing here ever takes a value.
 *
 * Append-only in practice: nothing in this module updates or deletes a row, and `listAuditEvents` is the only reader.
 */

export type AuditKind = "command" | "secret-use" | "approval" | "stop" | "interaction" | "policy";
export type AuditOutcome = "done" | "failed" | "refused" | "stopped";

export interface AuditEvent {
  auditId: string;
  principalId: string;
  nodeId?: string;
  at: Instant;
  kind: AuditKind;
  /** What happened, in one line a person can read months later. Never a secret, never a dump. */
  summary: string;
  outcome: AuditOutcome;
  /** The id of the thing this is about — a run, an approval, a secret by name. */
  ref?: string;
}

interface AuditRow {
  audit_id: string;
  principal_id: string;
  node_id: string | null;
  at: string;
  kind: string;
  summary: string;
  outcome: string;
  ref: string | null;
}

export function appendAuditEvent(
  db: Database,
  input: {
    auditId: string;
    principalId: string;
    kind: AuditKind;
    summary: string;
    outcome: AuditOutcome;
    at: Instant;
    nodeId?: string;
    ref?: string;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (audit_id, principal_id, node_id, at, kind, summary, outcome, ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.auditId,
    input.principalId,
    input.nodeId ?? null,
    input.at,
    input.kind,
    // Bounded here rather than at every call site: a summary that grew to a document would be a summary that
    // stopped being readable, and the length is the one thing a caller cannot be trusted to remember.
    input.summary.slice(0, 500),
    input.outcome,
    input.ref ?? null,
  );
}

/**
 * The most recent events, newest first.
 *
 * Ordered by the recorded time and then by insertion, because two events inside the same millisecond are common
 * during a stop and a reader needs them in the order they happened.
 */
export function listAuditEvents(
  db: Database,
  principalId: string,
  options: { limit?: number } = {},
): AuditEvent[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
  const rows = db
    .prepare("SELECT * FROM audit_log WHERE principal_id = ? ORDER BY at DESC, rowid DESC LIMIT ?")
    .all(principalId, limit);
  // SAFETY: the driver types every column as `SQLOutputValue` because SQLite has no static schema. These rows come
  // from the table this package's own migration created, and each field is read through the mapping below rather
  // than trusted.
  return (rows as unknown as AuditRow[]).map((row) => ({
    auditId: row.audit_id,
    principalId: row.principal_id,
    ...(row.node_id === null ? {} : { nodeId: row.node_id }),
    at: row.at as Instant,
    kind: row.kind as AuditKind,
    summary: row.summary,
    outcome: row.outcome as AuditOutcome,
    ...(row.ref === null ? {} : { ref: row.ref }),
  }));
}
