import {
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Local images
 * ------------------------------------------------------------------ */

export interface LocalImageRecord {
  imageId: string;
  ownerPrincipalId: string;
  nodeId: string;
  artifactId: string;
  mimeType: string;
  byteSize: number;
  width: number | undefined;
  height: number | undefined;
  digest: string;
  altText: string;
  blobPath: string;
  createdAt: string;
}

export function insertLocalImage(db: Database, input: LocalImageRecord): void {
  db.prepare(
    `INSERT INTO local_images
       (image_id, owner_principal_id, node_id, artifact_id, mime_type, byte_size, width, height,
        digest, alt_text, blob_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.imageId,
    input.ownerPrincipalId,
    input.nodeId,
    input.artifactId,
    input.mimeType,
    input.byteSize,
    input.width ?? null,
    input.height ?? null,
    input.digest,
    input.altText,
    input.blobPath,
    input.createdAt,
  );
}

export function getLocalImage(db: Database, imageId: string, principalId: string): LocalImageRecord | undefined {
  const row = oneRow<Record<string, unknown>>(
    db,
    "SELECT * FROM local_images WHERE image_id = ? AND owner_principal_id = ? AND deleted_at IS NULL",
    imageId,
    principalId,
  );
  return row === undefined ? undefined : mapLocalImage(row);
}

export function listLocalImages(db: Database, principalId: string, limit = 100): LocalImageRecord[] {
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM local_images WHERE owner_principal_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
    principalId,
    limit,
  );
  return rows.map(mapLocalImage);
}

export function deleteLocalImage(db: Database, imageId: string, principalId: string, at: Instant): boolean {
  const result = db
    .prepare("UPDATE local_images SET deleted_at = ? WHERE image_id = ? AND owner_principal_id = ? AND deleted_at IS NULL")
    .run(at, imageId, principalId);
  return Number(result.changes) > 0;
}

function mapLocalImage(row: Record<string, unknown>): LocalImageRecord {
  return {
    imageId: String(row.image_id),
    ownerPrincipalId: String(row.owner_principal_id),
    nodeId: String(row.node_id),
    artifactId: String(row.artifact_id),
    mimeType: String(row.mime_type),
    byteSize: Number(row.byte_size),
    width: row.width === null || row.width === undefined ? undefined : Number(row.width),
    height: row.height === null || row.height === undefined ? undefined : Number(row.height),
    digest: String(row.digest),
    altText: String(row.alt_text),
    blobPath: String(row.blob_path),
    createdAt: String(row.created_at),
  };
}
