import {
  type MessageRecord,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

export function appendMessage(db: Database, message: MessageRecord, sequence: number): void {
  db.prepare(
    `INSERT INTO messages
       (message_id, conversation_id, role, author_node_id, task_id, delivery, document, sequence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.messageId,
    message.conversationId,
    message.role,
    message.authorNodeId,
    message.taskId ?? null,
    message.delivery,
    toJson(message),
    sequence,
    message.createdAt,
  );
}

export function messagesSince(db: Database, conversationId: string, afterSequence: number, limit = 200): MessageRecord[] {
  const rows = allRows<{ document: string }>(
    db,
    `SELECT document FROM messages
      WHERE conversation_id = ? AND sequence > ?
      ORDER BY sequence ASC LIMIT ?`,
    conversationId,
    afterSequence,
    limit,
  );
  return rows.map((row) => parseJson<MessageRecord>(row.document, "messages.document"));
}

export function conversationMetadata(
  db: Database,
  conversationId: string,
): { messageCount: number; taskCount: number; updatedAt: string; cursor: number } {
  const counts = oneRow<{ message_count: number; task_count: number; updated_at: string | null }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE conversation_id = ?) AS message_count,
       (SELECT COUNT(*) FROM tasks WHERE conversation_id = ?) AS task_count,
       (SELECT MAX(occurred_at) FROM events WHERE conversation_id = ?) AS updated_at`,
    conversationId,
    conversationId,
    conversationId,
  );
  const cursor = oneRow<{ max_sequence: number | null }>(
    db,
    "SELECT MAX(source_sequence) AS max_sequence FROM events WHERE conversation_id = ?",
    conversationId,
  );
  return {
    messageCount: Number(counts?.message_count ?? 0),
    taskCount: Number(counts?.task_count ?? 0),
    updatedAt: String(counts?.updated_at ?? new Date(0).toISOString()),
    cursor: Number(cursor?.max_sequence ?? 0),
  };
}
