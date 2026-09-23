import {
  type Instant,
  type PairInvite,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Peers and pairing
 * ------------------------------------------------------------------ */

/** A node this one knows, and whether a person has confirmed it yet. */
export interface PeerRecord {
  peerNodeId: string;
  endpoint: string;
  publicKey: string;
  fingerprint: string;
  /** sha256 of the token the peer presents to this node; the token itself is never stored. */
  tokenHash: string;
  pairedAt: Instant;
  /** Null while the pairing is pending, which is a state that admits no envelope. */
  trustedAt: Instant | null;
  revokedAt: Instant | null;
}

interface PeerRow {
  peer_node_id: string;
  endpoint: string;
  public_key: string;
  fingerprint: string;
  token_hash: string;
  paired_at: string;
  trusted_at: string | null;
  revoked_at: string | null;
}

function toPeerRecord(row: PeerRow): PeerRecord {
  return {
    peerNodeId: row.peer_node_id,
    endpoint: row.endpoint,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    tokenHash: row.token_hash,
    pairedAt: row.paired_at as Instant,
    trustedAt: row.trusted_at === null ? null : (row.trusted_at as Instant),
    revokedAt: row.revoked_at === null ? null : (row.revoked_at as Instant),
  };
}

export function createPairInvite(db: Database, invite: PairInvite): void {
  db.prepare(
    `INSERT INTO pair_invites (invite_id, issuer_node_id, endpoint, fingerprint, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(invite.inviteId, invite.issuerNodeId, invite.endpoint, invite.fingerprint, invite.createdAt, invite.expiresAt);
}

export function getPairInvite(db: Database, inviteId: string): PairInvite | undefined {
  const row = oneRow<{
    invite_id: string;
    issuer_node_id: string;
    endpoint: string;
    fingerprint: string;
    created_at: string;
    expires_at: string;
    claimed_at: string | null;
  }>(
    db,
    `SELECT invite_id, issuer_node_id, endpoint, fingerprint, created_at, expires_at, claimed_at
       FROM pair_invites WHERE invite_id = ?`,
    inviteId,
  );
  if (row === undefined) return undefined;
  return {
    inviteId: row.invite_id,
    issuerNodeId: row.issuer_node_id,
    endpoint: row.endpoint,
    fingerprint: row.fingerprint,
    createdAt: row.created_at as Instant,
    expiresAt: row.expires_at as Instant,
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at as Instant }),
  };
}

/**
 * Claim an invite, once.
 *
 * Single use is enforced by the UPDATE rather than by reading the row and then writing it, because
 * two claims arriving together must not both see "unclaimed". The WHERE clause makes the database
 * the thing that decides, which is the only version of this rule that survives a race.
 */
export function claimPairInvite(db: Database, inviteId: string, claimedBy: string, at: Instant): boolean {
  const result = db
    .prepare("UPDATE pair_invites SET claimed_at = ?, claimed_by = ? WHERE invite_id = ? AND claimed_at IS NULL")
    .run(at, claimedBy, inviteId);
  return Number(result.changes) > 0;
}

export function upsertPeer(db: Database, peer: PeerRecord): void {
  db.prepare(
    `INSERT INTO peers (peer_node_id, endpoint, public_key, fingerprint, token_hash, paired_at, trusted_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(peer_node_id) DO UPDATE SET
       endpoint = excluded.endpoint,
       public_key = excluded.public_key,
       fingerprint = excluded.fingerprint,
       token_hash = excluded.token_hash,
       trusted_at = excluded.trusted_at,
       revoked_at = excluded.revoked_at`,
  ).run(
    peer.peerNodeId,
    peer.endpoint,
    peer.publicKey,
    peer.fingerprint,
    peer.tokenHash,
    peer.pairedAt,
    peer.trustedAt,
    peer.revokedAt,
  );
}

export function getPeer(db: Database, peerNodeId: string): PeerRecord | undefined {
  const row = oneRow<PeerRow>(db, "SELECT * FROM peers WHERE peer_node_id = ?", peerNodeId);
  return row === undefined ? undefined : toPeerRecord(row);
}

/**
 * Find the peer a presented token belongs to.
 *
 * The lookup is by the hash, which is why the column is uniquely indexed: two peers sharing a token
 * would make this ambiguous about which node a request came from, and that identity is exactly what
 * every inbound envelope is validated against.
 */
export function findPeerByTokenHash(db: Database, tokenHash: string): PeerRecord | undefined {
  const row = oneRow<PeerRow>(db, "SELECT * FROM peers WHERE token_hash = ?", tokenHash);
  return row === undefined ? undefined : toPeerRecord(row);
}

export function listPeers(db: Database): PeerRecord[] {
  return allRows<PeerRow>(db, "SELECT * FROM peers ORDER BY paired_at").map(toPeerRecord);
}

/**
 * Trust a peer.
 *
 * Idempotent, so a person pressing the button twice is not told the second press failed: the first
 * confirmation is the one that is kept. A revoked peer cannot be confirmed back to life here.
 */
export function confirmPeer(db: Database, peerNodeId: string, at: Instant): boolean {
  const result = db
    .prepare(
      "UPDATE peers SET trusted_at = COALESCE(trusted_at, ?) WHERE peer_node_id = ? AND revoked_at IS NULL",
    )
    .run(at, peerNodeId);
  return Number(result.changes) > 0;
}

export function revokePeer(db: Database, peerNodeId: string, at: Instant): boolean {
  const result = db
    .prepare("UPDATE peers SET revoked_at = ? WHERE peer_node_id = ? AND revoked_at IS NULL")
    .run(at, peerNodeId);
  return Number(result.changes) > 0;
}
