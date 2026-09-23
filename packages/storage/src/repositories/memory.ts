import { type Database, allRows, oneRow } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Memory
 *
 * One row is a sentence the agent chose to keep, and the conversation
 * it was learned in. Deletion is real, because the Memory tab promises
 * that what somebody removes is gone rather than hidden.
 * ------------------------------------------------------------------ */

export interface MemoryRecordInput {
  memoryId: string;
  principalId: string;
  conversationId: string;
  sourceMessageId?: string;
  kind: string;
  scope: string;
  text: string;
  at: string;
}

export function insertMemoryRecord(db: Database, record: MemoryRecordInput): void {
  db.prepare(
    `INSERT INTO memory_records
       (memory_id, principal_id, conversation_id, source_message_id, kind, scope, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.memoryId,
    record.principalId,
    record.conversationId,
    record.sourceMessageId ?? null,
    record.kind,
    record.scope,
    record.text,
    record.at,
  );
}

interface MemoryRow extends Record<string, unknown> {
  memory_id: string;
  conversation_id: string;
  source_message_id: string | null;
  kind: string;
  scope: string;
  text: string;
  created_at: string;
}

function toMemoryRecord(row: MemoryRow): MemoryRecordInput & { memoryId: string } {
  return {
    memoryId: String(row.memory_id),
    principalId: "",
    conversationId: String(row.conversation_id),
    ...(row.source_message_id === null ? {} : { sourceMessageId: String(row.source_message_id) }),
    kind: String(row.kind),
    scope: String(row.scope),
    text: String(row.text),
    at: String(row.created_at),
  };
}

/** Newest first, because the newest thing remembered is the one most likely to be relevant. */
export function listMemoryRecords(
  db: Database,
  query: { principalId: string; kind?: string; scope?: string },
): MemoryRecordInput[] {
  const clauses = ["principal_id = ?"];
  const values: unknown[] = [query.principalId];
  if (query.kind !== undefined) {
    clauses.push("kind = ?");
    values.push(query.kind);
  }
  if (query.scope !== undefined) {
    clauses.push("scope = ?");
    values.push(query.scope);
  }
  const rows = allRows<MemoryRow>(
    db,
    `SELECT * FROM memory_records WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, memory_id DESC`,
    ...values,
  );
  return rows.map(toMemoryRecord);
}

export function getMemoryRecord(db: Database, memoryId: string): MemoryRecordInput | undefined {
  const row = oneRow<MemoryRow>(db, "SELECT * FROM memory_records WHERE memory_id = ?", memoryId);
  return row === undefined ? undefined : toMemoryRecord(row);
}

/**
 * Remove one record, and say whether anything was removed.
 *
 * The principal is part of the condition rather than checked afterwards: a delete that first reads the row and
 * then decides cannot be the thing that enforces ownership.
 */
export function deleteMemoryRecord(db: Database, principalId: string, memoryId: string): boolean {
  const result = db
    .prepare("DELETE FROM memory_records WHERE memory_id = ? AND principal_id = ?")
    .run(memoryId, principalId);
  return Number(result.changes) > 0;
}

/**
 * What goes into the brief for one turn.
 *
 * Node-scoped records and the ones learned in this conversation, never another conversation's: a decision taken
 * somewhere else is not context for what is being decided here.
 */
export function memoryRecordsForBrief(
  db: Database,
  principalId: string,
  conversationId: string,
  limit: number,
): MemoryRecordInput[] {
  const rows = allRows<MemoryRow>(
    db,
    `SELECT * FROM memory_records
      WHERE principal_id = ? AND (scope = 'node' OR conversation_id = ?)
      ORDER BY created_at DESC, memory_id DESC
      LIMIT ?`,
    principalId,
    conversationId,
    limit,
  );
  return rows.map(toMemoryRecord);
}

/**
 * How many records would go into a brief, counted rather than guessed.
 *
 * The brief is capped, and the cap has to say how much was left out. Fetching one row past the cap would let it
 * say "at least one more", which is weaker than the truth and would drift as memory grows.
 */
export function countMemoryRecordsForBrief(db: Database, principalId: string, conversationId: string): number {
  const row = oneRow<{ total: number }>(
    db,
    `SELECT COUNT(*) AS total FROM memory_records
      WHERE principal_id = ? AND (scope = 'node' OR conversation_id = ?)`,
    principalId,
    conversationId,
  );
  return Number(row?.total ?? 0);
}
