import {
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, transaction } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Conversations and timeline
 * ------------------------------------------------------------------ */

/**
 * Create a conversation and claim its home authority in one step.
 *
 * A conversation with no authority cannot accept commands, and one with two authorities
 * is the multi-master failure the protocol exists to prevent, so both writes belong
 * together.
 */
export function createConversation(
  db: Database,
  input: { conversationId: string; homeNodeId: string; title?: string; at: Instant },
): void {
  transaction(db, () => {
    db.prepare(
      "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?,?,?,?,?)",
    ).run(input.conversationId, input.title ?? null, input.homeNodeId, input.at, input.at);
    db.prepare(
      "INSERT INTO conversation_authority (conversation_id, home_node_id, claimed_at) VALUES (?,?,?)",
    ).run(input.conversationId, input.homeNodeId, input.at);
  });
}

/** Touch a conversation so listing by recency reflects the latest activity. */
export function touchConversation(db: Database, conversationId: string, at: Instant): void {
  db.prepare("UPDATE conversations SET updated_at = ? WHERE conversation_id = ?").run(at, conversationId);
}

export function getConversation(
  db: Database,
  conversationId: string,
): { conversationId: string; homeNodeId: string; title: string | undefined; createdAt: string; updatedAt: string } | undefined {
  const row = oneRow<{ conversation_id: string; home_node_id: string; title: string | null; created_at: string; updated_at: string }>(
    db,
    "SELECT conversation_id, home_node_id, title, created_at, updated_at FROM conversations WHERE conversation_id = ?",
    conversationId,
  );
  if (!row) return undefined;
  return {
    conversationId: row.conversation_id,
    homeNodeId: row.home_node_id,
    title: row.title ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listConversations(db: Database, limit = 50): string[] {
  return allRows<{ conversation_id: string }>(
    db,
    "SELECT conversation_id FROM conversations ORDER BY updated_at DESC LIMIT ?",
    limit,
  ).map((row) => row.conversation_id);
}

/**
 * Next timeline position for a conversation.
 *
 * Computed rather than supplied so two concurrent writers cannot claim the same
 * position, which would make the timeline order ambiguous for the client's cursor.
 */
export function nextMessageSequence(db: Database, conversationId: string): number {
  const row = oneRow<{ max_sequence: number | null }>(
    db,
    "SELECT MAX(sequence) AS max_sequence FROM messages WHERE conversation_id = ?",
    conversationId,
  );
  return Number(row?.max_sequence ?? 0) + 1;
}
