import {
  type MessageRecord,
  type TimelinePageQuery,
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

/** One page of a conversation's messages, oldest first, with the range of sequences it is the whole truth about. */
export interface MessagePage {
  messages: MessageRecord[];
  /** Each message's sequence, in the order of `messages`. */
  sequences: number[];
  /** Every stored message with `fromSequence <= sequence <= toSequence` is in `messages`, and no other is. */
  fromSequence: number;
  toSequence: number;
  hasOlder: boolean;
  hasNewer: boolean;
}

/**
 * One page of a conversation by message sequence: the newest `limit`, the `limit` before a sequence, or the `limit`
 * after one (`TimelinePageQuery`).
 *
 * One row past the page is read to learn whether there is more, and its sequence is what bounds the page's range:
 * the range reaches up to (or down to) the next message that is not in it, so two pages read one after another meet
 * exactly, with no gap a reader would have to guess about and no message in both.
 */
export function messagePage(db: Database, conversationId: string, query: TimelinePageQuery, limit: number): MessagePage {
  type Row = { document: string; sequence: number };
  const page = (rows: Row[]): { messages: MessageRecord[]; sequences: number[] } => ({
    messages: rows.map((row) => parseJson<MessageRecord>(row.document, "messages.document")),
    sequences: rows.map((row) => Number(row.sequence)),
  });
  const exists = (clause: string, sequence: number): boolean =>
    oneRow<{ found: number }>(
      db,
      `SELECT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ? AND sequence ${clause} ?) AS found`,
      conversationId,
      sequence,
    )?.found === 1;

  if (query.kind === "after") {
    const rows = allRows<Row>(
      db,
      `SELECT document, sequence FROM messages
        WHERE conversation_id = ? AND sequence > ?
        ORDER BY sequence ASC LIMIT ?`,
      conversationId,
      query.afterSequence,
      limit + 1,
    );
    const more = rows.length > limit;
    const kept = rows.slice(0, limit);
    const next = rows[limit];
    return {
      ...page(kept),
      fromSequence: query.afterSequence + 1,
      toSequence: next !== undefined ? Number(next.sequence) - 1 : Math.max(query.afterSequence, Number(kept.at(-1)?.sequence ?? 0)),
      hasOlder: query.afterSequence > 0 && exists("<=", query.afterSequence),
      hasNewer: more,
    };
  }

  const rows =
    query.kind === "latest"
      ? allRows<Row>(
          db,
          `SELECT document, sequence FROM messages
            WHERE conversation_id = ?
            ORDER BY sequence DESC LIMIT ?`,
          conversationId,
          limit + 1,
        )
      : allRows<Row>(
          db,
          `SELECT document, sequence FROM messages
            WHERE conversation_id = ? AND sequence < ?
            ORDER BY sequence DESC LIMIT ?`,
          conversationId,
          query.beforeSequence,
          limit + 1,
        );
  const previous = rows[limit];
  const kept = rows.slice(0, limit).reverse();
  const fromSequence = previous === undefined ? 0 : Number(previous.sequence) + 1;
  if (query.kind === "latest") {
    return { ...page(kept), fromSequence, toSequence: Number(kept.at(-1)?.sequence ?? 0), hasOlder: previous !== undefined, hasNewer: false };
  }
  const toSequence = query.beforeSequence - 1;
  return { ...page(kept), fromSequence, toSequence, hasOlder: previous !== undefined, hasNewer: exists(">", toSequence) };
}

/** One message of one conversation by its id, or `undefined` when that conversation holds no such message. */
export function messageById(db: Database, conversationId: string, messageId: string): MessageRecord | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM messages WHERE conversation_id = ? AND message_id = ?",
    conversationId,
    messageId,
  );
  return row === undefined ? undefined : parseJson<MessageRecord>(row.document, "messages.document");
}

/**
 * The newest `limit` messages of one conversation, oldest first.
 *
 * For readers looking for something still open - a card waiting for a decision, a question waiting for an answer.
 * Those live at the end of a transcript, so reading from the start with a limit, as `messagesSince` does, misses
 * them in exactly the conversations that are long enough to matter.
 */
export function latestMessages(db: Database, conversationId: string, limit: number): MessageRecord[] {
  const rows = allRows<{ document: string }>(
    db,
    `SELECT document FROM messages
      WHERE conversation_id = ?
      ORDER BY sequence DESC LIMIT ?`,
    conversationId,
    limit,
  );
  return rows.reverse().map((row) => parseJson<MessageRecord>(row.document, "messages.document"));
}

/**
 * Of the newest `window` messages of one conversation, the ones whose stored document contains `needle`, oldest
 * first.
 *
 * For a reader after the few messages about one thing — a question's card and what became of it — in a long
 * transcript. The match runs over the stored text in SQLite, so only matching messages are parsed. The window is the
 * one `latestMessages(db, conversationId, window)` reads, so a reader using this sees what one parsing all of those
 * messages would see of that thing.
 */
export function latestMessagesContaining(
  db: Database,
  conversationId: string,
  needle: string,
  window: number,
): MessageRecord[] {
  const rows = allRows<{ document: string }>(
    db,
    `SELECT document FROM (
       SELECT document, sequence FROM messages
        WHERE conversation_id = ?
        ORDER BY sequence DESC LIMIT ?
     )
     WHERE instr(document, ?) > 0
     ORDER BY sequence ASC`,
    conversationId,
    window,
    needle,
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
