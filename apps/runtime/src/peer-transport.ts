import { type Instant, type PeerEnvelope, peerEnvelopeSchema } from "@clarkcant/contracts";
import { recordAcknowledgement, recordTransmissionAttempt, sendEnvelope } from "@clarkcant/node-link";
import { type Database, type PeerRecord, markOutboxFailed, pendingOutbox } from "@clarkcant/storage";

import type { NodeIdentity } from "./node.ts";
import { outboundPeerToken } from "./peers.ts";

/**
 * The transport that carries envelopes between two live hosts.
 *
 * This is the layer `@clarkcant/node-link` deliberately left out: `receiveEnvelope` and `sendEnvelope`
 * are transport-agnostic, and this is the transport. It is HTTP against the peer's own gateway, which
 * is the thing two nodes already speak to each other with, so it adds no protocol of its own — the
 * envelope is the body, the peer token is the credential, and the answer is the outcome the peer
 * recorded.
 *
 * Delivery is at-least-once on purpose. A message stays in the outbox until the peer acknowledges it,
 * so a lost answer means the next pass sends it again — which is exactly why the receiver
 * deduplicates on the message id instead of trusting the transport to deliver once.
 *
 * The destination policy is deliberately not the provider one. `validateProviderEndpoint` refuses
 * loopback and private addresses, which is right for a provider somebody types in and wrong for a
 * peer: two nodes on one desk or one LAN are the ordinary case, and the pairing is what makes an
 * endpoint callable. What is kept from that policy is the part about the request rather than the
 * destination — only http or https, no credentials embedded in the URL, and no following a redirect,
 * because a redirect is how a paired address turns into an address nobody paired with.
 */

export interface PeerTransportDeps {
  db: Database;
  identity: NodeIdentity;
  now: () => Instant;
  /** The peer a message is addressed to. An unknown or unconfirmed peer is refused, not dialled. */
  peerFor: (peerNodeId: string) => PeerRecord | undefined;
  /** Injected so a test can drive delivery without a network. */
  fetchImpl?: typeof fetch;
  /** How many pending messages one pass attempts. */
  batchSize?: number;
}

export interface DeliveryOutcome {
  attempted: number;
  acknowledged: number;
  /** Messages that were not delivered, each with the reason, so a silent retry loop is impossible. */
  refused: { messageId: string; reason: string }[];
  /**
   * Messages a failed delivery just gave up retrying automatically, this pass.
   *
   * Optional and populated only when at least one happened: a caller that never dead-letters anything
   * (every existing caller, until a peer actually goes dark for long enough) sees exactly the shape it
   * saw before this field existed.
   */
  deadLettered?: { messageId: string; peerNodeId: string }[];
}

/**
 * A peer's origin, checked.
 *
 * The endpoint is an origin; the path belongs to the protocol. Resolving a path against the origin
 * rather than appending to whatever the endpoint happened to end with means a peer that recorded
 * `http://host:1234/` and one that recorded `http://host:1234` reach the same place. The protocol and
 * credential checks live here so every path this node asks a peer for is subject to them: a second
 * copy of them is how one of the two ends up missing one.
 */
export function peerOrigin(endpoint: string): URL {
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    throw new Error(`a peer endpoint must be a URL, and "${endpoint}" is not`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`a peer endpoint must be http or https, and "${endpoint}" is not`);
  }
  if (base.username !== "" || base.password !== "") {
    throw new Error("a peer endpoint must not embed credentials in its URL");
  }
  return base;
}

/** Where a peer's envelopes are delivered. */
export function peerMessagesUrl(endpoint: string): string {
  return new URL("/peers/messages", peerOrigin(endpoint)).toString();
}

/**
 * Where a peer's stored bytes are fetched from.
 *
 * The digest is a path segment, so it is encoded rather than interpolated. Every digest this node
 * writes is hex, but this value arrives in a peer's offer, and a value from a peer does not get to
 * shape a URL by itself.
 */
export function peerArtifactUrl(endpoint: string, digest: string): string {
  return new URL(`/peers/artifacts/${encodeURIComponent(digest)}`, peerOrigin(endpoint)).toString();
}

