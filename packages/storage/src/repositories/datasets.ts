import {
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Datasets
 * ------------------------------------------------------------------ */

export interface DatasetView {
  datasetId: string;
  originNodeId: string;
  rowCount: number;
  /** Never inferred: a cached read must be labelled as cached, not as live. */
  freshness: "live" | "cached" | "sample" | "unknown";
  updatedAt: string;
  document: unknown;
}

/**
 * Store a dataset view.
 *
 * Datasets are addressed by an opaque reference rather than inlined into the timeline, so
 * a large result set never enters the transcript and the client can be told how fresh the
 * data is at the moment it renders it.
 */
/**
 * An artifact as the node records it.
 *
 * `blobPath` is deliberately absent. It is a path inside the node's own data directory, and a
 * client has no use for it beyond learning the layout of somebody's disk — so the one place that
 * reads bytes from it is the node, and everything downstream sees facts about the artifact rather
 * than where it happens to live.
 */
export interface ArtifactRecord {
  artifactId: string;
  digest: string;
  sizeBytes: number;
  mimeType: string;
  classification: string;
  originNodeId: string;
  createdAt: Instant;
  /** Absent means it does not expire. */
  expiresAt: Instant | undefined;
}

export function upsertArtifact(
  db: Database,
  input: {
    artifactId: string;
    digest: string;
    sizeBytes: number;
    mimeType: string;
    classification: string;
    originNodeId: string;
    blobPath?: string;
    createdAt: Instant;
    expiresAt?: Instant;
  },
): void {
  db.prepare(
    `INSERT INTO artifacts (artifact_id, digest, size_bytes, mime_type, classification, origin_node_id, blob_path, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artifact_id) DO UPDATE SET
       digest = excluded.digest,
       size_bytes = excluded.size_bytes,
       mime_type = excluded.mime_type,
       classification = excluded.classification,
       origin_node_id = excluded.origin_node_id,
       blob_path = excluded.blob_path,
       expires_at = excluded.expires_at`,
  ).run(
    input.artifactId,
    input.digest,
    input.sizeBytes,
    input.mimeType,
    input.classification,
    input.originNodeId,
    input.blobPath ?? null,
    input.createdAt,
    input.expiresAt ?? null,
  );
}

/**
 * Read an artifact, expired or not.
 *
 * Expiry is reported rather than filtered out on purpose: an expired artifact that reads as `missing` tells
 * the user their file never existed, when the truth is that the node had it and a retention window passed.
 * The distinction is the difference between "ask for it again" and "something is wrong".
 */
export function getArtifact(db: Database, artifactId: string): ArtifactRecord | undefined {
  const row = oneRow<{
    artifact_id: string;
    digest: string;
    size_bytes: number;
    mime_type: string;
    classification: string;
    origin_node_id: string;
    created_at: string;
    expires_at: string | null;
  }>(
    db,
    `SELECT artifact_id, digest, size_bytes, mime_type, classification, origin_node_id, created_at, expires_at
       FROM artifacts WHERE artifact_id = ?`,
    artifactId,
  );
  if (row === undefined) return undefined;
  return {
    artifactId: row.artifact_id,
    digest: row.digest,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    classification: row.classification,
    originNodeId: row.origin_node_id,
    createdAt: row.created_at as Instant,
    expiresAt: (row.expires_at ?? undefined) as Instant | undefined,
  };
}

export function upsertDataset(
  db: Database,
  input: {
    datasetId: string;
    originNodeId: string;
    rowCount: number;
    freshness: DatasetView["freshness"];
    updatedAt: Instant;
    document: unknown;
    /**
     * Whose data this is. Omitted means node-scoped, which is what the built-in sample is and
     * what a dataset registered for the node itself would be.
     */
    ownerPrincipalId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, origin_node_id, row_count, freshness, updated_at, document, owner_principal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dataset_id) DO UPDATE SET
       row_count = excluded.row_count,
       freshness = excluded.freshness,
       updated_at = excluded.updated_at,
       document = excluded.document,
       owner_principal_id = excluded.owner_principal_id`,
  ).run(
    input.datasetId,
    input.originNodeId,
    input.rowCount,
    input.freshness,
    input.updatedAt,
    toJson(input.document),
    input.ownerPrincipalId ?? null,
  );
}

/**
 * Read a dataset for one principal.
 *
 * Node-scoped datasets (owner NULL) are readable by anyone on the node; a dataset derived for one
 * person is readable only by them. The filter lives in the query rather than in a caller check,
 * because the caller that forgets it is the one that returns somebody else's rows.
 */
export function getDatasetForPrincipal(
  db: Database,
  datasetId: string,
  principalId: string,
): DatasetView | undefined {
  const row = oneRow<{ owner_principal_id: string | null }>(
    db,
    "SELECT owner_principal_id FROM datasets WHERE dataset_id = ?",
    datasetId,
  );
  if (row === undefined) return undefined;
  if (row.owner_principal_id !== null && row.owner_principal_id !== principalId) return undefined;
  return getDataset(db, datasetId);
}

/** Datasets this principal owns, newest first. Used to clean up derived views. */
export function listDatasetsForPrincipal(db: Database, principalId: string, limit = 50): DatasetView[] {
  const rows = allRows<{ dataset_id: string }>(
    db,
    "SELECT dataset_id FROM datasets WHERE owner_principal_id = ? ORDER BY updated_at DESC LIMIT ?",
    principalId,
    limit,
  );
  return rows.flatMap((row) => {
    const dataset = getDataset(db, row.dataset_id);
    return dataset === undefined ? [] : [dataset];
  });
}

export function getDataset(db: Database, datasetId: string): DatasetView | undefined {
  const row = oneRow<{
    dataset_id: string;
    origin_node_id: string;
    row_count: number;
    freshness: string;
    updated_at: string;
    document: string;
  }>(
    db,
    "SELECT dataset_id, origin_node_id, row_count, freshness, updated_at, document FROM datasets WHERE dataset_id = ?",
    datasetId,
  );
  if (!row) return undefined;
  return {
    datasetId: row.dataset_id,
    originNodeId: row.origin_node_id,
    rowCount: Number(row.row_count),
    freshness: row.freshness as DatasetView["freshness"],
    updatedAt: row.updated_at,
    document: parseJson<unknown>(row.document, "datasets.document"),
  };
}
