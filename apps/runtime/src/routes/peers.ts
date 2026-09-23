import {
  type PeerEnvelope,
  type Instant,
  artifactOfferSchema,
  peerEnvelopeSchema,
  checkArtifactAcceptance,
  grantSchema,
} from "@clarkcant/contracts";
import { type Database, type JsonValue, activeGrants, upsertGrant } from "@clarkcant/storage";
import { type PeerGatewayDeps, receiveEnvelope } from "@clarkcant/node-link";

import { extensionForMimeType, fetchArtifactFromPeer } from "../artifact-transfer.ts";
import { blobPathForDigest, readBlob } from "../blobs.ts";
import type { NodeIdentity } from "../node.ts";
import {
  type PairingDeps,
  type PeerOffer,
  authenticatePeer,
  claimInviteFrom,
  confirmPeer,
  createInvite,
  peer as findPeer,
  peers as listPeers,
  outboundPeerToken,
  recordAcceptedClaim,
  revokePeer,
  selfDescription,
} from "../peers.ts";
import { type GatewayRequest, type GatewayResponse, bearer, fail, json, readJson } from "./http.ts";

/**
 * The peer family: what another node calls, and what the owner calls to pair one.
 *
 * The two halves are separated because they sit on opposite sides of the local token check. The uplink
 * routes are answered before it — a peer holds a derived token, never this node's — and the pairing
 * routes are answered after it, because each one is a decision about this machine.
 *
 * Every dependency is a parameter: the pairing seam the caller built, the node fields these routes
 * actually read, the request and the clock. Nothing here reads a module-level value that changes, so a
 * route cannot be handed state it was not given.
 */

/**
 * What the two unauthenticated peer routes need.
 *
 * `runtime` is narrowed to the artifacts directory rather than the whole node, so fetching an artifact
 * cannot read anything this route was not given.
 */
export interface PeerUplinkDeps {
  pairing: PairingDeps;
  runtime: { dataDir: string };
  request: GatewayRequest;
}

/**
 * What the pairing routes need.
 *
 * These are the owner's side, so they read the node's own database and identity — the grant route
 * checks that a grant names this node as its sender and this node's owner as its owner.
 */
export interface PairingRouteDeps {
  pairing: PairingDeps;
  runtime: { db: Database; identity: NodeIdentity };
  /** The clock the dispatch resolved, so a route and its caller agree on "now". */
  now: () => string;
  request: GatewayRequest;
  segments: string[];
}


/**
 * Read the identity a peer offers about itself.
 *
 * Every field is checked rather than trusted: this arrives from another machine and its values are
 * written into a peer row, so a claim missing a key, or carrying a token hash that is not a hash,
 * would otherwise become a peer that can never be authenticated and can never be explained either.
 */
function readPeerOffer(fields: Record<string, unknown>): PeerOffer | undefined {
  const read = (key: string): string => (typeof fields[key] === "string" ? (fields[key] as string) : "");
  const peer: PeerOffer = {
    nodeId: read("nodeId"),
    label: read("label"),
    endpoint: read("endpoint"),
    publicKey: read("publicKey"),
    fingerprint: read("fingerprint"),
    tokenHash: read("tokenHash"),
  };
  if (Object.values(peer).some((value) => value === "")) return undefined;
  return peer;
}

