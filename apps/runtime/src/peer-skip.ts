import { randomUUID } from "node:crypto";

import { type AppIntentLocale, type Instant, type PeerEnvelope, type PeerSkipLost, NOTICE_BODY_MAX, peerSkipSchema } from "@clarkcant/contracts";
import { type Database, appendAuditEvent, countRecentInbox, getPeer, peerCursor, peerDeliveryState } from "@clarkcant/storage";

import { preferredAppIntentLocale } from "./app-intents.ts";
import { ownerLocale } from "./host-text.ts";
import { type NoticeText, noticeText } from "./notice-text.ts";
import { type NodeNotice, type NoticeServices, tryRecordNodeNotice } from "./notices.ts";
import { PEER_NOTICES_PER_MINUTE } from "./peer-notices.ts";
import type { SkipReport } from "./peer-transport.ts";

/**
 * Messages between paired nodes that were given up on, and what both owners are told about them.
 *
 * NodeLink sequences every envelope a node sends a peer, and the peer refuses anything past a gap, so one message given
 * up on used to leave every later one refused for good. A node that gives up on a message now sends a `skip` in its
 * place, to a peer that said it takes them: the peer moves past the given-up sequences, and each owner is told once,
 * in the inbox, what was lost, what was kept and what happens next. A lost result settles the task that waited for it,
 * as uncertain, since nobody here can vouch for how it ended. Both sides audit the skip.
 *
 * A peer that does not take skips keeps the old behaviour, and its owner here is told the pairing is stuck until
 * ClarkCant on that device is updated.
 */

const LOST_KEY_PREFIX = "peer-lost";
const STUCK_KEY_PREFIX = "peer-stuck";

/** How many lost messages a notice names one by one; the rest are counted. */
const NAMED_MAX = 5;

type SkipWords = NoticeText["peerSkip"];

const inWords = (one: PeerSkipLost, say: SkipWords): string =>
  `${say.kindWords[one.kind]}${one.taskId === undefined ? "" : say.forTask(one.taskId)}`;

/**
 * The lost messages, named one by one as far as `room` allows and at most `NAMED_MAX`, the rest counted. The guidance
 * comes before this list in a notice, so it is the list that gives way when the body would run past its bound.
 */
function lostInWords(lost: readonly PeerSkipLost[], room: number, say: SkipWords): string {
  for (let named = Math.min(lost.length, NAMED_MAX); named >= 0; named -= 1) {
    const rest = lost.length - named;
    const parts = lost.slice(0, named).map((one) => inWords(one, say));
    if (rest > 0) parts.push(named === 0 ? say.howMany(rest) : say.andMore(rest));
    const text = parts.join("; ");
    if (text.length <= room) return text;
  }
  return say.howMany(lost.length);
}

/**
 * What losing these messages does, and what does not happen, by kind. Only a lost hand-over or stop settles a task,
 * and only on the side that sent it; a lost result settles the task on the side that handed it out; a lost question,
 * answer or approval is not sent again, so whoever waits for it waits until the request expires.
 */
function consequences(side: "out" | "in", lost: readonly PeerSkipLost[], settled: number, say: SkipWords): string {
  const kinds = new Set(lost.map((one) => one.kind));
  const said: string[] = [];
  if (side === "out" && (kinds.has("delegate") || kinds.has("cancel.request"))) said.push(say.settledOut);
  if (side === "out" && kinds.has("result")) said.push(say.resultUncertainThere);
  if (side === "in" && settled > 0) said.push(say.settledIn);
  if (["input.request", "input.response", "approval.request", "approval.response"].some((kind) => kinds.has(kind as PeerSkipLost["kind"]))) {
    said.push(say.notResent);
  }
  if (said.length === 0) said.push(say.nothingToSettle);
  return said.join(" ");
}

/**
 * The notice for a run of messages given up on: on the node that gave them up (`out`) or on the one they were for
 * (`in`). What failed, what was kept, what it does to the tasks involved and what the person can do come first; the
 * list of what was lost comes last and is shortened to fit, so the guidance always survives the body's bound. One per
 * skip: the key names its peer, its side and the last sequence it covered.
 */
