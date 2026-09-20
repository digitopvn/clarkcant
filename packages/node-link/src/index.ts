import {
  type PeerEnvelope,
  type VersionHandshake,
  decideInboxAction,
  dedupKey,
  negotiateVersions,
  peerEnvelopeSchema,
  validatePeerEnvelope,
} from "@clarkcant/contracts";
import { type Database, enqueueOutbox, markOutboxAcknowledged, markOutboxAttempt, peerCursor, recordInbox, toJson } from "@clarkcant/storage";

/**
 * NodeLink peer gateway.
 *
 * Transport-agnostic on purpose: the same receive path serves an HTTPS request, a
 * WebSocket frame, or an in-process test double. That matters because the delivery
 * guarantees — at-least-once with durable dedup — are properties of this layer and
 * must not depend on which transport happened to carry the bytes.
 *
 * `senderNodeId` inside an envelope is never identity. Every inbound envelope is
 * validated against the node id that the authenticated channel reported, and a
 * mismatch is rejected rather than reconciled (acceptance test T08).
 */

export interface PeerGatewayDeps {
  db: Database;
  nodeId: string;
  now: () => string;
  newId: (prefix: string) => string;
  supportedVersions: { min: number; max: number };
  knownDelegationIds: ReadonlySet<string>;
  /** Handler invoked only after the envelope is durably recorded. */
  handler: (envelope: PeerEnvelope) => unknown;
}

/**
 * What outbound bookkeeping needs, and no more.
 *
 * The sender has no inbound handler and no version window to offer, so taking the whole gateway deps
 * would force it to invent both. Every `PeerGatewayDeps` satisfies this, which is why narrowing the
 * three outbound calls to it changed no caller.
 */
export interface OutboundPeerDeps {
  db: Database;
  now: () => string;
}

export type ReceiveOutcome =
  | { status: "processed"; responseJson: string }
  | { status: "duplicate"; responseJson: string }
  | { status: "gap"; expected: number; received: number }
  | { status: "rejected"; code: string; message: string; issues: string[] };

export function receiveEnvelope(
  deps: PeerGatewayDeps,
  raw: unknown,
  transport: { authenticatedSenderNodeId: string },
): ReceiveOutcome {
  // Deduplication runs before semantic validation on purpose. Under at-least-once
  // delivery a replay is expected, and a replay of a message we already recorded will
  // legitimately fail the monotonic-sequence check. Rejecting it as a validation error
  // would turn a lost acknowledgement into a permanently unrecoverable exchange, so a
  // known message id is answered from the inbox first.
  const structural = peerEnvelopeSchema.safeParse(raw);
  if (structural.success) {
    const known = peekInbox(deps.db, dedupKey(structural.data));
    if (known.found) {
      return { status: "duplicate", responseJson: known.responseJson };
    }
  }

  const validation = validatePeerEnvelope(raw, {
    authenticatedSenderNodeId: transport.authenticatedSenderNodeId,
    supportedVersions: deps.supportedVersions,
    lastSeenSequence: peerCursor(deps.db, transport.authenticatedSenderNodeId),
    knownDelegationIds: deps.knownDelegationIds,
  });

  if (!validation.valid) {
    return {
      status: "rejected",
      code: validation.issues[0]?.code ?? "MISSING_FIELD",
      message: validation.issues[0]?.message ?? "envelope failed validation",
      issues: validation.issues.map((issue) => `${issue.code}: ${issue.message}`),
    };
  }

  const envelope = validation.envelope;
  const key = dedupKey(envelope);

  // The known-key check above answered the duplicate case, so an empty map here is honest rather
  // than lazy: what is left to decide is whether this sequence follows the last one we processed.
  const decision = decideInboxAction(envelope, {
    keys: new Map(),
    lastSequence: peerCursor(deps.db, transport.authenticatedSenderNodeId),
  });
  if (decision.action === "gap-detected") {
    // Reported rather than processed, and the cursor stays where it is. The sender's outbox keeps the
    // message pending because nothing acknowledged it, so the missing sequence arrives on the retry
    // and both are processed in order. Accepting it here would move the cursor past the hole and make
    // the delayed message unprocessable for good.
    return { status: "gap", expected: decision.expected, received: decision.received };
  }

  const responseJson = toJson(deps.handler(envelope));
  const recorded = recordInbox(deps.db, {
    dedupKey: key,
    peerNodeId: envelope.senderNodeId,
    sourceSequence: envelope.sourceSequence,
    messageId: envelope.messageId,
    kind: envelope.kind,
    document: envelope,
    responseJson,
    receivedAt: deps.now() as never,
  });

  return recorded.status === "duplicate"
    ? { status: "duplicate", responseJson: recorded.previousResponseJson ?? "null" }
    : { status: "processed", responseJson };
}

/**
 * Read a stored response without parsing it.
 *
 * The JSON text is handed back verbatim so this function has no `unknown` return,
 * and a corrupt row surfaces as "not found" rather than as a parse throw from the
 * middle of an inbound message path.
 */
function peekInbox(db: Database, key: string): { found: false } | { found: true; responseJson: string } {
  const row = db.prepare("SELECT response FROM inbox WHERE dedup_key = ?").get(key) as
    | { response: string | null }
    | undefined;
  if (!row || row.response === null) return { found: false };
  return { found: true, responseJson: row.response };
}

/** Record outbound intent before transmission, so a crash cannot lose the message. */
export function sendEnvelope(
  deps: OutboundPeerDeps,
  envelope: PeerEnvelope,
): { messageId: string } {
  enqueueOutbox(deps.db, {
    messageId: envelope.messageId,
    peerNodeId: envelope.recipientNodeId,
    correlationId: envelope.correlationId,
    document: envelope,
    createdAt: deps.now() as never,
  });
  return { messageId: envelope.messageId };
}

export function recordTransmissionAttempt(deps: OutboundPeerDeps, messageId: string): void {
  markOutboxAttempt(deps.db, messageId, deps.now() as never);
}

export function recordAcknowledgement(deps: OutboundPeerDeps, messageId: string): void {
  markOutboxAcknowledged(deps.db, messageId, deps.now() as never);
}

/**
 * Negotiate a usable version window.
 *
 * An incompatible node keeps read/status access and simply cannot start new
 * effects; it is never downgraded silently (`docs/distributed-runtime.md` §11).
 */
export function negotiate(local: VersionHandshake, remote: VersionHandshake) {
  return negotiateVersions(local, remote);
}

/**
 * @implementation-status stub
 * TODO(P4): the TLS/WebSocket transport itself. `receiveEnvelope` and `sendEnvelope`
 * are transport-agnostic and fully exercised by tests, but the socket, reconnect
 * cursor and keepalive layer that carries them between two real hosts is not
 * implemented. Proving J4 needs two genuinely independent Linux runtimes.
 */
export interface NodeLinkTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
}