/** A claim body: an invitation id plus the identity of the node claiming it. */
function peerOfferFrom(body: Record<string, unknown>): { inviteId: string; peer: PeerOffer } | undefined {
  const inviteId = typeof body["inviteId"] === "string" ? body["inviteId"] : "";
  const node = body["node"];
  if (inviteId === "" || node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
  const peer = readPeerOffer(node as Record<string, unknown>);
  return peer === undefined ? undefined : { inviteId, peer };
}

/**
 * What a valid envelope from a confirmed peer means here.
 *
 * The handler runs only after the envelope has been recorded, so this is at most the second time the
 * node has seen the message. Its answer is stored with the inbox row, which is why a replay gets
 * these exact bytes rather than a second execution.
 */
function peerHandler(pairing: PairingDeps): (envelope: PeerEnvelope) => unknown {
  return (envelope) => {
    const at = pairing.now();

    if (envelope.kind === "pair.confirm") {
      // The grant that establishes a delegation. Validated rather than trusted: it arrives from
      // another machine and becomes the thing every later delegate envelope is checked against.
      const parsed = grantSchema.safeParse(envelope.payload["grant"]);
      if (!parsed.success) return { accepted: false, reason: "the grant is not a grant this node can read" };
      const grant = parsed.data;
      if (grant.senderNodeId !== envelope.senderNodeId || grant.receiverNodeId !== pairing.identity.nodeId) {
        return { accepted: false, reason: "the grant names nodes other than its sender and this node" };
      }
      if (Date.parse(grant.expiresAt) <= Date.parse(at)) {
        return { accepted: false, reason: "the grant has already expired" };
      }
      upsertGrant(pairing.db, grant, at);
      return { accepted: true, grantId: grant.grantId, allowedDataClasses: grant.allowedDataClasses };
    }

    if (envelope.kind === "delegate") {
      // The delegation id is the grant id, and the validator has already refused this envelope unless
      // that grant is live for this sender. So the narrowing happened before anything ran.
      return { accepted: true, acceptedAt: at, delegationId: envelope.delegationId ?? null };
    }

    if (envelope.kind === "artifact.offer") {
      // The payload wraps the offer in an `artifact` field and repeats the digest, size and
      // classification at the envelope level; the offer itself is what the acceptance check reads.
      const parsed = artifactOfferSchema.safeParse(envelope.payload["artifact"]);
      if (!parsed.success) return { accepted: false, reason: "the offer is not an artifact offer this node can read" };
      const policy = acceptancePolicy(pairing, envelope.senderNodeId);
      if (policy === undefined) return { accepted: false, reason: "this sender holds no live grant" };
      return checkArtifactAcceptance(parsed.data, policy);
    }

    if (envelope.kind === "status") {
      return { received: true, at, taskState: envelope.payload["taskState"] ?? null };
    }

    return { accepted: true, kind: envelope.kind };
  };
}

/**
 * What this node will accept from a peer right now.
 *
 * The intersection of every live grant from that sender, because the contract's own rule is that a
 * grant is narrowed by intersecting it and never widened by holding another. A sender with no live
 * grant can offer nothing, and a grant that sets no artifact budget grants none: the safe reading of
 * a silence is zero rather than unlimited.
 */
function acceptancePolicy(
  pairing: PairingDeps,
  senderNodeId: string,
): { allowedClassifications: ("public" | "internal" | "confidential" | "secret")[]; maxBytes: number; allowedMimePrefixes: string[] } | undefined {
  const grants = activeGrants(pairing.db, senderNodeId, pairing.now());
  if (grants.length === 0) return undefined;
  const classes = ["public", "internal", "confidential", "secret"] as const;
  const budgets = grants
    .map((grant) => grant.budget?.maxArtifactBytes)
    .filter((bytes): bytes is number => bytes !== undefined);
  return {
    allowedClassifications: classes.filter((one) => grants.every((grant) => grant.allowedDataClasses.includes(one))),
    maxBytes: budgets.length === 0 ? 0 : Math.min(...budgets),
    // The contract's own check refuses a mime type it does not know; this list is what this node is
    // willing to receive on top of that.
    allowedMimePrefixes: ["text/", "image/", "application/"],
  };
}

/**
 * The inbound half of the peer gateway, for one peer.
 *
 * `knownDelegationIds` is read from the live grants from that sender, which is what makes a delegate
 * envelope naming an unknown delegation a refusal rather than a guess.
 */
/** The artifact an accepted offer named, or nothing when this envelope is not one this node took. */
function acceptedArtifactOffer(
  raw: unknown,
  recorded: unknown,
): { digest: string; mimeType: string; sizeBytes: number } | undefined {
  const envelope = peerEnvelopeSchema.safeParse(raw);
  if (!envelope.success || envelope.data.kind !== "artifact.offer") return undefined;
  if ((recorded as { accepted?: boolean } | null)?.accepted !== true) return undefined;
  const offer = artifactOfferSchema.safeParse(envelope.data.payload["artifact"]);
  return offer.success
    ? { digest: offer.data.digest, mimeType: offer.data.mimeType, sizeBytes: offer.data.sizeBytes }
    : undefined;
}

/**
 * Fetch the bytes an accepted offer named, without holding the sender's acknowledgement open.
 *
 * The ceiling is the size the offer declared, and that is not a shortcut: the acceptance check has
 * already refused anything above the grant's budget, so the declared size is the number this node
 * agreed to. A peer that declares one size and sends another is refused by the transfer itself.
 */
function scheduleArtifactIntake(input: {
  runtime: { dataDir: string };
  pairing: PairingDeps;
  peerNodeId: string;
  intake: { digest: string; mimeType: string; sizeBytes: number };
}): void {
  const record = findPeer(input.pairing, input.peerNodeId);
  if (record === undefined || record.trustedAt === null || record.revokedAt !== null) return;

  void fetchArtifactFromPeer({
    dataDir: input.runtime.dataDir,
    endpoint: record.endpoint,
    token: outboundPeerToken(input.pairing.identity.localToken, input.peerNodeId),
    digest: input.intake.digest,
    extension: extensionForMimeType(input.intake.mimeType),
    maxBytes: input.intake.sizeBytes,
  })
    .then((result) => {
      process.stderr.write(
        result.ok
          ? `artifact: ${String(result.bytes)} byte(s) received from ${input.peerNodeId} as ${result.blobRef}\n`
          : `artifact: not received from ${input.peerNodeId} — ${result.message}\n`,
      );
    })
    .catch((cause: unknown) => {
      process.stderr.write(
        `artifact: not received from ${input.peerNodeId} — ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    });
}

function peerGateway(pairing: PairingDeps, peerNodeId: string): PeerGatewayDeps {
  return {
    db: pairing.db,
    nodeId: pairing.identity.nodeId,
    now: () => pairing.now(),
    newId: pairing.newId,
    // The window the contract's own negotiation test uses; a peer outside it is refused rather than
    // silently downgraded (T11).
    supportedVersions: { min: 1, max: 2 },
    knownDelegationIds: new Set(activeGrants(pairing.db, peerNodeId, pairing.now()).map((grant) => grant.grantId)),
    handler: peerHandler(pairing),
  };
}

/**
 * What a replay is answered with.
 *
 * A named shape rather than `unknown`, so the route cannot hand a caller something the contract does
 * not describe: either the outcome that was recorded, or the fact that the bytes on record are not
 * something this build can read.
 */
type RecordedOutcome =
  | { status: "recorded"; outcome: JsonValue }
  | { status: "unreadable"; recorded: string };

/**
 * Read a recorded outcome back.
 *
 * The bytes come out of this node's own inbox, but a row this build cannot read has to surface as an
 * unreadable record rather than as a thrown request: turning a retry into a 500 would lose the one
 * thing the inbox exists to preserve, which is what we already answered.
 */
function parseRecordedOutcome(responseJson: string): RecordedOutcome {
  try {
    return { status: "recorded", outcome: JSON.parse(responseJson) as JsonValue };
  } catch {
    return { status: "unreadable", recorded: responseJson };
  }
}

/**
 * The status a refused claim is answered with.
 *
 * A table rather than a chain of ternaries, because the codes come from the contract and the mapping
 * is the sort of thing that should be readable in one glance: an unknown invitation is not found, a
 * fingerprint that does not name the key offered is a bad request, and a used or expired invitation
 * is a conflict with the state of the world rather than a mistake in the request.
 */
const CLAIM_REFUSAL_STATUS: Record<
  "INVITE_UNKNOWN" | "INVITE_EXPIRED" | "INVITE_ALREADY_CLAIMED" | "FINGERPRINT_MISMATCH",
  number
> = {
  INVITE_UNKNOWN: 404,
  FINGERPRINT_MISMATCH: 400,
  INVITE_EXPIRED: 409,
  INVITE_ALREADY_CLAIMED: 409,
};

/**
 * The two routes another node calls, answered before the local token check.
 */
export function handlePeerUplinkRoutes(input: PeerUplinkDeps): GatewayResponse | undefined {
  const pairing = input.pairing;
  const runtime = input.runtime;
  const request = input.request;
  if (request.method === "POST" && request.path === "/peers/claim") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const offer = peerOfferFrom(parsed.value);
    if (offer === undefined) {
      return fail(
        400,
        "INVALID_SCHEMA",
        "a claim must carry the invite id and the claimant's node id, label, endpoint, public key, fingerprint and token hash",
      );
    }
    const outcome = claimInviteFrom(pairing, { inviteId: offer.inviteId, offer: offer.peer });
    if (!outcome.ok) {
      // A used invite and an expired one are conflicts; an unknown id is not found. Collapsing them
      // would hide a stolen invitation behind an ordinary 404.
      return fail(CLAIM_REFUSAL_STATUS[outcome.code], outcome.code, outcome.message);
    }
    return json(200, {
      // No endpoint here on purpose: the claimant already reached this node, so the address it used
      // is the one that works. Echoing one would invite a node to dial an address nothing verified.
      issuer: selfDescription(pairing, ""),
      // The hash of the token this node will present to the claimant, so nothing replayable crosses
      // the wire while pairing.
      tokenHash: outcome.issuerTokenHash,
    });
  }

  if (request.method === "POST" && request.path === "/peers/messages") {
    const peer = authenticatePeer(pairing, bearer(request.headers));
    if (peer === undefined) {
      // A pending peer, a revoked peer and a token that was never issued are one answer, so the
      // outside cannot tell a pairing waiting for a person from a token that never existed.
      return fail(401, "UNAUTHENTICATED", "a confirmed peer token is required to deliver an envelope");
    }
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const outcome = receiveEnvelope(peerGateway(pairing, peer.peerNodeId), parsed.value, {
      authenticatedSenderNodeId: peer.peerNodeId,
    });
    if (outcome.status === "gap") {
      // The sender's outbox keeps the message pending because nothing acknowledged it, so this is a
      // retry rather than a loss. Accepting it would move the cursor past the hole and make the
      // delayed message unprocessable for good.
      return fail(409, "SEQUENCE_GAP", `expected sequence ${String(outcome.expected)} but received ${String(outcome.received)}`);
    }
    if (outcome.status === "rejected") {
      return fail(400, outcome.code, outcome.message, { issues: outcome.issues });
    }
    const recorded = parseRecordedOutcome(outcome.responseJson);

    /*
     * An accepted offer is followed by the bytes, and the bytes are fetched in the background.
     *
     * Not before the acknowledgement: the sender's outbox is waiting on this response, and making it
     * wait for a file to cross the network would turn a slow artifact into a lost envelope. Not
     * silently either — the outcome goes to the node's own log, because an artifact that was accepted
     * and never arrived is exactly the thing that otherwise looks like it worked.
     */
    const intake = acceptedArtifactOffer(parsed.value, recorded);
    if (intake !== undefined) scheduleArtifactIntake({ runtime, pairing, peerNodeId: peer.peerNodeId, intake });

    return json(200, {
      status: outcome.status,
      // The recorded outcome, handed back verbatim on a replay. That is what makes a delegation whose
      // acknowledgement was lost a retry rather than a second instruction.
      response: recorded,
    });
  }

  /*
   * The bytes an accepted offer named.
   *
   * Serving them needs the same confirmed-peer token the envelope channel does. An artifact is the
   * user's, and a node that could fetch another node's files by knowing a digest would make the
   * acceptance check a formality rather than a boundary.
   */
  if (request.method === "GET" && request.path.startsWith("/peers/artifacts/")) {
    const peer = authenticatePeer(pairing, bearer(request.headers));
    if (peer === undefined) {
      return fail(401, "UNAUTHENTICATED", "a confirmed peer token is required to fetch an artifact");
    }
    const digest = decodeURIComponent(request.path.slice("/peers/artifacts/".length));
    const blobPath = blobPathForDigest({ dataDir: runtime.dataDir, digest });
    if (blobPath === undefined) {
      // A digest this node does not hold and one that was never a digest are the same answer: a peer
      // does not get to learn what this machine has by asking.
      return fail(404, "ARTIFACT_NOT_FOUND", "this node holds no artifact with that digest");
    }
    const blob = readBlob({ dataDir: runtime.dataDir, blobPath });
    if (!blob.ok) return fail(404, blob.code, blob.message);
    // Stored bytes are served as themselves, under the type the receiver will check by digest rather
    // than the one this node was told. The offer's MIME type travelled with the offer.
    return { status: 200, body: null, binary: { bytes: blob.bytes, contentType: "application/octet-stream" } };
  }
  return undefined;
}

/**
 * Pairing, from the side a person drives: issuing an introduction, confirming a peer, revoking one, and
 * writing the grant that a delegation is later checked against.
 */
export function handlePairingRoutes(input: PairingRouteDeps): GatewayResponse | undefined {
  const pairing = input.pairing;
  const runtime = input.runtime;
  const at = input.now;
  const request = input.request;
  const segments = input.segments;
  /*
   * Pairing, from the side a person drives.
   *
   * These need the local token because each one is a decision about this machine: issuing an
   * introduction, confirming that a peer is the machine whose fingerprint somebody compared, and
   * revoking one. None of them is reachable by a peer.
   */
  if (request.method === "POST" && request.path === "/grants") {
    // A grant is the owner's decision, so it is written here and travels to the peer as a
    // `pair.confirm` envelope: the receiver stores it, and from then on a delegate envelope naming it
    // is admissible while one naming anything else is refused.
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const candidate = grantSchema.safeParse(parsed.value);
    if (!candidate.success) {
      return fail(400, "INVALID_SCHEMA", "a grant must carry its id, both node ids, the data classes it allows and an expiry");
    }
    const grant = candidate.data;
    if (grant.senderNodeId !== runtime.identity.nodeId) {
      return fail(400, "GRANT_NOT_OURS", "a grant written here has to name this node as its sender");
    }
    if (grant.ownerPrincipalId !== runtime.identity.ownerPrincipalId) {
      return fail(403, "NOT_THE_OWNER", "a grant has to be written by this node's owner");
    }
    const receiver = findPeer(pairing, grant.receiverNodeId);
    if (receiver === undefined || receiver.revokedAt !== null || receiver.trustedAt === null) {
      return fail(404, "PEER_UNKNOWN", "a grant can only be written for a peer that is paired and confirmed");
    }
    upsertGrant(runtime.db, grant, at() as Instant);
    return json(201, { grantId: grant.grantId, receiverNodeId: grant.receiverNodeId, allowedDataClasses: grant.allowedDataClasses });
  }

  if (request.method === "POST" && request.path === "/peers/invites") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const endpoint = parsed.value["endpoint"];
    if (typeof endpoint !== "string" || endpoint.trim() === "") {
      return fail(400, "INVALID_SCHEMA", "an invitation must say which endpoint the peer should reach");
    }
    return json(201, { invite: createInvite(pairing, { endpoint: endpoint.trim() }) });
  }

  if (request.method === "GET" && request.path === "/peers") {
    return json(200, {
      peers: listPeers(pairing).map((peer) => ({
        nodeId: peer.peerNodeId,
        endpoint: peer.endpoint,
        // The fingerprint, not the label, is what a person compares.
        fingerprint: peer.fingerprint,
        pairedAt: peer.pairedAt,
        trustedAt: peer.trustedAt,
        revokedAt: peer.revokedAt,
      })),
    });
  }

  if (request.method === "POST" && request.path === "/peers/record") {
    // The claimant's half of pairing: a peer accepted our claim and told us who it is. Recorded
    // locally and still pending, because confirmation is a person's decision on each side and this
    // call is not that decision.
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const node = parsed.value["node"];
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return fail(400, "INVALID_SCHEMA", "recording a peer needs the identity the peer gave us");
    }
    const offer = readPeerOffer(node as Record<string, unknown>);
    if (offer === undefined) {
      return fail(400, "INVALID_SCHEMA", "a peer identity needs a node id, label, endpoint, public key, fingerprint and token hash");
    }
    const recorded = recordAcceptedClaim(pairing, {
      offer: {
        nodeId: offer.nodeId,
        label: offer.label,
        endpoint: offer.endpoint,
        publicKey: offer.publicKey,
        fingerprint: offer.fingerprint,
      },
      tokenHash: offer.tokenHash,
    });
    return json(201, { nodeId: recorded.peerNodeId, trustedAt: recorded.trustedAt });
  }

  if (segments.length === 3 && segments[0] === "peers" && segments[2] === "confirm" && request.method === "POST") {
    const peerNodeId = segments[1] ?? "";
    if (!confirmPeer(pairing, peerNodeId)) {
      return fail(404, "PEER_UNKNOWN", "no live peer with that id was paired by this node");
    }
    return json(200, { nodeId: peerNodeId, trusted: true });
  }

  if (segments.length === 3 && segments[0] === "peers" && segments[2] === "revoke" && request.method === "POST") {
    const peerNodeId = segments[1] ?? "";
    if (!revokePeer(pairing, peerNodeId)) {
      return fail(404, "PEER_UNKNOWN", "no live peer with that id was paired by this node");
    }
    return json(200, { nodeId: peerNodeId, revoked: true });
  }
  return undefined;
}
