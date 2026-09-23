import { type Database, allRows, oneRow, transaction } from "../db.ts";

/* ------------------------------------------------------------------ *
 * History index
 * ------------------------------------------------------------------ */

export type HistorySource = "message" | "session_entry";

export interface HistoryIndexInput {
  source: HistorySource;
  /** Stable identity of the indexed thing: a message id, or `sessionId:offset`. */
  ref: string;
  text: string;
  principalId: string;
  conversationId?: string;
  taskId?: string;
  createdAt: string;
}

/**
 * Index one piece of history.
 *
 * Re-indexing the same ref replaces it rather than duplicating it, so a re-run of an ingest batch is
 * harmless: the alternative is a search that returns the same sentence twice because a batch was
 * retried after a crash.
 */
export function indexHistory(db: Database, input: HistoryIndexInput): void {
  const text = input.text.trim();
  if (text === "") return;

  transaction(db, () => {
    const existing = oneRow<{ rowid: number }>(
      db,
      "SELECT rowid FROM history_fts WHERE source = ? AND ref = ?",
      input.source,
      input.ref,
    );
    if (existing !== undefined) {
      db.prepare("DELETE FROM history_fts WHERE rowid = ?").run(existing.rowid);
    }
    db.prepare(
      `INSERT INTO history_fts (text, source, ref, conversation_id, task_id, principal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      text,
      input.source,
      input.ref,
      input.conversationId ?? null,
      input.taskId ?? null,
      input.principalId,
      input.createdAt,
    );
  });
}

export interface HistoryHit {
  source: HistorySource;
  ref: string;
  /** BM25 score. Lower is better, which is SQLite's convention and worth stating. */
  score: number;
  snippet: string;
  conversationId: string | undefined;
  taskId: string | undefined;
  createdAt: string;
}

export interface HistoryQuery {
  principalId: string;
  /** Free text. Tokenised into quoted terms, never interpolated as an expression. */
  text: string;
  from?: string;
  to?: string;
  conversationId?: string;
  taskId?: string;
  source?: HistorySource;
  limit?: number;
  offset?: number;
}

/**
 * Turn free text into an FTS5 MATCH expression.
 *
 * Each term is quoted, which is what stops a user's words from being read as FTS syntax: `AND`,
 * `NEAR`, `*` and a stray quote are all meaningful to FTS5, and a query that throws is worse than a
 * query that returns nothing. Terms are OR'd so a multi-word question still retrieves, and BM25 is
 * what orders the result.
 */
export function toMatchExpression(text: string, maxTerms = 12): string {
  const terms = text
    .split(/\s+/)
    .map((term) => term.replace(/"/g, "").trim())
    .filter((term) => term.length > 1)
    .slice(0, maxTerms);
  if (terms.length === 0) return "";
  return terms.map((term) => `"${term}"`).join(" OR ");
}

/**
 * Search history for one principal.
 *
 * The principal filter is part of the SQL rather than a post-filter, because a result that is
 * fetched and then discarded still touched the data of another principal.
 */
export function searchHistory(db: Database, query: HistoryQuery): HistoryHit[] {
  const match = toMatchExpression(query.text);
  if (match === "") return [];

  const clauses = ["history_fts MATCH ?", "principal_id = ?"];
  const params: unknown[] = [match, query.principalId];
  if (query.from !== undefined) {
    clauses.push("created_at >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("created_at < ?");
    params.push(query.to);
  }
  if (query.conversationId !== undefined) {
    clauses.push("conversation_id = ?");
    params.push(query.conversationId);
  }
  if (query.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(query.taskId);
  }
  if (query.source !== undefined) {
    clauses.push("source = ?");
    params.push(query.source);
  }

  const rows = allRows<{
    text: string;
    source: string;
    ref: string;
    score: number;
    snippet: string;
    conversation_id: string | null;
    task_id: string | null;
    created_at: string;
  }>(
    db,
    `SELECT text, source, ref, bm25(history_fts) AS score,
            snippet(history_fts, 0, '[', ']', '…', 12) AS snippet,
            conversation_id, task_id, created_at
       FROM history_fts
      WHERE ${clauses.join(" AND ")}
      ORDER BY score
      LIMIT ? OFFSET ?`,
    ...params,
    query.limit ?? 10,
    query.offset ?? 0,
  );

  return rows.map((row) => ({
    source: row.source as HistorySource,
    ref: row.ref,
    score: Number(row.score),
    snippet: row.snippet,
    conversationId: row.conversation_id ?? undefined,
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
  }));
}

/**
 * Recent history inside a window, newest first.
 *
 * The companion to `searchHistory` for a query that has no terms left after its time phrase was
 * parsed ("what happened yesterday"). It reads the same table under the same principal scope, so the
 * two paths cannot disagree about whose history is visible.
 */
export function recentHistory(
  db: Database,
  query: {
    principalId: string;
    from: string;
    to: string;
    conversationId?: string;
    taskId?: string;
    source?: HistorySource;
    limit?: number;
  },
): HistoryHit[] {
  const clauses = ["principal_id = ?", "created_at >= ?", "created_at < ?"];
  const params: unknown[] = [query.principalId, query.from, query.to];
  if (query.conversationId !== undefined) {
    clauses.push("conversation_id = ?");
    params.push(query.conversationId);
  }
  if (query.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(query.taskId);
  }
  if (query.source !== undefined) {
    clauses.push("source = ?");
    params.push(query.source);
  }

  const rows = allRows<{
    text: string;
    source: string;
    ref: string;
    conversation_id: string | null;
    task_id: string | null;
    created_at: string;
  }>(
    db,
    `SELECT text, source, ref, conversation_id, task_id, created_at
       FROM history_fts
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?`,
    ...params,
    query.limit ?? 10,
  );

  return rows.map((row) => ({
    source: row.source as HistorySource,
    ref: row.ref,
    // No ranking was applied, and reporting a score here would imply one was.
    score: 0,
    snippet: row.text.slice(0, 240),
    conversationId: row.conversation_id ?? undefined,
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
  }));
}

/** How much history a principal has indexed, so a caller can tell "no matches" from "no index". */
export function historyIndexSize(db: Database, principalId: string): number {
  const row = oneRow<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM history_fts WHERE principal_id = ?",
    principalId,
  );
  return Number(row?.n ?? 0);
}

/**
 * One indexed entry, by identity.
 *
 * A semantic hit arrives as a distance and a ref, with no text: the vector index is what found it, and
 * the words live in the lexical table. Reading the entry back is what lets a fused result show a
 * snippet for a row that only the vector side matched.
 */
export function historyEntry(
  db: Database,
  input: { principalId: string; source: HistorySource; ref: string },
): { text: string; conversationId: string | undefined; taskId: string | undefined; createdAt: string } | undefined {
  const row = oneRow<{
    text: string;
    conversation_id: string | null;
    task_id: string | null;
    created_at: string;
  }>(
    db,
    `SELECT text, conversation_id, task_id, created_at
       FROM history_fts
      WHERE principal_id = ? AND source = ? AND ref = ?
      LIMIT 1`,
    input.principalId,
    input.source,
    input.ref,
  );
  if (row === undefined) return undefined;
  return {
    text: row.text,
    conversationId: row.conversation_id ?? undefined,
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
  };
}
