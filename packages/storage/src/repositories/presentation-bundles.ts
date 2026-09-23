import {
  type Instant,
  type StoredPresentationBundle,
  storedPresentationBundleSchema,
} from "@clarkcant/contracts";

import { type Database, oneRow, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Presentation bundles
 * ------------------------------------------------------------------ */

/**
 * Write a materialised snapshot.
 *
 * A plain insert, deliberately. There is no upsert path because a bundle that can be rewritten
 * is not a snapshot, and the failure worth engineering for here is the accidental overwrite
 * that makes yesterday's message show today's numbers.
 */
export function insertPresentationBundle(db: Database, bundle: StoredPresentationBundle): void {
  const parsed = storedPresentationBundleSchema.parse(bundle);
  db.prepare(
    `INSERT INTO presentation_bundles
       (bundle_id, snapshot_id, message_id, instance_id, owner_principal_id, byte_size, document, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    parsed.bundleId,
    parsed.snapshotId,
    parsed.messageId,
    parsed.instanceId,
    parsed.ownerPrincipalId,
    parsed.byteSize,
    toJson(parsed),
    parsed.capturedAt,
  );
}

export function getPresentationBundle(
  db: Database,
  bundleId: string,
  principalId: string,
): StoredPresentationBundle | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM presentation_bundles WHERE bundle_id = ? AND owner_principal_id = ?",
    bundleId,
    principalId,
  );
  return row === undefined
    ? undefined
    : storedPresentationBundleSchema.parse(parseJson<unknown>(row.document, "presentation_bundles.document"));
}

/** The bundle a message captured, if any. */
export function findBundleForMessage(
  db: Database,
  messageId: string,
  principalId: string,
): StoredPresentationBundle | undefined {
  const row = oneRow<{ document: string }>(
    db,
    `SELECT document FROM presentation_bundles
      WHERE message_id = ? AND owner_principal_id = ? ORDER BY created_at DESC LIMIT 1`,
    messageId,
    principalId,
  );
  return row === undefined
    ? undefined
    : storedPresentationBundleSchema.parse(parseJson<unknown>(row.document, "presentation_bundles.document"));
}

/** Which bundle, if any, the given snapshot captured. Absent means a legacy or unbundled row. */
export function findBundleForSnapshot(
  db: Database,
  snapshotId: string,
  principalId: string,
): StoredPresentationBundle | undefined {
  const row = oneRow<{ document: string }>(
    db,
    `SELECT document FROM presentation_bundles
      WHERE snapshot_id = ? AND owner_principal_id = ? ORDER BY created_at DESC LIMIT 1`,
    snapshotId,
    principalId,
  );
  return row === undefined
    ? undefined
    : storedPresentationBundleSchema.parse(parseJson<unknown>(row.document, "presentation_bundles.document"));
}

/**
 * Replace a bundle with a tombstone.
 *
 * Retention and deletion are server concerns: a message outlives the data it displayed, and
 * the honest outcomes are "still here" and "removed, and here is why". Silently dropping the
 * bundle would make a deliberate deletion look indistinguishable from a rendering fault.
 */
export function tombstonePresentationBundle(
  db: Database,
  bundleId: string,
  reason: string,
  at: Instant,
): boolean {
  const row = oneRow<{ document: string; deleted_at: string | null }>(
    db,
    "SELECT document, deleted_at FROM presentation_bundles WHERE bundle_id = ?",
    bundleId,
  );
  if (row === undefined || row.deleted_at !== null) return false;
  const parsed = parseJson<Record<string, unknown>>(row.document, "presentation_bundles.document");
  const next: Record<string, unknown> = {
    ...parsed,
    sections: [],
    tombstone: { reason: reason.slice(0, 200), at },
  };
  db.prepare("UPDATE presentation_bundles SET deleted_at = ?, tombstone_reason = ?, document = ? WHERE bundle_id = ?").run(
    at,
    reason.slice(0, 200),
    toJson(next),
    bundleId,
  );
  return true;
}

/** Hard removal, for a retention job that must not leave a document behind at all. */
export function deletePresentationBundle(db: Database, bundleId: string): boolean {
  const result = db.prepare("DELETE FROM presentation_bundles WHERE bundle_id = ?").run(bundleId);
  return Number(result.changes) > 0;
}

export function countPresentationBundles(db: Database, principalId: string): number {
  const row = oneRow<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM presentation_bundles WHERE owner_principal_id = ? AND deleted_at IS NULL",
    principalId,
  );
  return Number(row?.n ?? 0);
}