export function peerLostNotice(input: {
  side: "out" | "in";
  peerNodeId: string;
  /** What the peer calls itself, already cleaned; its node id is shown when it never said. */
  label?: string;
  through: number;
  lost: readonly PeerSkipLost[];
  /** Tasks this node handed the peer whose lost result settled them as uncertain. */
  settled?: readonly string[];
  at: Instant;
  /** The owner's interface language; Vietnamese when none is named. */
  language?: AppIntentLocale;
}): NodeNotice {
  const say = noticeText(input.language).peerSkip;
  const name = input.label ?? input.peerNodeId;
  const count = input.lost.length;
  const guidance =
    input.side === "out"
      ? say.guidanceOut(name, count, consequences("out", input.lost, 0, say))
      : say.guidanceIn(name, count, consequences("in", input.lost, (input.settled ?? []).length, say));
  const body = `${guidance}${lostInWords(input.lost, NOTICE_BODY_MAX - guidance.length - 1, say)}.`;
  return {
    sourceKind: "system",
    category: "alert",
    severity: "warning",
    title: input.side === "out" ? say.titleOut(count) : say.titleIn(count),
    body,
    subject: { kind: "peer", nodeId: input.peerNodeId },
    dedupKey: `${LOST_KEY_PREFIX}:${input.peerNodeId}:${input.side}:${String(input.through)}`,
    at: input.at,
  };
}
/** Tell this node's owner that a peer skipped messages this node gave up on. Never throws into the delivery pass. */
export function tellSkipped(services: NoticeServices, report: SkipReport, at: Instant): void {
  const label = getPeer(services.runtime.db, report.peerNodeId)?.label;
  tryRecordNodeNotice(
    services,
    peerLostNotice({
      side: "out",
      peerNodeId: report.peerNodeId,
      ...(label === undefined ? {} : { label }),
      through: report.through,
      lost: report.lost,
      at,
      language: ownerLocale(services.runtime),
    }),
  );
}

/** The key prefix of every stuck notice about one peer. */
export function peerStuckPrefix(peerNodeId: string): string {
  return `${STUCK_KEY_PREFIX}:${peerNodeId}:`;
}

/** The stuck notice's key for one stretch without an acknowledgement: the next acknowledgement ends it. */
export function peerStuckKey(peerNodeId: string, lastAcknowledgedAt: Instant | null): string {
  return `${peerStuckPrefix(peerNodeId)}${lastAcknowledgedAt ?? "never"}`;
}

/**
 * The notice that a pairing is stuck: this node gave up on a message to a peer that has not said it takes a skip, so
 * that peer refuses everything after it. What happened, what is kept, and that updating ClarkCant there is what frees it.
 */
export function peerStuckNotice(input: {
  peerNodeId: string;
  label?: string;
  lastAcknowledgedAt: Instant | null;
  at: Instant;
  /** The owner's interface language; Vietnamese when none is named. */
  language?: AppIntentLocale;
}): NodeNotice {
  const say = noticeText(input.language).peerSkip;
  const name = input.label ?? input.peerNodeId;
  return {
    sourceKind: "system",
    category: "alert",
    severity: "error",
    title: say.stuckTitle,
    body: say.stuckBody(name),
    subject: { kind: "peer", nodeId: input.peerNodeId },
    dedupKey: peerStuckKey(input.peerNodeId, input.lastAcknowledgedAt),
    at: input.at,
  };
}

/** Tell this node's owner, once per stretch without an acknowledgement, that a pairing is stuck. Never throws. */
export function tellStuck(services: NoticeServices, peerNodeId: string, at: Instant): void {
  try {
    const { lastAcknowledgedAt } = peerDeliveryState(services.runtime.db, peerNodeId);
    const label = getPeer(services.runtime.db, peerNodeId)?.label;
    tryRecordNodeNotice(
      services,
      peerStuckNotice({ peerNodeId, ...(label === undefined ? {} : { label }), lastAcknowledgedAt, at, language: ownerLocale(services.runtime) }),
    );
  } catch (cause) {
    process.stderr.write(`inbox: could not tell that the pairing with ${peerNodeId} is stuck (${cause instanceof Error ? cause.message : String(cause)})\n`);
  }
}

