import { type Instant, type PeerEnvelope, peerEnvelopeSchema, peerTextAsData } from "@clarkcant/contracts";
import { recordAcknowledgement, recordTransmissionAttempt, sendEnvelope } from "@clarkcant/node-link";
import {
  type Database,
  type PeerRecord,
  deadLetterOutbox,
  markOutboxFailed,
  markOutboxTurnedDown,
  pendingOutbox,
  recordPeerAdvertisement,
} from "@clarkcant/storage";

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
  /** How long one delivery may take, answer included, before it counts as failed. */
  timeoutMs?: number;
}

/**
 * The longest a delivery may take, from dialling to the end of the answer. A peer that answers slowly or trickles its
 * answer would otherwise hold the pass, and every other peer's delivery behind it, for as long as it liked.
 */
export const PEER_DELIVERY_TIMEOUT_MS = 30_000;

/**
 * The most of a peer's answer this node reads. The answer is a status, the recorded outcome and what the peer says about
 * itself — a few hundred bytes — so anything past this is not an answer this node needs, and is not held in memory.
 */
export const PEER_ANSWER_MAX_BYTES = 16 * 1024;

/**
 * A message the peer acknowledged but did not act on: it answered, final, that it would not take it. Reported only for
 * notices, whose sender has nothing else that would tell it; the other kinds answer through their own replies.
 */
export interface TurnedDown {
  messageId: string;
  peerNodeId: string;
  envelope: PeerEnvelope;
  /** The peer's reason, as the peer said it: data, cleaned and bounded, never an instruction. */
  reason: string;
  /** The peer's code for it, when it gave one; checked against a known set by whoever reads it. */
  code?: string;
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
  deadLettered?: DeadLetter[];
  /** Notices the peer acknowledged and turned down, this pass. Present only when there was one. */
  turnedDown?: TurnedDown[];
}

/**
 * A message given up on, with what it was about: the task it concerned is waiting for it, and has to be told.
 *
 * `refusedByPeer` says the peer answered and turned it down (or the pairing was revoked), so it never acted on it; a
 * message that only never got an answer may have been acted on.
 */
