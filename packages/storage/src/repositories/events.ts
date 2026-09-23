import {
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "../db.ts";

export function nextStreamSequence(db: Database, stream: string, nodeId: string): number {
  const row = oneRow<{ max_sequence: number | null }>(
    db,
    "SELECT MAX(source_sequence) AS max_sequence FROM events WHERE stream = ? AND source_node_id = ?",
    stream,
    nodeId,
  );
  return Number(row?.max_sequence ?? 0) + 1;
}

export interface AppendEventInput {
  eventId: string;
  kind: string;
  stream: string;
  nodeId: string;
  conversationId?: string;
  taskId?: string;
  runId?: string;
  document: unknown;
  occurredAt: Instant;
}

/**
 * Append to the node's event log.
 *
 * The sequence is computed here rather than passed in, so two writers cannot
 * choose the same number. The unique index on
 * (source_node_id, stream, source_sequence) turns a collision into an error
 * instead of a silently reordered timeline.
 */
export function appendEvent(db: Database, input: AppendEventInput): number {
  const sequence = nextStreamSequence(db, input.stream, input.nodeId);
  db.prepare(
    `INSERT INTO events
       (event_id, source_node_id, stream, source_sequence, kind, conversation_id, task_id, run_id, document, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.eventId,
    input.nodeId,
    input.stream,
    sequence,
    input.kind,
    input.conversationId ?? null,
    input.taskId ?? null,
    input.runId ?? null,
    toJson(input.document),
    input.occurredAt,
  );
  return sequence;
}

export function eventsSince(
  db: Database,
  filter: { conversationId?: string; stream?: string; afterSequence: number; limit?: number },
): unknown[] {
  const clauses: string[] = ["source_sequence > ?"];
  const params: unknown[] = [filter.afterSequence];
  if (filter.conversationId) {
    clauses.push("conversation_id = ?");
    params.push(filter.conversationId);
  }
  if (filter.stream) {
    clauses.push("stream = ?");
    params.push(filter.stream);
  }
  const rows = allRows<{ document: string }>(
    db,
    `SELECT document FROM events WHERE ${clauses.join(" AND ")} ORDER BY source_sequence ASC LIMIT ?`,
    ...params,
    filter.limit ?? 500,
  );
  return rows.map((row) => parseJson<unknown>(row.document, "events.document"));
}

export interface RecentEvent {
  kind: string;
  occurredAt: string;
  document: unknown;
}

/**
 * The most recent events on one stream, newest first.
 *
 * Separate from `eventsSince` rather than a flag on it, because the two questions are opposites: that one
 * replays a conversation forwards from a cursor, and this one answers "what happened lately" for a surface
 * that shows the last few things and nothing else. It also carries the kind and the time, which the replay
 * does not need but a list of effects is meaningless without.
 */
export function recentEvents(
  db: Database,
  filter: { stream: string; limit?: number },
): RecentEvent[] {
  const rows = allRows<{ kind: string; occurred_at: string; document: string }>(
    db,
    "SELECT kind, occurred_at, document FROM events WHERE stream = ? ORDER BY source_sequence DESC LIMIT ?",
    filter.stream,
    filter.limit ?? 20,
  );
  return rows.map((row) => ({
    kind: row.kind,
    occurredAt: row.occurred_at,
    document: parseJson<unknown>(row.document, "events.document"),
  }));
}
