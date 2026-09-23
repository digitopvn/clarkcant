import {
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Worker session files
 * ------------------------------------------------------------------ */

export interface SessionFileRecord {
  sessionId: string;
  nodeId: string;
  principalId: string;
  taskId: string | undefined;
  conversationId: string | undefined;
  /** Absolute path to the JSONL transcript. Never a URL, never a remote location. */
  path: string;
  byteSize: number;
  /** Byte offset already ingested into the history index. */
  ingestCursor: number;
  lastIngestedAt: string | undefined;
  createdAt: string;
  updatedAt: string;
}

/**
 * Record where a worker session's transcript lives.
 *
 * A row is written when the session is created rather than when it ends: a worker that is killed
 * mid-run still leaves a transcript, and a session whose file was never indexed is a session that
 * cannot be searched afterwards.
 */
export function upsertSessionFile(db: Database, input: SessionFileRecord): void {
  db.prepare(
    `INSERT INTO session_files
       (session_id, node_id, principal_id, task_id, conversation_id, path, byte_size, ingest_cursor,
        last_ingested_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       path = excluded.path,
       byte_size = excluded.byte_size,
       updated_at = excluded.updated_at`,
  ).run(
    input.sessionId,
    input.nodeId,
    input.principalId,
    input.taskId ?? null,
    input.conversationId ?? null,
    input.path,
    input.byteSize,
    input.ingestCursor,
    input.lastIngestedAt ?? null,
    input.createdAt,
    input.updatedAt,
  );
}

export function getSessionFile(db: Database, sessionId: string): SessionFileRecord | undefined {
  const row = oneRow<Record<string, unknown>>(
    db,
    "SELECT * FROM session_files WHERE session_id = ?",
    sessionId,
  );
  return row === undefined ? undefined : mapSessionFile(row);
}

export function listSessionFiles(
  db: Database,
  filter: { principalId?: string; taskId?: string; conversationId?: string; limit?: number } = {},
): SessionFileRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.principalId !== undefined) {
    clauses.push("principal_id = ?");
    params.push(filter.principalId);
  }
  if (filter.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(filter.taskId);
  }
  if (filter.conversationId !== undefined) {
    clauses.push("conversation_id = ?");
    params.push(filter.conversationId);
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const rows = allRows<Record<string, unknown>>(
    db,
    `SELECT * FROM session_files${where} ORDER BY created_at DESC LIMIT ?`,
    ...params,
    filter.limit ?? 200,
  );
  return rows.map(mapSessionFile);
}

/**
 * Advance the ingest cursor.
 *
 * Takes an absolute offset rather than adding to the stored one, so a retried batch that ingested
 * the same bytes twice cannot skip a later batch by moving the cursor twice.
 */
export function advanceSessionIngestCursor(
  db: Database,
  input: { sessionId: string; cursor: number; byteSize?: number; at: Instant },
): boolean {
  const result = db
    .prepare(
      `UPDATE session_files
          SET ingest_cursor = ?, byte_size = COALESCE(?, byte_size), last_ingested_at = ?, updated_at = ?
        WHERE session_id = ? AND ingest_cursor <= ?`,
    )
    .run(
      input.cursor,
      input.byteSize ?? null,
      input.at,
      input.at,
      input.sessionId,
      input.cursor,
    );
  return Number(result.changes) > 0;
}

function mapSessionFile(row: Record<string, unknown>): SessionFileRecord {
  return {
    sessionId: String(row.session_id),
    nodeId: String(row.node_id),
    principalId: String(row.principal_id),
    taskId: row.task_id === null ? undefined : String(row.task_id),
    conversationId: row.conversation_id === null ? undefined : String(row.conversation_id),
    path: String(row.path),
    byteSize: Number(row.byte_size),
    ingestCursor: Number(row.ingest_cursor),
    lastIngestedAt: row.last_ingested_at === null ? undefined : String(row.last_ingested_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
