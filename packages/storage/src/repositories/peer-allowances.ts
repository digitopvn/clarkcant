import type { Grant, Instant } from "@clarkcant/contracts";

import { type Database, oneRow, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Peer allowances: what this node's owner lets a paired node run here
 * ------------------------------------------------------------------ */

export interface PeerAllowance {
  peerNodeId: string;
  ownerPrincipalId: string;
  /** Where the owner set it up, which is where work a peer hands over is reported. */
  conversationId: string;
  /** Written as a grant from the peer to this node, so it intersects with the peer's own grant field by field. */
  grant: Grant;
  createdAt: Instant;
  updatedAt: Instant;
  revokedAt?: Instant;
}

interface AllowanceRow {
  peer_node_id: string;
  owner_principal_id: string;
  conversation_id: string;
  document: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: AllowanceRow): PeerAllowance {
  return {
    peerNodeId: row.peer_node_id,
    ownerPrincipalId: row.owner_principal_id,
    conversationId: row.conversation_id,
    grant: parseJson<Grant>(row.document, "peer_allowances.document"),
    createdAt: row.created_at as Instant,
    updatedAt: row.updated_at as Instant,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at as Instant }),
  };
}

/** Write the allowance for a peer, replacing the one before: a person saying it again means what they said last. */
export function putPeerAllowance(
  db: Database,
  input: { peerNodeId: string; ownerPrincipalId: string; conversationId: string; grant: Grant; at: Instant },
): void {
  db.prepare(
    `INSERT INTO peer_allowances (peer_node_id, owner_principal_id, conversation_id, document, expires_at, revoked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(peer_node_id) DO UPDATE SET
       owner_principal_id = excluded.owner_principal_id,
       conversation_id = excluded.conversation_id,
       document = excluded.document,
       expires_at = excluded.expires_at,
       revoked_at = NULL,
       updated_at = excluded.updated_at`,
  ).run(
    input.peerNodeId,
    input.ownerPrincipalId,
    input.conversationId,
    toJson(input.grant),
    input.grant.expiresAt,
    input.at,
    input.at,
  );
}

/** The allowance for a peer as written, withdrawn or not. */
export function getPeerAllowance(db: Database, peerNodeId: string): PeerAllowance | undefined {
  const row = oneRow<AllowanceRow>(db, "SELECT * FROM peer_allowances WHERE peer_node_id = ?", peerNodeId);
  return row === undefined ? undefined : fromRow(row);
}

/** The allowance in force for a peer now: not withdrawn and not expired. */
export function livePeerAllowance(db: Database, peerNodeId: string, at: Instant): PeerAllowance | undefined {
  const row = oneRow<AllowanceRow>(
    db,
    "SELECT * FROM peer_allowances WHERE peer_node_id = ? AND revoked_at IS NULL AND expires_at > ?",
    peerNodeId,
    at,
  );
  return row === undefined ? undefined : fromRow(row);
}

export function revokePeerAllowance(db: Database, peerNodeId: string, at: Instant): boolean {
  const result = db
    .prepare("UPDATE peer_allowances SET revoked_at = ?, updated_at = ? WHERE peer_node_id = ? AND revoked_at IS NULL")
    .run(at, at, peerNodeId);
  return Number(result.changes) > 0;
}
