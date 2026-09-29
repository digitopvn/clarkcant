import {
  type Instant,
  type PeerEnvelope,
  type SignalInput,
  signalInputSchema,
  signalTopicSchema,
} from "@clarkcant/contracts";
import { ingestSignal } from "@clarkcant/core";
import { sendEnvelope } from "@clarkcant/node-link";
import { type Database, getPeer, nextOutboundSequence } from "@clarkcant/storage";

import type { NodeIdentity } from "./node.ts";
import { type DeadLetter, type PeerTransportDeps, type TurnedDown, deliverPending } from "./peer-transport.ts";

/**
 * Signals between paired nodes: something that happened on one Clark, for the other's standing requests to answer.
 *
 * A peer's signal is a fact and nothing more. It carries no grant and cannot ask for anything; what it starts is only
 * what the receiving node's owner set up there, and it arrives under a name its sender does not choose: the source is
 * the peer the authenticated channel says it came from, never what the envelope claims, and the topic is always
 * `peer.<topic>`, so a paired node cannot make its news look like a GitHub delivery, a signed webhook or a timer on
 * the node that receives it.
 *
 * Sending records the envelope in the outbox before anything is attempted, so a node that stops in between sends it on
 * the next pass; the receiver records a resent signal once, by the sender's own key.
 */

export const PEER_SIGNAL_TOPIC_PREFIX = "peer";
export const PEER_SIGNAL_PROVIDER = "clarkcant";

/** The signal a received envelope becomes on this node, or why it is not one. */
export function signalFromPeer(
  envelope: PeerEnvelope,
): { ok: true; signal: SignalInput } | { ok: false; reason: string } {
  const sent = signalInputSchema.safeParse(envelope.payload["signal"]);
  if (!sent.success) return { ok: false, reason: "the signal is not one this node can read" };
  const topic = `${PEER_SIGNAL_TOPIC_PREFIX}.${sent.data.topic}`;
  if (!signalTopicSchema.safeParse(topic).success) return { ok: false, reason: "the signal's topic is too long to carry a peer's name" };
  return {
    ok: true,
    signal: {
      // Who sent it is the channel's answer, never the envelope's.
      source: { kind: "peer", provider: PEER_SIGNAL_PROVIDER, sourceId: envelope.senderNodeId },
      topic,
      ...(sent.data.subject === undefined ? {} : { subject: sent.data.subject }),
      payload: sent.data.payload,
      occurredAt: sent.data.occurredAt,
      dedupeKey: sent.data.dedupeKey,
      // Nothing the sender said about how it came to be is kept: whether it is this node's own doing is this node's call.
      provenance: { via: "paired node" },
    },
  };
}

export interface PeerSignalReceiveDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
}

/** Record a peer's signal once, and say what was recorded. Matching happens afterwards, like every other source. */
export function receivePeerSignal(
  deps: PeerSignalReceiveDeps,
  envelope: PeerEnvelope,
): { accepted: true; signalId: string; duplicate: boolean } | { accepted: false; reason: string } {
  const read = signalFromPeer(envelope);
  if (!read.ok) return { accepted: false, reason: read.reason };
  const recorded = ingestSignal(deps, read.signal);
  if (!recorded.ok) return { accepted: false, reason: recorded.message };
  return { accepted: true, signalId: recorded.signalId, duplicate: !recorded.created };
}

export interface PeerSignalSendDeps {
  db: Database;
  identity: NodeIdentity;
  now: () => Instant;
  newId: (prefix: string) => string;
}

/** What a person or a script on this node says happened, before it is addressed to a peer. */
export interface OutgoingPeerSignal {
  topic: string;
  dedupeKey: string;
  payload?: Record<string, unknown>;
  subject?: SignalInput["subject"];
  occurredAt?: string;
}

/**
 * Queue a signal for a confirmed peer. Recorded before any attempt, so it is sent even if this node stops first.
 *
 * Refused for a peer that is unknown, still pending or revoked: a message to a node nobody confirmed is not waiting for
 * a confirmation, it is a message this node should not be sending.
 */
