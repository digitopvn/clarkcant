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

/** One grant. A revocation is recorded in its own column, so it is read from there rather than from the stored document. */
export function getGrant(db: Database, grantId: string): Grant | undefined {
  const row = oneRow<{ document: string; revoked_at: string | null }>(
    db,
    "SELECT document, revoked_at FROM grants WHERE grant_id = ?",
    grantId,
  );
  if (row === undefined) return undefined;
  const grant = parseJson<Grant>(row.document, "grants.document");
  return row.revoked_at === null ? grant : { ...grant, revokedAt: row.revoked_at as Instant };
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

/**
 * Every grant id a sender ever gave this node, live or not. What a hand-over may name to be heard at all: one under an
 * expired or revoked grant is then answered with why it does not run, rather than refused unheard.
 */
export function grantIdsFrom(db: Database, senderNodeId: string): Set<string> {
  const rows = allRows<{ grant_id: string }>(db, "SELECT grant_id FROM grants WHERE sender_node_id = ?", senderNodeId);
  return new Set(rows.map((row) => row.grant_id));
}

export function revokeGrant(db: Database, grantId: string, at: Instant): boolean {
  const result = db.prepare("UPDATE grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(at, grantId);
  return Number(result.changes) > 0;
}
