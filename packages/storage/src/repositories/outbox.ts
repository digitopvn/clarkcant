import {
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Outbox
 * ------------------------------------------------------------------ */

/** A message this node has given up retrying automatically, after enough failed passes. */
export const MAX_OUTBOX_ATTEMPTS = 12;

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * Exponential backoff, deterministic and jitter-free: doubling from a 5s base, capped at 15 minutes.
 *
 * No randomness on purpose. A retry schedule that a test can compute by hand and an operator can
 * predict by reading `attempts` is worth more here than the small thundering-herd protection jitter
 * would add — this outbox is one node retrying one peer, not a fleet retrying one shared endpoint.
 */
function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}

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

export type OutboxFailureOutcome =
  | { status: "scheduled"; nextAttemptAt: Instant }
  | { status: "dead-lettered" };

/**
 * Record that a delivery attempt failed, and decide what happens to the message next.
 *
 * `markOutboxAttempt` has already run for this pass (delivery always records the attempt before it
 * knows the outcome), so the `attempts` column already reflects the try that just failed. Reaching
 * `MAX_OUTBOX_ATTEMPTS` dead-letters the row instead of scheduling another one: a message this node
 * has retried a dozen times to no effect is not made more likely to succeed by a thirteenth identical
 * try, and holding it as dead rather than silently resending forever is what lets an operator see it.
 */
export function markOutboxFailed(db: Database, messageId: string, at: Instant, error: string): OutboxFailureOutcome {
  const row = oneRow<{ attempts: number }>(db, "SELECT attempts FROM outbox WHERE message_id = ?", messageId);
  const attempts = row?.attempts ?? 0;
  // Bounded and free of anything a caller might have embedded from a URL or token: the caller is
  // responsible for sanitizing before this is stored, and the cap keeps a pathological message from
  // growing the row without limit.
  const sanitizedError = error.slice(0, 500);

  if (attempts >= MAX_OUTBOX_ATTEMPTS) {
    db.prepare("UPDATE outbox SET dead_lettered_at = ?, last_error = ? WHERE message_id = ?").run(
      at,
      sanitizedError,
      messageId,
    );
    return { status: "dead-lettered" };
  }

  const nextAttemptAt = new Date(new Date(at).getTime() + backoffMs(attempts)).toISOString() as Instant;
  db.prepare("UPDATE outbox SET next_attempt_at = ?, last_error = ? WHERE message_id = ?").run(
    nextAttemptAt,
    sanitizedError,
    messageId,
  );
  return { status: "scheduled", nextAttemptAt };
}

export function pendingOutbox(db: Database, peerNodeId?: string, now?: Instant): unknown[] {
  // Dead-lettered rows are excluded unconditionally: that state means this node has stopped retrying
  // automatically, regardless of what "now" happens to be. The `next_attempt_at` filter only applies
  // when a caller supplies `now`, so a caller that does not care about scheduling (a test reading back
  // what is still owed, for instance) keeps seeing every row that has not yet been acknowledged.
  const clauses = ["acknowledged_at IS NULL", "dead_lettered_at IS NULL"];
  const params: unknown[] = [];
  if (peerNodeId !== undefined) {
    clauses.push("peer_node_id = ?");
    params.push(peerNodeId);
  }
  if (now !== undefined) {
    clauses.push("(next_attempt_at IS NULL OR next_attempt_at <= ?)");
    params.push(now);
  }
  const rows = allRows<{ document: string }>(
    db,
    `SELECT document FROM outbox WHERE ${clauses.join(" AND ")} ORDER BY created_at`,
    ...params,
  );
  return rows.map((row) => parseJson<unknown>(row.document, "outbox.document"));
}

export interface DeadLetteredOutboxEntry {
  messageId: string;
  peerNodeId: string;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: Instant;
  document: unknown;
}

/** Messages this node has given up retrying automatically, for an operator or a diagnostics surface to read. */
export function deadLetteredOutbox(db: Database): DeadLetteredOutboxEntry[] {
  const rows = allRows<{
    message_id: string;
    peer_node_id: string;
    attempts: number;
    last_error: string | null;
    dead_lettered_at: string;
    document: string;
  }>(
    db,
    `SELECT message_id, peer_node_id, attempts, last_error, dead_lettered_at, document
     FROM outbox WHERE dead_lettered_at IS NOT NULL ORDER BY dead_lettered_at`,
  );
  return rows.map((row) => ({
    messageId: row.message_id,
    peerNodeId: row.peer_node_id,
    attempts: row.attempts,
    lastError: row.last_error,
    deadLetteredAt: row.dead_lettered_at as Instant,
    document: parseJson<unknown>(row.document, "outbox.document"),
  }));
}

/**
 * The next `sourceSequence` this node should address to a peer.
 *
 * NodeLink requires a strictly increasing per-sender sequence so the receiver can tell a gap from a
 * replay, and the outbox is the durable record of every envelope this node has ever queued for a peer:
 * rows are never deleted, only marked acknowledged (migration 2's own comment on this table), so the
 * highest `sourceSequence` already queued for a peer is the highest one this node has committed to
 * sending it. Deriving the counter from that ledger, rather than keeping a second one, is what makes
 * "what sequence did we last use for this peer" answerable from the same durable record the delivery
 * loop already trusts.
 */
export function nextOutboundSequence(db: Database, peerNodeId: string): number {
  const rows = allRows<{ document: string }>(
    db,
    "SELECT document FROM outbox WHERE peer_node_id = ?",
    peerNodeId,
  );
  let max = 0;
  for (const row of rows) {
    const parsed = parseJson<{ sourceSequence?: unknown }>(row.document, "outbox.document");
    const sequence = typeof parsed.sourceSequence === "number" ? parsed.sourceSequence : 0;
    if (sequence > max) max = sequence;
  }
  return max + 1;
}
