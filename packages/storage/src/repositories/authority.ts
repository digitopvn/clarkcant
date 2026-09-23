import {
  type Instant,
} from "@clarkcant/contracts";

import { type Database, oneRow, transaction } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Conversation authority
 * ------------------------------------------------------------------ */

export type AuthorityClaim =
  | { ok: true }
  | { ok: false; code: "AUTHORITY_HELD_ELSEWHERE"; homeNodeId: string };

/**
 * Claim timeline authority for a conversation.
 *
 * Exactly one home node owns a conversation at a time. A second node attempting
 * to claim it is refused rather than allowed to append, because two authoritative
 * timelines cannot be merged after a partition (acceptance test T04).
 */
export function claimConversationAuthority(
  db: Database,
  input: { conversationId: string; homeNodeId: string; at: Instant },
): AuthorityClaim {
  return transaction(db, () => {
    const existing = oneRow<{ home_node_id: string }>(
      db,
      "SELECT home_node_id FROM conversation_authority WHERE conversation_id = ?",
      input.conversationId,
    );
    if (existing && existing.home_node_id !== input.homeNodeId) {
      return { ok: false as const, code: "AUTHORITY_HELD_ELSEWHERE" as const, homeNodeId: existing.home_node_id };
    }
    if (!existing) {
      db.prepare(
        "INSERT INTO conversation_authority (conversation_id, home_node_id, claimed_at) VALUES (?, ?, ?)",
      ).run(input.conversationId, input.homeNodeId, input.at);
    }
    return { ok: true as const };
  });
}
