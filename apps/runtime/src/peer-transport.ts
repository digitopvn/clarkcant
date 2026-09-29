import { randomUUID } from "node:crypto";

import {
  type Instant,
  type PeerEnvelope,
  type PeerSkipLost,
  PEER_SKIP_LOST_MAX,
  peerEnvelopeSchema,
  peerSkipLostSchema,
  peerSkipSchema,
  peerTextAsData,
} from "@clarkcant/contracts";
import { recordAcknowledgement, recordTransmissionAttempt, sendEnvelope } from "@clarkcant/node-link";
import {
  type Database,
  type PeerRecord,
  appendAuditEvent,
  deadLetterOutbox,
  markOutboxFailed,
  markOutboxTurnedDown,
  outboxLedger,
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
  /** Runs of given-up messages a peer skipped, this pass. Present only when there was one. */
  skipped?: SkipReport[];
  /**
   * Peers that do not take skips and just lost a message, or refused one for a gap a given-up message left, this pass:
   * every message after the lost one will be refused there until that node is updated. Present only when there was one.
   */
  stuck?: string[];
}

/** Messages this node gave up on that a peer skipped, as the peer said it did: both owners are told. */
export interface SkipReport {
  peerNodeId: string;
  /** The skip envelope that said so. */
  messageId: string;
  /** The first sequence the peer had not received; absent when it had never received anything from this node. */
  from?: number;
  through: number;
  /** What was given up on and never arrived there, in sequence order. */
  lost: PeerSkipLost[];
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

/** A peer's answer as fields, or `undefined` when it is not a JSON object this node can read. */
function answerFields(text: string | undefined): Record<string, unknown> | undefined {
  try {
    return text === undefined ? undefined : objectOf(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Record what a peer's answer says about the peer: the features it takes and the name it gives.
 *
 * Only from the answer of the peer this node authenticated and addressed, so nothing but a real answer from that peer
 * changes its row. An acknowledgement without features, as a build from before them gives, records that the peer takes
 * none; a refusal records features only when it carries them, so a refusal from an old build clears nothing. Failing
 * here never changes what happened to the message.
 */
function recordAdvertisement(deps: PeerTransportDeps, peerNodeId: string, fields: Record<string, unknown>): void {
  try {
    recordPeerAdvertisement(deps.db, peerNodeId, { features: fields["features"], label: fields["label"] });
  } catch (cause) {
    process.stderr.write(
      `nodelink: could not record what ${peerNodeId} says it takes (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
  }
}

/** What the peer's handler answered, inside an acknowledgement: the recorded outcome. */
function handlerAnswer(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return objectOf(objectOf(fields?.["response"])?.["outcome"]);
}

/**
 * Whether a peer that acknowledged a notice took it. Recorded on the outbox row when it did not, and reported so this
 * node's owner hears the notice did not arrive.
 */
function noticeTurnedDown(deps: PeerTransportDeps, envelope: PeerEnvelope, fields: Record<string, unknown> | undefined): TurnedDown | undefined {
  const peerNodeId = envelope.recipientNodeId;
  if (envelope.kind !== "notice") return undefined;
  const outcome = handlerAnswer(fields);
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

/** Whether a peer said it takes `skip`, which is what lets this node give up on one message without losing the rest. */
function takesSkip(peer: PeerRecord): boolean {
  return (peer.features ?? []).includes("skip");
}

/**
 * Whether a failed delivery says nothing about the message itself: nothing answered, the peer failed on its side, it no
 * longer takes this node's token, or it asked to be tried later. Everything else owed to that peer would have failed
 * the same way.
 */
function failedForEveryMessage(status: number | undefined): boolean {
  return status === undefined || status >= 500 || status === 401 || status === 408 || status === 429;
}

/**
 * A skip the peer acknowledged: what it skipped, audited here as given up on. `undefined` for anything else, and for a
 * skip the peer answered as stale, since then everything it covered had arrived after all.
 */
function skipAnswered(deps: PeerTransportDeps, envelope: PeerEnvelope, fields: Record<string, unknown> | undefined): SkipReport | undefined {
  if (envelope.kind !== "skip") return undefined;
  const skip = peerSkipSchema.safeParse(envelope.payload["skip"]);
  const answer = handlerAnswer(fields);
  if (!skip.success || answer?.["accepted"] !== true) return undefined;
  const from = typeof answer["from"] === "number" && Number.isSafeInteger(answer["from"]) ? answer["from"] : undefined;
  // Only what the peer had not received: an earlier one it did receive was delivered, whatever this node recorded.
  const lost = skip.data.lost.filter((one) => from === undefined || one.sequence >= from);
  if (lost.length === 0) return undefined;
  const report: SkipReport = {
    peerNodeId: envelope.recipientNodeId,
    messageId: envelope.messageId,
    ...(from === undefined ? {} : { from }),
    through: skip.data.through,
    lost,
  };
  try {
    appendAuditEvent(deps.db, {
      auditId: `audit_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      principalId: deps.identity.ownerPrincipalId,
      nodeId: deps.identity.nodeId,
      kind: "peer",
      summary: `gave up on ${String(lost.length)} message(s) to ${report.peerNodeId} (${[...new Set(lost.map((one) => one.kind))].join(", ")}); the peer skipped sequences ${String(from ?? lost[0]?.sequence ?? report.through)}-${String(report.through)}`,
      outcome: "failed",
      at: deps.now(),
      ref: envelope.messageId,
    });
  } catch (cause) {
    process.stderr.write(`nodelink: could not audit the skip ${envelope.messageId} (${cause instanceof Error ? cause.message : String(cause)})\n`);
  }
  return report;
}

/** A given-up message as a skip lists it: its task only when that is an id, since the receiver shows it to its owner. */
function lostEntry(envelope: PeerEnvelope): PeerSkipLost | undefined {
  const entry = peerSkipLostSchema.safeParse({
    sequence: envelope.sourceSequence,
    messageId: envelope.messageId,
    kind: envelope.kind,
    ...(envelope.taskId === undefined ? {} : { taskId: envelope.taskId }),
  });
  if (entry.success) return entry.data;
  const withoutTask = peerSkipLostSchema.safeParse({ sequence: envelope.sourceSequence, messageId: envelope.messageId, kind: envelope.kind });
  return withoutTask.success ? withoutTask.data : undefined;
}

/**
 * Queue a skip for what this node gave up on, when a peer that takes skips is waiting for it. Answers whether one was
 * queued.
 *
 * Read from the outbox alone, which never deletes a row. The skip covers the given-up messages above the highest
 * sequence the peer acknowledged and below the lowest one still owed, at most `PEER_SKIP_LOST_MAX` of them, and it
 * takes the sequence of the last one it covers: so it never covers a message the peer acknowledged, one still being
 * sent, or one not yet queued. Only one skip is owed to a peer at a time; a longer run is covered by the next.
 */
function queueSkip(deps: PeerTransportDeps, peerNodeId: string): boolean {
  let acknowledgedThrough = 0;
  let lowestOwed = Number.POSITIVE_INFINITY;
  const dead: PeerEnvelope[] = [];
  for (const row of outboxLedger(deps.db, peerNodeId)) {
    const parsed = peerEnvelopeSchema.safeParse(row.document);
    if (!parsed.success) continue;
    const envelope = parsed.data;
    if (row.acknowledgedAt !== null) acknowledgedThrough = Math.max(acknowledgedThrough, envelope.sourceSequence);
    else if (row.deadLetteredAt !== null) {
      if (envelope.kind !== "skip") dead.push(envelope);
    } else if (envelope.kind === "skip") return false;
    else lowestOwed = Math.min(lowestOwed, envelope.sourceSequence);
  }
  const lost: PeerSkipLost[] = [];
  for (const envelope of dead.sort((first, second) => first.sourceSequence - second.sourceSequence)) {
    if (envelope.sourceSequence <= acknowledgedThrough || envelope.sourceSequence >= lowestOwed) continue;
    if (lost.at(-1)?.sequence === envelope.sourceSequence) continue;
    const entry = lostEntry(envelope);
    if (entry !== undefined) lost.push(entry);
    if (lost.length === PEER_SKIP_LOST_MAX) break;
  }
  const through = lost.at(-1)?.sequence;
  if (through === undefined) return false;
  const at = deps.now();
  const messageId = `skip_${randomUUID().replaceAll("-", "")}`;
  sendEnvelope(deps, {
    protocol: "agent.nodelink",
    version: 1,
    messageId,
    correlationId: messageId,
    senderNodeId: deps.identity.nodeId,
    recipientNodeId: peerNodeId,
    kind: "skip",
    // The slot of the last message it gives up on: never a sequence this node has not issued.
    sourceSequence: through,
    sentAt: at,
    payload: { skip: { through, lost } },
  });
  return true;
}

/** Whether this node gave up on a message to a peer that the peer never acknowledged: what leaves a gap there. */
function givenUpOn(deps: PeerTransportDeps, peerNodeId: string): boolean {
  return outboxLedger(deps.db, peerNodeId).some((row) => {
    if (row.deadLetteredAt === null || row.acknowledgedAt !== null) return false;
    const parsed = peerEnvelopeSchema.safeParse(row.document);
    return parsed.success && parsed.data.kind !== "skip";
  });
}

/** How one attempt went, as the rest of the pass needs it. */
interface Attempt {
  acknowledged: boolean;
  /** The outbox gave the message up with this attempt. */
  gaveUp: boolean;
  /** The peer refused it because it is waiting for an earlier sequence. */
  gap: boolean;
  /** The failure says nothing about the message itself: every other message owed to the peer would have failed too. */
  forEveryMessage: boolean;
  /** A skip the peer accepted: what follows it may be covered by the next one. */
  skipAccepted: boolean;
  status?: number;
  reason: string;
}

/**
 * One pass over the outbox: attempt what is pending, record what the peer acknowledged.
 *
 * To a peer that takes skips, messages go in sequence order and one at a time: only the lowest sequence still owed is
 * sent, since the peer refuses anything past a gap. What waits behind it is not dialled and not counted against, unless
 * the failure is one every message would share (the peer not answering, or failing on its side), in which case each
 * waiting message that was due is counted as tried and failed, as it would have been had it been sent. When a message
 * is given up on, or the peer says it is waiting for one this node gave up on, a skip is queued in its place and sent at
 * once, so what follows is delivered instead of being refused for good. To a peer that does not take skips, messages go
 * as they always did, and one given up on is reported as leaving that pairing stuck. A message named with `only` is
 * attempted by itself, whatever is owed before it.
 */
export async function deliverPending(
  deps: PeerTransportDeps,
  options: { only?: string } = {},
): Promise<DeliveryOutcome> {
  const outcome: DeliveryOutcome = { attempted: 0, acknowledged: 0, refused: [] };
  const deadLettered: DeadLetter[] = [];
  const turnedDown: TurnedDown[] = [];
  const skipped: SkipReport[] = [];
  const stuck = new Set<string>();
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
  const limit = deps.batchSize ?? 20;
  let handled = 0;
  // Refused this pass only for a gap: once a skip closes it, each goes again at once rather than after its backoff.
  const gapRefused = new Set<string>();

  /** What is owed to each peer, oldest first, and which of it is due now. */
  const owedNow = (peerNodeId?: string): { owed: Map<string, PeerEnvelope[]>; due: Set<string> } => {
    const due = new Set<string>();
    for (const document of pendingOutbox(deps.db, peerNodeId, deps.now())) {
      const parsed = peerEnvelopeSchema.safeParse(document);
      if (parsed.success) due.add(parsed.data.messageId);
      else if (peerNodeId === undefined) {
        // A row this build cannot read is not sent: sending it would be guessing at what it says, and
        // the outbox is the one place where the stored bytes are the message.
        outcome.refused.push({ messageId: "unknown", reason: "an outbox row is not an envelope this build can send" });
      }
    }
    const owed = new Map<string, PeerEnvelope[]>();
    for (const document of pendingOutbox(deps.db, peerNodeId)) {
      const parsed = peerEnvelopeSchema.safeParse(document);
      if (!parsed.success) continue;
      const list = owed.get(parsed.data.recipientNodeId) ?? [];
      list.push(parsed.data);
      owed.set(parsed.data.recipientNodeId, list);
    }
    return { owed, due };
  };

  const attempt = async (peer: PeerRecord, envelope: PeerEnvelope): Promise<Attempt> => {
    outcome.attempted += 1;
    recordTransmissionAttempt(deps, envelope.messageId);
    const deadline = AbortSignal.timeout(deps.timeoutMs ?? PEER_DELIVERY_TIMEOUT_MS);
    let failure: { reason: string; status?: number; gap: boolean };
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
      if (response.ok) {
        recordAcknowledgement(deps, envelope.messageId);
        outcome.acknowledged += 1;
        // Acknowledged first: however the answer's body goes, the peer has the message and it is not sent again.
        const fields = answerFields(await readAnswer(response, deadline));
        if (fields !== undefined) recordAdvertisement(deps, envelope.recipientNodeId, fields);
        const turned = noticeTurnedDown(deps, envelope, fields);
        if (turned !== undefined) turnedDown.push(turned);
        const report = skipAnswered(deps, envelope, fields);
        if (report !== undefined) skipped.push(report);
        return { acknowledged: true, gaveUp: false, gap: false, forEveryMessage: false, skipAccepted: report !== undefined, reason: "" };
      }
      let gap = false;
      if (response.status === 409) {
        // Read, bounded, for one thing: a peer waiting for an earlier sequence says so, and says whether it takes skips.
        const fields = answerFields(await readAnswer(response, deadline));
        gap = fields?.["code"] === "SEQUENCE_GAP";
        if (gap && fields !== undefined && Array.isArray(fields["features"])) recordAdvertisement(deps, envelope.recipientNodeId, fields);
      } else {
        // Its body is not needed, and a connection left holding an unread one is not given back.
        void response.body?.cancel().catch(() => undefined);
      }
      failure = { reason: `${PEER_ANSWERED} ${response.status}`, status: response.status, gap };
    } catch (cause) {
      failure = { reason: cause instanceof Error ? cause.message : "delivery failed", gap: false };
    }
    outcome.refused.push({ messageId: envelope.messageId, reason: failure.reason });
    const reason = sanitizeDeliveryError(failure.reason);
    const marked = markOutboxFailed(deps.db, envelope.messageId, deps.now(), reason);
    // A 4xx is the peer refusing the message itself; anything else is a peer that could not answer.
    const refusedByPeer = failure.status !== undefined && failure.status >= 400 && failure.status < 500;
    if (marked.status === "dead-lettered") gaveUp(envelope, refusedByPeer);
    else if (failure.gap) gapRefused.add(envelope.messageId);
    return {
      acknowledged: false,
      gaveUp: marked.status === "dead-lettered",
      gap: failure.gap,
      forEveryMessage: failedForEveryMessage(failure.status),
      skipAccepted: false,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      reason,
    };
  };

  /** Deliver to a peer that takes skips, lowest sequence first. Answers whether a skip may now be owed to it. */
  const inOrder = async (peer: PeerRecord): Promise<boolean> => {
    const { owed, due } = owedNow(peer.peerNodeId);
    const queue = [...(owed.get(peer.peerNodeId) ?? [])].sort((first, second) => first.sourceSequence - second.sourceSequence);
    let skipMayBeOwed = false;
    for (const [index, envelope] of queue.entries()) {
      if (handled >= limit || !(due.has(envelope.messageId) || gapRefused.delete(envelope.messageId))) break;
      handled += 1;
      const result = await attempt(peer, envelope);
      skipMayBeOwed ||= (result.gaveUp && envelope.kind !== "skip") || result.gap || result.skipAccepted;
      if (result.acknowledged) continue;
      if (result.forEveryMessage) {
        for (const waiting of queue.slice(index + 1)) {
          if (!due.has(waiting.messageId)) continue;
          // Counted as tried: dialling the peer again for each one would only have said the same.
          recordTransmissionAttempt(deps, waiting.messageId);
          outcome.refused.push({ messageId: waiting.messageId, reason: result.reason });
          if (markOutboxFailed(deps.db, waiting.messageId, deps.now(), result.reason).status === "dead-lettered") {
            gaveUp(waiting, result.status !== undefined && result.status >= 400 && result.status < 500);
            skipMayBeOwed ||= waiting.kind !== "skip";
          }
        }
      }
      break;
    }
    return skipMayBeOwed;
  };

  const { owed, due } = owedNow();
  for (const [peerNodeId, messages] of owed) {
    if (handled >= limit) break;
    const dueHere = messages.filter(
      (envelope) => due.has(envelope.messageId) && (options.only === undefined || envelope.messageId === options.only),
    );
    let peer = deps.peerFor(peerNodeId);
    if (peer !== undefined && peer.revokedAt !== null) {
      for (const envelope of dueHere) {
        if (handled >= limit) break;
        handled += 1;
        // Never deliverable: the pairing is over, so the message is given up on now rather than held for ever.
        outcome.refused.push({ messageId: envelope.messageId, reason: "the pairing with the recipient was revoked" });
        deadLetterOutbox(deps.db, envelope.messageId, deps.now(), "the pairing with the recipient was revoked");
        gaveUp(envelope, true);
      }
      continue;
    }
    if (peer === undefined || peer.trustedAt === null) {
      for (const envelope of dueHere) {
        if (handled >= limit) break;
        handled += 1;
        // Refused rather than held: a message to a peer nobody confirmed is not waiting for a
        // confirmation, it is a message this node should not be sending.
        outcome.refused.push({ messageId: envelope.messageId, reason: "the recipient is not a confirmed peer" });
      }
      continue;
    }

    let skipMayBeOwed: boolean;
    // A message a caller names is sent as it is, in order or not: that one attempt is what the caller asked for.
    if (takesSkip(peer) && options.only === undefined) {
      skipMayBeOwed = await inOrder(peer);
    } else {
      let lostOne = false;
      let gap = false;
      for (const envelope of dueHere) {
        if (handled >= limit) break;
        handled += 1;
        const result = await attempt(peer, envelope);
        lostOne ||= result.gaveUp && envelope.kind !== "skip";
        gap ||= result.gap;
      }
      if (!lostOne && !gap) continue;
      // The refusal may have said the peer takes skips now: it was updated, and that is the way out of the gap.
      peer = deps.peerFor(peerNodeId);
      if (peer === undefined || !takesSkip(peer)) {
        // Stuck only once something was given up on: a gap behind a message still being retried may yet close.
        if (lostOne || givenUpOn(deps, peerNodeId)) stuck.add(peerNodeId);
        continue;
      }
      skipMayBeOwed = true;
    }
    // Bounded: each round either sends a skip or stops, and a long run of given-up messages is not one pass's work.
    for (let round = 0; skipMayBeOwed && round < 3 && handled < limit; round += 1) {
      if (!queueSkip(deps, peerNodeId)) break;
      skipMayBeOwed = await inOrder(peer);
    }
  }

  if (deadLettered.length > 0) outcome.deadLettered = deadLettered;
  if (turnedDown.length > 0) outcome.turnedDown = turnedDown;
  if (skipped.length > 0) outcome.skipped = skipped;
  if (stuck.size > 0) outcome.stuck = [...stuck];
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