/**
 * Strip anything a failure reason might carry that should never sit in a durable `last_error` column:
 * a bearer token from an authorization header, or credentials embedded in a URL. `fetch`'s own thrown
 * messages can echo the request it was given, and this is the one place every one of those messages
 * passes through before it is stored.
 */
function sanitizeDeliveryError(reason: string): string {
  return reason
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/:\/\/[^\s/]+:[^\s/@]+@/g, "://[redacted]@");
}

/** One pass over the outbox: attempt what is pending, record what the peer acknowledged. */
export async function deliverPending(
  deps: PeerTransportDeps,
  options: { only?: string } = {},
): Promise<DeliveryOutcome> {
  const outcome: DeliveryOutcome = { attempted: 0, acknowledged: 0, refused: [] };
  const deadLettered: { messageId: string; peerNodeId: string }[] = [];
  const send = deps.fetchImpl ?? fetch;

  const queued: PeerEnvelope[] = [];
  for (const document of pendingOutbox(deps.db, undefined, deps.now())) {
    const parsed = peerEnvelopeSchema.safeParse(document);
    if (!parsed.success) {
      // A row this build cannot read is not sent: sending it would be guessing at what it says, and
      // the outbox is the one place where the stored bytes are the message.
      outcome.refused.push({ messageId: "unknown", reason: "an outbox row is not an envelope this build can send" });
      continue;
    }
    if (options.only !== undefined && parsed.data.messageId !== options.only) continue;
    queued.push(parsed.data);
  }

  for (const envelope of queued.slice(0, deps.batchSize ?? 20)) {
    const peer = deps.peerFor(envelope.recipientNodeId);
    if (peer === undefined || peer.revokedAt !== null || peer.trustedAt === null) {
      // Refused rather than held: a message to a peer nobody confirmed is not waiting for a
      // confirmation, it is a message this node should not be sending.
      outcome.refused.push({ messageId: envelope.messageId, reason: "the recipient is not a confirmed peer" });
      continue;
    }

    outcome.attempted += 1;
    recordTransmissionAttempt(deps, envelope.messageId);
    try {
      const response = await send(peerMessagesUrl(peer.endpoint), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Derived for this peer and stored nowhere: the peer holds only the hash of it.
          authorization: `Bearer ${outboundPeerToken(deps.identity.localToken, peer.peerNodeId)}`,
        },
        body: JSON.stringify(envelope),
        // Not "follow": a redirect is how a paired address turns into an address nobody paired with.
        redirect: "error",
      });
      if (!response.ok) {
        const reason = `the peer answered ${response.status}`;
        outcome.refused.push({ messageId: envelope.messageId, reason });
        const failure = markOutboxFailed(deps.db, envelope.messageId, deps.now(), sanitizeDeliveryError(reason));
        if (failure.status === "dead-lettered") {
          deadLettered.push({ messageId: envelope.messageId, peerNodeId: envelope.recipientNodeId });
        }
        continue;
      }
      recordAcknowledgement(deps, envelope.messageId);
      outcome.acknowledged += 1;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "delivery failed";
      outcome.refused.push({ messageId: envelope.messageId, reason });
      const failure = markOutboxFailed(deps.db, envelope.messageId, deps.now(), sanitizeDeliveryError(reason));
      if (failure.status === "dead-lettered") {
        deadLettered.push({ messageId: envelope.messageId, peerNodeId: envelope.recipientNodeId });
      }
    }
  }

  if (deadLettered.length > 0) outcome.deadLettered = deadLettered;
  return outcome;
}

/**
 * Queue an envelope and try to deliver it.
 *
 * Intent is recorded before the attempt, so a crash between the two loses the delivery and not the
 * message: the next pass finds it still pending. That is what makes a delegation whose answer was
 * lost a retry rather than a lost instruction.
 */
export async function sendToPeer(deps: PeerTransportDeps, envelope: PeerEnvelope): Promise<DeliveryOutcome> {
  sendEnvelope(deps, envelope);
  return deliverPending(deps, { only: envelope.messageId });
}