export function queuePeerSignal(
  deps: PeerSignalSendDeps,
  peerNodeId: string,
  outgoing: OutgoingPeerSignal,
): { ok: true; messageId: string } | { ok: false; code: "PEER_UNKNOWN" | "SIGNAL_INVALID"; message: string } {
  const peer = getPeer(deps.db, peerNodeId);
  if (peer === undefined || peer.trustedAt === null || peer.revokedAt !== null) {
    return { ok: false, code: "PEER_UNKNOWN", message: "signals go only to a peer that is paired and confirmed" };
  }
  const at = deps.now();
  const signal = signalInputSchema.safeParse({
    source: { kind: "local", sourceId: deps.identity.nodeId },
    topic: outgoing.topic,
    ...(outgoing.subject === undefined ? {} : { subject: outgoing.subject }),
    payload: outgoing.payload ?? {},
    occurredAt:
      outgoing.occurredAt === undefined
        ? at
        : Number.isNaN(Date.parse(outgoing.occurredAt))
          ? outgoing.occurredAt
          : new Date(outgoing.occurredAt).toISOString(),
    dedupeKey: outgoing.dedupeKey,
  });
  if (!signal.success) {
    return {
      ok: false,
      code: "SIGNAL_INVALID",
      message: signal.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    };
  }
  // The receiver prefixes it; one that would not fit there is refused here, where the sender can still change it.
  if (!signalTopicSchema.safeParse(`${PEER_SIGNAL_TOPIC_PREFIX}.${signal.data.topic}`).success) {
    return { ok: false, code: "SIGNAL_INVALID", message: "topic: too long to carry the peer prefix" };
  }
  const messageId = deps.newId("msg");
  sendEnvelope(deps, {
    protocol: "agent.nodelink",
    version: 1,
    messageId,
    correlationId: messageId,
    senderNodeId: deps.identity.nodeId,
    recipientNodeId: peerNodeId,
    kind: "signal",
    sourceSequence: nextOutboundSequence(deps.db, peerNodeId),
    sentAt: at,
    payload: { signal: signal.data },
  });
  return { ok: true, messageId };
}

export interface PeerDelivery {
  /** Try what is pending now, rather than at the next interval. */
  kick(): void;
  stop(): void;
}

const DEFAULT_DELIVERY_INTERVAL_MS = 30_000;

/**
 * The pass that carries the outbox to peers: every so often, and at once when something is queued.
 *
 * One pass at a time, so a slow peer is not dialled twice for the same message. A message a peer keeps refusing backs
 * off and is eventually dead-lettered by the outbox itself; that is said on the node's log, because a message that was
 * given up on is exactly what otherwise looks like it went.
 */
export function startPeerDelivery(
  deps: Omit<PeerTransportDeps, "peerFor">,
  options: {
    intervalMs?: number;
    log?: (line: string) => void;
    /** Told about each message given up on, so what waited on it is settled rather than left waiting. */
    onDeadLettered?: (letter: DeadLetter) => void;
    /** Told about each notice a peer acknowledged and did not take, so this node's owner hears it did not arrive. */
    onTurnedDown?: (turned: TurnedDown) => void;
    /** Run after every pass, with the outbox as that pass left it: how a peer that stays unreachable is noticed. */
    afterPass?: () => void;
    /**
     * Told when the machine seems to have slept: the timer fired more than two intervals after it last did, which a
     * process that kept running does not do. Told before the pass that tick starts.
     */
    onWake?: (at: Instant) => void;
  } = {},
): PeerDelivery {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const intervalMs = options.intervalMs ?? DEFAULT_DELIVERY_INTERVAL_MS;
  let lastTick = Date.parse(deps.now());
  let stopped = false;
  let running = false;
  let again = false;

  const pass = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const outcome = await deliverPending({ ...deps, peerFor: (peerNodeId) => getPeer(deps.db, peerNodeId) });
        for (const dead of outcome.deadLettered ?? []) {
          log(
            dead.refusedByPeer
              ? `nodelink: gave up delivering ${dead.messageId} to ${dead.peerNodeId}; the peer refused it`
              : `nodelink: gave up delivering ${dead.messageId} to ${dead.peerNodeId} after repeated failures`,
          );
          try {
            options.onDeadLettered?.(dead);
          } catch (cause) {
            log(`nodelink: could not settle what ${dead.messageId} was about (${cause instanceof Error ? cause.message : String(cause)})`);
          }
        }
        for (const turned of outcome.turnedDown ?? []) {
          try {
            options.onTurnedDown?.(turned);
          } catch (cause) {
            log(`nodelink: could not tell that ${turned.peerNodeId} did not take ${turned.messageId} (${cause instanceof Error ? cause.message : String(cause)})`);
          }
        }
      } while (again && !stopped);
    } catch (cause) {
      log(`nodelink: delivery pass failed (${cause instanceof Error ? cause.message : String(cause)})`);
    }
    try {
      if (!stopped) options.afterPass?.();
    } catch (cause) {
      log(`nodelink: the check after a delivery pass failed (${cause instanceof Error ? cause.message : String(cause)})`);
    } finally {
      running = false;
    }
  };

  const tick = (): void => {
    const at = deps.now();
    const now = Date.parse(at);
    const slept = now - lastTick > 2 * intervalMs;
    lastTick = now;
    if (slept) {
      try {
        options.onWake?.(at);
      } catch (cause) {
        log(`nodelink: could not note a wake from sleep (${cause instanceof Error ? cause.message : String(cause)})`);
      }
    }
    void pass();
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    kick() {
      if (!stopped) setImmediate(() => void pass());
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
