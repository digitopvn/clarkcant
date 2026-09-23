import {
  type Grant,
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Grants
 * ------------------------------------------------------------------ */

export function upsertGrant(db: Database, grant: Grant, createdAt: Instant): void {
  db.prepare(
    `INSERT INTO grants (grant_id, owner_principal_id, sender_node_id, receiver_node_id, document, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(grant_id) DO UPDATE SET
       document = excluded.document,
       expires_at = excluded.expires_at,
       revoked_at = excluded.revoked_at`,
  ).run(
    grant.grantId,
    grant.ownerPrincipalId,
    grant.senderNodeId,
    grant.receiverNodeId,
    toJson(grant),
    grant.expiresAt,
    grant.revokedAt ?? null,
    createdAt,
  );
}

export function getGrant(db: Database, grantId: string): Grant | undefined {
  const row = oneRow<{ document: string }>(db, "SELECT document FROM grants WHERE grant_id = ?", grantId);
  return row === undefined ? undefined : parseJson<Grant>(row.document, "grants.document");
}

/**
 * Live grants. A revoked grant is excluded here as well as at check time, so a
 * revoked key stops new delegations even before the next authorization pass.
 */
export function activeGrants(db: Database, senderNodeId: string, at: Instant): Grant[] {
  const rows = allRows<{ document: string }>(
    db,
    `SELECT document FROM grants
      WHERE sender_node_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    senderNodeId,
    at,
  );
  return rows.map((row) => parseJson<Grant>(row.document, "grants.document"));
}

export function revokeGrant(db: Database, grantId: string, at: Instant): boolean {
  const result = db.prepare("UPDATE grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(at, grantId);
  return Number(result.changes) > 0;
}