export interface DeadLetter {
  messageId: string;
  peerNodeId: string;
  kind: PeerEnvelope["kind"];
  taskId?: string;
  refusedByPeer: boolean;
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

/** How a failure whose cause is the peer's own answer starts, followed by the HTTP status it answered with. */
const PEER_ANSWERED = "the peer answered";

/**
 * The HTTP status a peer answered a message with, read back from a stored failure reason: the peer was reached, which
 * is not the same as not being reachable. `undefined` for a failure where nothing answered.
 */
export function answeredStatus(lastError: string | null): number | undefined {
  const match = lastError === null ? null : new RegExp(`^${PEER_ANSWERED} ([1-5]\\d\\d)$`).exec(lastError);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * A peer's answer as text, read no further than `PEER_ANSWER_MAX_BYTES` and no longer than the delivery's deadline.
 * `undefined` when it is longer, stops coming, or cannot be read: the caller treats that as an answer that says nothing
 * more than its status.
 */
async function readAnswer(response: Response, deadline: AbortSignal): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "");
  const body = response.body;
  if (body === null) return "";
  if ((Number.isFinite(declared) && declared > PEER_ANSWER_MAX_BYTES) || deadline.aborted) {
    void body.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = body.getReader();
  // Cancelling ends a read that is waiting, so a peer that stops sending half-way cannot hold this past the deadline.
  const stop = (): void => void reader.cancel().catch(() => undefined);
  deadline.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PEER_ANSWER_MAX_BYTES) {
        stop();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    deadline.removeEventListener("abort", stop);
  }
  if (deadline.aborted) return undefined;
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** What a peer's reason may be when it is shown to this node's owner: its text as data, and short. */
const TURNED_DOWN_REASON_MAX = 300;

/**
 * What an acknowledging peer's answer says, recorded: the features it takes and the name it gives, for that peer, and —
 * for a notice — whether it took it.
 *
 * Only from the answer of the peer this node authenticated and addressed, after its acknowledgement was recorded, so
 * nothing but a real answer from that peer changes its row. A body this node cannot read changes nothing; an answer
 * without features, as a build from before them gives, records that the peer takes none. Failing here never turns the
 * delivered message into a failed one.
 */
function recordAnswer(deps: PeerTransportDeps, envelope: PeerEnvelope, text: string | undefined): TurnedDown | undefined {
  const peerNodeId = envelope.recipientNodeId;
  let fields: Record<string, unknown> | undefined;
  try {
    fields = text === undefined ? undefined : objectOf(JSON.parse(text));
  } catch {
    fields = undefined;
  }
  if (fields === undefined) return undefined;
  try {
    recordPeerAdvertisement(deps.db, peerNodeId, { features: fields["features"], label: fields["label"] });
  } catch (cause) {
    process.stderr.write(
      `nodelink: could not record what ${peerNodeId} says it takes (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
  }
  if (envelope.kind !== "notice") return undefined;
  const outcome = objectOf(objectOf(fields["response"])?.["outcome"]);
  if (outcome?.["accepted"] !== false) return undefined;
  const said = typeof outcome["reason"] === "string" ? peerTextAsData(outcome["reason"]).replace(/\s+/g, " ").trim() : "";
  const reason = [...(said === "" ? "the peer gave no reason" : said)].slice(0, TURNED_DOWN_REASON_MAX).join("");
  const code = typeof outcome["code"] === "string" && /^[A-Z_]{1,40}$/.test(outcome["code"]) ? outcome["code"] : undefined;
  try {
    markOutboxTurnedDown(deps.db, envelope.messageId, `the peer did not take it: ${reason}`);
  } catch (cause) {
    process.stderr.write(
      `nodelink: could not record that ${peerNodeId} turned ${envelope.messageId} down (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
  }
  return { messageId: envelope.messageId, peerNodeId, envelope, reason, ...(code === undefined ? {} : { code }) };
}

/** One pass over the outbox: attempt what is pending, record what the peer acknowledged. */
export async function deliverPending(
  deps: PeerTransportDeps,
  options: { only?: string } = {},
): Promise<DeliveryOutcome> {
  const outcome: DeliveryOutcome = { attempted: 0, acknowledged: 0, refused: [] };
  const deadLettered: DeadLetter[] = [];
  const turnedDown: TurnedDown[] = [];
  const gaveUp = (envelope: PeerEnvelope, refusedByPeer: boolean): void => {
    deadLettered.push({
      messageId: envelope.messageId,
      peerNodeId: envelope.recipientNodeId,
      kind: envelope.kind,
      ...(envelope.taskId === undefined ? {} : { taskId: envelope.taskId }),
      refusedByPeer,
    });
  };
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
    if (peer !== undefined && peer.revokedAt !== null) {
      // Never deliverable: the pairing is over, so the message is given up on now rather than held for ever.
      outcome.refused.push({ messageId: envelope.messageId, reason: "the pairing with the recipient was revoked" });
      deadLetterOutbox(deps.db, envelope.messageId, deps.now(), "the pairing with the recipient was revoked");
      gaveUp(envelope, true);
      continue;
    }
    if (peer === undefined || peer.trustedAt === null) {
      // Refused rather than held: a message to a peer nobody confirmed is not waiting for a
      // confirmation, it is a message this node should not be sending.
      outcome.refused.push({ messageId: envelope.messageId, reason: "the recipient is not a confirmed peer" });
      continue;
    }

    outcome.attempted += 1;
    recordTransmissionAttempt(deps, envelope.messageId);
    const deadline = AbortSignal.timeout(deps.timeoutMs ?? PEER_DELIVERY_TIMEOUT_MS);
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
        signal: deadline,
      });
      if (!response.ok) {
        // Its body is not needed, and a connection left holding an unread one is not given back.
        void response.body?.cancel().catch(() => undefined);
        const reason = `${PEER_ANSWERED} ${response.status}`;
        outcome.refused.push({ messageId: envelope.messageId, reason });
        const failure = markOutboxFailed(deps.db, envelope.messageId, deps.now(), sanitizeDeliveryError(reason));
        // A 4xx is the peer refusing the message itself; anything else is a peer that could not answer.
        if (failure.status === "dead-lettered") gaveUp(envelope, response.status >= 400 && response.status < 500);
        continue;
      }
      recordAcknowledgement(deps, envelope.messageId);
      outcome.acknowledged += 1;
      // Acknowledged first: however the answer's body goes, the peer has the message and it is not sent again.
      const turned = recordAnswer(deps, envelope, await readAnswer(response, deadline));
      if (turned !== undefined) turnedDown.push(turned);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "delivery failed";
      outcome.refused.push({ messageId: envelope.messageId, reason });
      const failure = markOutboxFailed(deps.db, envelope.messageId, deps.now(), sanitizeDeliveryError(reason));
      if (failure.status === "dead-lettered") gaveUp(envelope, false);
    }
  }

  if (deadLettered.length > 0) outcome.deadLettered = deadLettered;
  if (turnedDown.length > 0) outcome.turnedDown = turnedDown;
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