export interface PeerSkipReceiveDeps {
  db: Database;
  nodeId: string;
  ownerPrincipalId: string;
  now: () => Instant;
  /** Record a notice in this node's owner's inbox; the same key twice is one notice. */
  record: (notice: NodeNotice) => unknown;
  /**
   * Settle a task this node handed the sender, whose result the sender gave up on. Answers whether a task was settled:
   * only one that is this node's own, handed to that very peer, and still open.
   */
  settleLostResult: (lost: { peerNodeId: string; taskId: string }) => boolean;
}

/**
 * A skip from a confirmed peer, already validated: its payload reads, it covers no sequence past its own, and it is
 * ahead of this node's cursor. Recorded like any envelope, so a replay is answered from the inbox rather than again.
 *
 * What it lists and this node had already received is left out: only what never arrived is reported. A lost result
 * settles the task it was for, as uncertain, and only a task this node handed that peer. The owner is told once per
 * skip; a peer past `PEER_NOTICES_PER_MINUTE` skips a minute is still skipped and audited, but not told again.
 */
export function receivePeerSkip(
  deps: PeerSkipReceiveDeps,
  envelope: PeerEnvelope,
): { accepted: true; from?: number; through: number; settled: string[] } | { accepted: false; code: "SKIP_UNREADABLE"; reason: string } {
  const read = peerSkipSchema.safeParse(envelope.payload["skip"]);
  if (!read.success) return { accepted: false, code: "SKIP_UNREADABLE", reason: "the skip is not one this node can read" };
  const peer = envelope.senderNodeId;
  const at = deps.now();
  // Read before this envelope is recorded, so it is where the peer's stream stood when the skip arrived.
  const cursor = peerCursor(deps.db, peer);
  const from = cursor === undefined ? undefined : cursor + 1;
  const lost = read.data.lost.filter((one) => from === undefined || one.sequence >= from);
  const settled = lost.flatMap((one) =>
    one.kind === "result" && one.taskId !== undefined && deps.settleLostResult({ peerNodeId: peer, taskId: one.taskId }) ? [one.taskId] : [],
  );

  try {
    appendAuditEvent(deps.db, {
      auditId: `audit_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      principalId: deps.ownerPrincipalId,
      nodeId: deps.nodeId,
      kind: "peer",
      summary: `${peer} gave up on ${String(lost.length)} message(s) to this node (${[...new Set(lost.map((one) => one.kind))].join(", ") || "none listed"}) and skipped sequences ${String(from ?? lost[0]?.sequence ?? read.data.through)}-${String(read.data.through)}${settled.length > 0 ? `; settled as uncertain: ${settled.join(", ")}` : ""}`,
      outcome: "failed",
      at,
      ref: envelope.messageId,
    });
  } catch (cause) {
    process.stderr.write(`nodelink: could not audit the skip ${envelope.messageId} from ${peer} (${cause instanceof Error ? cause.message : String(cause)})\n`);
  }

  // The envelope being answered is recorded after this runs, so the count is of the ones before it.
  const minuteAgo = new Date(Date.parse(at) - 60_000).toISOString() as Instant;
  const withinRate = countRecentInbox(deps.db, { peerNodeId: peer, kind: "skip", since: minuteAgo }) < PEER_NOTICES_PER_MINUTE;
  if (lost.length > 0 && withinRate) {
    const label = getPeer(deps.db, peer)?.label;
    try {
      deps.record(
        peerLostNotice({
          side: "in",
          peerNodeId: peer,
          ...(label === undefined ? {} : { label }),
          through: read.data.through,
          lost,
          settled,
          at,
          // The notice is this node's owner's, so it is worded in their language, read now.
          language: preferredAppIntentLocale({ db: deps.db, now: deps.now }, deps.ownerPrincipalId),
        }),
      );
    } catch (cause) {
      process.stderr.write(`inbox: could not record that messages from ${peer} were lost (${cause instanceof Error ? cause.message : String(cause)})\n`);
    }
  }
  return { accepted: true, ...(from === undefined ? {} : { from }), through: read.data.through, settled };
}
