import {
  type Instant,
  type PeerEnvelope,
} from "@clarkcant/contracts";

import { type Database, oneRow, toJson, transaction } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Inbox
 * ------------------------------------------------------------------ */

export type InboxRecordResult =
  | { status: "recorded" }
  | { status: "duplicate"; previousResponseJson: string | undefined };

/**
 * Record an inbound envelope and its computed response atomically.
 *
 * Storing the response alongside the dedup key is what makes a lost
 * acknowledgement recoverable: when the peer resends, we return the outcome we
 * already produced instead of executing a second time (acceptance test T02).
 */
export function recordInbox(
  db: Database,
  input: {
    dedupKey: string;
    peerNodeId: string;
    sourceSequence: number;
    messageId: string;
    kind: string;
    document: PeerEnvelope;
    /**
     * Serialised response, stored verbatim. Taking JSON text rather than a value
     * keeps this path free of any parse that could throw mid-message, and lets the
     * caller hand the identical bytes back on a replay.
     */
    responseJson: string;
    receivedAt: Instant;
  },
): InboxRecordResult {
  return transaction(db, () => {
    const existing = oneRow<{ response: string | null }>(
      db,
      "SELECT response FROM inbox WHERE dedup_key = ?",
      input.dedupKey,
    );
    if (existing) {
      return {
        status: "duplicate" as const,
        previousResponseJson: existing.response === null ? undefined : existing.response,
      };
    }

    db.prepare(
      `INSERT INTO inbox
         (dedup_key, peer_node_id, source_sequence, message_id, kind, document, response, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.dedupKey,
      input.peerNodeId,
      input.sourceSequence,
      input.messageId,
      input.kind,
      toJson(input.document),
      input.responseJson,
      input.receivedAt,
    );

    const cursor = oneRow<{ last_sequence: number }>(
      db,
      "SELECT last_sequence FROM peer_cursors WHERE peer_node_id = ?",
      input.peerNodeId,
    );
    if (cursor === undefined) {
      // The first message from a peer establishes the baseline. Without one there is nothing to be
      // contiguous with, and inventing a zero would make a stream that starts at five look like four
      // lost messages.
      db.prepare("INSERT INTO peer_cursors (peer_node_id, last_sequence, updated_at) VALUES (?, ?, ?)").run(
        input.peerNodeId,
        input.sourceSequence,
        input.receivedAt,
      );
    } else if (input.sourceSequence === cursor.last_sequence + 1) {
      // Contiguous only, which is what the column documents itself as being. Advancing over a gap is
      // what turns a delayed message into a permanently unprocessable one: the missing sequence
      // arrives later, reads as a regression, and is refused for good.
      db.prepare("UPDATE peer_cursors SET last_sequence = ?, updated_at = ? WHERE peer_node_id = ?").run(
        input.sourceSequence,
        input.receivedAt,
        input.peerNodeId,
      );
    }

    return { status: "recorded" as const };
  });
}

export function peerCursor(db: Database, peerNodeId: string): number | undefined {
  const row = oneRow<{ last_sequence: number }>(
    db,
    "SELECT last_sequence FROM peer_cursors WHERE peer_node_id = ?",
    peerNodeId,
  );
  return row === undefined ? undefined : Number(row.last_sequence);
}
