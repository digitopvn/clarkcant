import { indexHistory, type Database } from "@clarkcant/storage";

/**
 * A stored, indexed message of a conversation, for the context planner's tests.
 *
 * Both rows a real message has: the `messages` row says who said it (retrieval reads only the person's and Clark's own),
 * and the history index is what the search finds. Indexing alone would be a message nobody said.
 */
export function seedMessage(
  db: Database,
  input: {
    messageId: string;
    role: "user" | "assistant" | "system" | "tool";
    text: string;
    principalId: string;
    conversationId: string;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, 'n1', ?, ?)`,
  ).run(input.conversationId, input.createdAt, input.createdAt);
  const sequence = (
    db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE conversation_id = ?`).get(input.conversationId) as {
      next: number;
    }
  ).next;
  db.prepare(
    `INSERT OR REPLACE INTO messages (message_id, conversation_id, role, author_node_id, task_id, delivery, document, sequence, created_at)
     VALUES (?, ?, ?, 'n1', NULL, 'accepted', ?, ?, ?)`,
  ).run(
    input.messageId,
    input.conversationId,
    input.role,
    JSON.stringify({
      messageId: input.messageId,
      conversationId: input.conversationId,
      role: input.role,
      blocks: [{ type: "text", text: input.text }],
      authorNodeId: "n1",
      createdAt: input.createdAt,
      delivery: "accepted",
    }),
    sequence,
    input.createdAt,
  );
  indexHistory(db, {
    source: "message",
    ref: input.messageId,
    text: input.text,
    principalId: input.principalId,
    conversationId: input.conversationId,
    createdAt: input.createdAt,
  });
}
