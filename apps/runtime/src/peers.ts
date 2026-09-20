import { createHash, createHmac } from "node:crypto";

import { type Instant, type PairInvite, claimInvite } from "@clarkcant/contracts";
import {
  type Database,
  type PeerRecord,
  claimPairInvite,
  confirmPeer as confirmPeerRow,
  createPairInvite,
  findPeerByTokenHash,
  getPairInvite,
  getPeer,
  listPeers as listPeerRows,
  revokePeer as revokePeerRow,
  upsertPeer,
} from "@clarkcant/storage";

import { type NodeIdentity, fingerprintOf } from "./node.ts";

/**
 * Pairing two nodes, and the peer channel that follows it.
 *
 * The trust is deliberately small. An invitation is an introduction, not a credential: claiming it
 * establishes only that two nodes know each other's identity, and nothing on either node becomes
 * reachable. A person then confirms the pairing, and only a confirmed peer's envelopes are accepted
 * at all - a pending peer is refused rather than queued.
 *
 * Tokens are derived rather than exchanged. A node presents `HMAC(localToken, peerNodeId)` to the
 * peer, and the peer stores only the sha256 of that. So no credential crosses the wire while
 * pairing and none sits at rest afterwards, and a copy of a node's database cannot be replayed at
 * the peer it was paired with.
 */

/** How long an invitation stays usable. Short, because it is meant to be read out to somebody. */
export const INVITE_TTL_MS = 10 * 60 * 1000;

/** The token this node presents to a peer. Derived, so there is nothing to store or leak. */
export function outboundPeerToken(localToken: string, peerNodeId: string): string {
  return createHmac("sha256", localToken).update(`peer:${peerNodeId}`).digest("base64url");
}

/** What the peer keeps: the hash, never the token. */
export function peerTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** What one node tells the other about itself, which is everything the other needs to record it. */
export interface PeerOffer {
  nodeId: string;
  label: string;
  endpoint: string;
  publicKey: string;
  fingerprint: string;
  /** Hash of the token this node will present to the peer. The token itself never travels. */
  tokenHash: string;
}

export interface PairingDeps {
  db: Database;
  identity: NodeIdentity;
  now: () => Instant;
  newId: (prefix: string) => string;
}

/** This node's offer to a peer, minus the token hash, which depends on who the peer is. */
export function selfDescription(deps: PairingDeps, endpoint: string): Omit<PeerOffer, "tokenHash"> {
  return {
    nodeId: deps.identity.nodeId,
    label: deps.identity.label,
    endpoint,
    publicKey: deps.identity.publicKey,
    fingerprint: deps.identity.fingerprint,
  };
}

/** The offer this node would make to a specific peer, including the token hash it will present. */
export function selfOfferFor(deps: PairingDeps, endpoint: string, peerNodeId: string): PeerOffer {
  return {
    ...selfDescription(deps, endpoint),
    tokenHash: peerTokenHash(outboundPeerToken(deps.identity.localToken, peerNodeId)),
  };
}

/** Create a single-use invitation. */
export function createInvite(deps: PairingDeps, input: { endpoint: string }): PairInvite {
  const createdAt = deps.now();
  const invite: PairInvite = {
    inviteId: deps.newId("invite"),
    issuerNodeId: deps.identity.nodeId,
    endpoint: input.endpoint,
    // The fingerprint, not the endpoint: a person comparing two machines must be comparing keys, or
    // a name that resolves somewhere else is enough to be trusted.
    fingerprint: deps.identity.fingerprint,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + INVITE_TTL_MS).toISOString() as Instant,
  };
  createPairInvite(deps.db, invite);
  return invite;
}

export type ClaimOutcome =
  | { ok: true; peer: PeerRecord; issuerTokenHash: string }
  | {
      ok: false;
      code: "INVITE_UNKNOWN" | "INVITE_EXPIRED" | "INVITE_ALREADY_CLAIMED" | "FINGERPRINT_MISMATCH";
      message: string;
    };

/**
 * Claim an invitation, on the issuer's side.
 *
 * The peer arrives with its own identity and the hash of the token it will present. The fingerprint
 * it offers is checked against the key it offers, because "compare the fingerprint" is advice about
 * a value nothing verifies unless this check exists.
 *
 * The result is a peer that is recorded and **pending**. Nothing about this call makes the peer
 * trusted, so a stolen invitation buys an attacker a row in a table and no reach.
 */
