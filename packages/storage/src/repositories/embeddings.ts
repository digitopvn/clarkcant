import { type Database, allRows, oneRow, transaction } from "../db.ts";
import { type HistorySource } from "./history.ts";

/* ------------------------------------------------------------------ *
 * Embeddings (Phase 10)
 * ------------------------------------------------------------------ */

export interface EmbeddingIndexState {
  count: number;
  /** The model that produced the vectors already stored, when there are any. */
  model: string | undefined;
  dims: number | undefined;
}

/** What is already embedded, and with which model. */
export function embeddingIndexState(db: Database, principalId: string): EmbeddingIndexState {
  const row = oneRow<{ n: number; model: string | null; dims: number | null }>(
    db,
    "SELECT COUNT(*) AS n, MIN(model) AS model, MIN(dims) AS dims FROM history_embeddings_meta WHERE principal_id = ?",
    principalId,
  );
  return {
    count: Number(row?.n ?? 0),
    model: row?.model ?? undefined,
    dims: row?.dims === null || row?.dims === undefined ? undefined : Number(row.dims),
  };
}

/**
 * Create the vector table, if the extension is loaded and the dimensions agree.
 *
 * Deliberately not part of a migration. A `vec0` table can only be created by a connection with
 * sqlite-vec loaded, and a migration runs on every machine whether or not that optional dependency
 * is installed — putting it in a migration would make the schema depend on an optional package, and
 * a database created without it could never grow the table later. Cosine distance is declared here
 * because these are E5 embeddings, where angle is the signal and magnitude is not.
 */
export function ensureEmbeddingTable(
  db: Database,
  dims: number,
): { ok: true } | { ok: false; reason: string } {
  const existing = oneRow<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE name = 'history_vec'",
  );
  if (existing !== undefined) {
    if (!existing.sql.includes(`float[${dims}]`)) {
      return {
        ok: false,
        reason: `history_vec holds ${existing.sql.match(/float\[(\d+)\]/)?.[1] ?? "unknown"}-dimension vectors, not ${dims}`,
      };
    }
    return { ok: true };
  }

  try {
    db.exec(
      `CREATE VIRTUAL TABLE history_vec USING vec0(embedding float[${dims}] distance_metric=cosine)`,
    );
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Insert one vector and return the rowid vec0 assigned it. */
export function insertEmbedding(db: Database, values: readonly number[]): number {
  const result = db
    .prepare("INSERT INTO history_vec(embedding) VALUES (?)")
    .run(JSON.stringify([...values]));
  return Number(result.lastInsertRowid);
}

export function deleteEmbedding(db: Database, vecRowid: number): void {
  db.prepare("DELETE FROM history_vec WHERE rowid = ?").run(vecRowid);
}

export interface EmbeddingMetaInput {
  source: HistorySource;
  ref: string;
  principalId: string;
  model: string;
  dims: number;
  digest: string;
  vecRowid: number;
  createdAt: string;
}

/**
 * Record that a row has a vector, replacing any previous vector for it.
 *
 * The old vector is deleted first so a re-index cannot leave two vectors for one ref, which would
 * make the same sentence appear twice in results that are supposed to be ranked.
 */
export function upsertEmbeddingMeta(db: Database, input: EmbeddingMetaInput): void {
  transaction(db, () => {
    const existing = oneRow<{ vec_rowid: number }>(
      db,
      "SELECT vec_rowid FROM history_embeddings_meta WHERE source = ? AND ref = ?",
      input.source,
      input.ref,
    );
    if (existing !== undefined) {
      deleteEmbedding(db, Number(existing.vec_rowid));
    }
    db.prepare(
      `INSERT INTO history_embeddings_meta
         (source, ref, principal_id, model, dims, digest, vec_rowid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, ref) DO UPDATE SET
         principal_id = excluded.principal_id,
         model = excluded.model,
         dims = excluded.dims,
         digest = excluded.digest,
         vec_rowid = excluded.vec_rowid,
         created_at = excluded.created_at`,
    ).run(
      input.source,
      input.ref,
      input.principalId,
      input.model,
      input.dims,
      input.digest,
      input.vecRowid,
      input.createdAt,
    );
  });
}

export function countEmbeddings(db: Database, principalId: string): number {
  const row = oneRow<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM history_embeddings_meta WHERE principal_id = ?",
    principalId,
  );
  return Number(row?.n ?? 0);
}

/** History rows with no vector yet, so an embed pass can resume rather than restart. */
export function historyMissingEmbedding(
  db: Database,
  input: { principalId: string; model: string; limit: number },
): { source: HistorySource; ref: string; text: string; createdAt: string }[] {
  return allRows<{ source: string; ref: string; text: string; created_at: string }>(
    db,
    `SELECT f.source AS source, f.ref AS ref, f.text AS text, f.created_at AS created_at
       FROM history_fts f
       LEFT JOIN history_embeddings_meta m
              ON m.source = f.source AND m.ref = f.ref AND m.model = ?
      WHERE f.principal_id = ? AND m.ref IS NULL
      ORDER BY f.created_at DESC
      LIMIT ?`,
    input.model,
    input.principalId,
    input.limit,
  ).map((row) => ({
    source: row.source as HistorySource,
    ref: row.ref,
    text: row.text,
    createdAt: row.created_at,
  }));
}

export interface SemanticHit {
  source: HistorySource;
  ref: string;
  /** Cosine distance. Lower is closer, which is sqlite-vec's convention. */
  distance: number;
}

/**
 * Exact KNN over the embedded history for one principal.
 *
 * `k` is fetched larger than the caller asked for because the principal filter is applied here rather
 * than inside the index walk: the search must not return another principal's row even transiently.
 */
export function searchEmbedding(
  db: Database,
  input: { values: readonly number[]; limit: number; principalId: string },
): SemanticHit[] {
  const rows = allRows<{ source: string; ref: string; distance: number }>(
    db,
    `SELECT m.source AS source, m.ref AS ref, v.distance AS distance
       FROM history_vec v
       JOIN history_embeddings_meta m ON m.vec_rowid = v.rowid
      WHERE v.embedding MATCH ? AND k = ? AND m.principal_id = ?
      ORDER BY v.distance`,
    JSON.stringify([...input.values]),
    input.limit * 4,
    input.principalId,
  );
  return rows
    .slice(0, input.limit)
    .map((row) => ({
      source: row.source as HistorySource,
      ref: row.ref,
      distance: Number(row.distance),
    }));
}
