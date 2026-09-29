import {
  type Instant,
  type SemanticProposal,
  type WidgetSemanticDoc,
  SEMANTIC_SCHEMA_VERSION,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Widget semantic state — what a touched widget means now
 * ------------------------------------------------------------------ */

export interface WidgetSemanticRow {
  instanceId: string;
  conversationId: string;
  /** 0 until the host first builds the document; moves only when the document's digest does. */
  revision: number;
  digest: string | undefined;
  document: WidgetSemanticDoc | undefined;
  proposal: SemanticProposal | undefined;
  touchedAt: Instant;
}

interface Row {
  instance_id: string;
  conversation_id: string;
  semantic_revision: number;
  source_digest: string | null;
  document: string | null;
  proposal: string | null;
  touched_at: string;
}

function fromRow(row: Row): WidgetSemanticRow {
  return {
    instanceId: row.instance_id,
    conversationId: row.conversation_id,
    revision: Number(row.semantic_revision),
    digest: row.source_digest ?? undefined,
    document: row.document === null ? undefined : parseJson<WidgetSemanticDoc>(row.document, "widget_semantic_state.document"),
    proposal: row.proposal === null ? undefined : parseJson<SemanticProposal>(row.proposal, "widget_semantic_state.proposal"),
    touchedAt: row.touched_at as Instant,
  };
}

/**
 * Note that a person just changed a widget from a conversation.
 *
 * Only the time and the conversation: nothing is built and no model is called, so a person dragging a slider costs
 * one small write per settled change. What the change meant is read when the next turn starts.
 */
export function touchWidgetSemantic(db: Database, input: { instanceId: string; conversationId: string; at: Instant }): void {
  db.prepare(
    `INSERT INTO widget_semantic_state (instance_id, conversation_id, schema_version, touched_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(instance_id) DO UPDATE SET
       conversation_id = excluded.conversation_id,
       touched_at = excluded.touched_at`,
  ).run(input.instanceId, input.conversationId, SEMANTIC_SCHEMA_VERSION, input.at, input.at);
}

/** Keep what a widget's own frame published about itself, and count it as a touch. */
export function recordWidgetProposal(
  db: Database,
  input: { instanceId: string; conversationId: string; proposal: SemanticProposal; at: Instant },
): void {
  db.prepare(
    `INSERT INTO widget_semantic_state (instance_id, conversation_id, schema_version, proposal, touched_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance_id) DO UPDATE SET
       conversation_id = excluded.conversation_id,
       proposal = excluded.proposal,
       touched_at = excluded.touched_at`,
  ).run(input.instanceId, input.conversationId, SEMANTIC_SCHEMA_VERSION, toJson(input.proposal), input.at, input.at);
}

/**
 * Store the document the host just built, and return its revision.
 *
 * The revision moves only when the digest differs from the one stored, so building the same meaning twice, from a
 * rerender or a saved view, leaves it where it was and a model session that saw it is not told again.
 */
export function recordWidgetSemantic(
  db: Database,
  input: { instanceId: string; document: WidgetSemanticDoc; digest: string; at: Instant },
): number {
  db.prepare(
    `UPDATE widget_semantic_state
        SET semantic_revision = semantic_revision + 1, source_digest = ?, document = ?, schema_version = ?, updated_at = ?
      WHERE instance_id = ? AND (source_digest IS NULL OR source_digest <> ?)`,
  ).run(input.digest, toJson(input.document), SEMANTIC_SCHEMA_VERSION, input.at, input.instanceId, input.digest);
  return getWidgetSemantic(db, input.instanceId)?.revision ?? 0;
}

export function getWidgetSemantic(db: Database, instanceId: string): WidgetSemanticRow | undefined {
  const row = oneRow<Row>(db, "SELECT * FROM widget_semantic_state WHERE instance_id = ?", instanceId);
  return row === undefined ? undefined : fromRow(row);
}

/** The widgets touched from a conversation, the most recent first. */
export function listTouchedWidgets(db: Database, conversationId: string, limit: number): WidgetSemanticRow[] {
  return allRows<Row>(
    db,
    "SELECT * FROM widget_semantic_state WHERE conversation_id = ? ORDER BY touched_at DESC, instance_id LIMIT ?",
    conversationId,
    limit,
  ).map(fromRow);
}