export function claimInviteFrom(
  deps: PairingDeps,
  input: { inviteId: string; offer: PeerOffer },
): ClaimOutcome {
  const stored = getPairInvite(deps.db, input.inviteId);
  if (stored === undefined) {
    return {
      ok: false,
      code: "INVITE_UNKNOWN",
      message: "no invitation with that id was issued by this node",
    };
  }

  // The contract owns expiry and the already-claimed check, so the two answers cannot drift apart
  // between the node that issues an invitation and the node that reads it.
  const claim = claimInvite(stored, deps.now());
  if (!claim.ok) {
    return { ok: false, code: claim.code, message: claim.message };
  }

  if (fingerprintOf(input.offer.publicKey) !== input.offer.fingerprint) {
    return {
      ok: false,
      code: "FINGERPRINT_MISMATCH",
      message: "the offered fingerprint does not name the offered key",
    };
  }

  // Recorded in the database rather than in memory, so two claims arriving at the same moment cannot
  // both see "unclaimed": the UPDATE is what decides, not the read above it.
  if (!claimPairInvite(deps.db, stored.inviteId, input.offer.nodeId, deps.now())) {
    return {
      ok: false,
      code: "INVITE_ALREADY_CLAIMED",
      message: "that invitation was claimed by somebody else first",
    };
  }

  const peer: PeerRecord = {
    peerNodeId: input.offer.nodeId,
    endpoint: input.offer.endpoint,
    publicKey: input.offer.publicKey,
    fingerprint: input.offer.fingerprint,
    tokenHash: input.offer.tokenHash,
    pairedAt: deps.now(),
    trustedAt: null,
    revokedAt: null,
  };
  upsertPeer(deps.db, peer);

  return {
    ok: true,
    peer,
    // What this node stores so it can authenticate the peer's envelopes later: the hash of the token
    // the peer derived for us. Sent back as a hash, so no credential is on the wire either way.
    issuerTokenHash: peerTokenHash(outboundPeerToken(deps.identity.localToken, input.offer.nodeId)),
  };
}

/**
 * Record a peer that accepted our claim.
 *
 * The other half of `claimInviteFrom`: this node reached out, the peer recorded us, and here is what
 * it told us about itself. Still pending until a person confirms it.
 */
export function recordAcceptedClaim(
  deps: PairingDeps,
  input: { offer: Omit<PeerOffer, "tokenHash">; tokenHash: string },
): PeerRecord {
  const peer: PeerRecord = {
    peerNodeId: input.offer.nodeId,
    endpoint: input.offer.endpoint,
    publicKey: input.offer.publicKey,
    fingerprint: input.offer.fingerprint,
    tokenHash: input.tokenHash,
    pairedAt: deps.now(),
    trustedAt: null,
    revokedAt: null,
  };
  upsertPeer(deps.db, peer);
  return peer;
}

/**
 * The peer a presented token belongs to, if any.
 *
 * Looked up by hash, so the token is never compared byte by byte and its length cannot be probed.
 * A revoked or pending peer is returned as no peer at all: both states admit no envelope, and the
 * caller should not be able to tell them apart from the outside.
 */
export function authenticatePeer(deps: PairingDeps, presented: string | undefined): PeerRecord | undefined {
  if (presented === undefined || presented === "") return undefined;
  const peer = findPeerByTokenHash(deps.db, peerTokenHash(presented));
  if (peer === undefined || peer.revokedAt !== null || peer.trustedAt === null) return undefined;
  return peer;
}

/** Trust a peer. A person's decision, and the only thing that makes envelopes acceptable. */
export function confirmPeer(deps: PairingDeps, peerNodeId: string): boolean {
  return confirmPeerRow(deps.db, peerNodeId, deps.now());
}

export function revokePeer(deps: PairingDeps, peerNodeId: string): boolean {
  return revokePeerRow(deps.db, peerNodeId, deps.now());
}

export function peers(deps: PairingDeps): PeerRecord[] {
  return listPeerRows(deps.db);
}

export function peer(deps: PairingDeps, peerNodeId: string): PeerRecord | undefined {
  return getPeer(deps.db, peerNodeId);
}
