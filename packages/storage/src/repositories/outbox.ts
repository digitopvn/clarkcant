import {
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Outbox
 * ------------------------------------------------------------------ */

/** Record intent before transmission, so a crash cannot lose an unsent message. */
export function enqueueOutbox(
  db: Database,
  input: { messageId: string; peerNodeId: string; correlationId: string; document: unknown; createdAt: Instant },
): void {
  db.prepare(
    `INSERT INTO outbox (message_id, peer_node_id, correlation_id, document, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.messageId, input.peerNodeId, input.correlationId, toJson(input.document), input.createdAt);
}

export function markOutboxAttempt(db: Database, messageId: string, at: Instant): void {
  db.prepare("UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ? WHERE message_id = ?").run(at, messageId);
}

export function markOutboxAcknowledged(db: Database, messageId: string, at: Instant): void {
  db.prepare("UPDATE outbox SET acknowledged_at = ? WHERE message_id = ?").run(at, messageId);
}

export function pendingOutbox(db: Database, peerNodeId?: string): unknown[] {
  const rows = peerNodeId
    ? allRows<{ document: string }>(
        db,
        "SELECT document FROM outbox WHERE acknowledged_at IS NULL AND peer_node_id = ? ORDER BY created_at",
        peerNodeId,
      )
    : allRows<{ document: string }>(
        db,
        "SELECT document FROM outbox WHERE acknowledged_at IS NULL ORDER BY created_at",
      );
  return rows.map((row) => parseJson<unknown>(row.document, "outbox.document"));
}
