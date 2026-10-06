import { createHash } from "node:crypto";

import { type AppIntentLocale, type Instant, type PeerEnvelope, peerNoticeSchema, peerTextAsData } from "@clarkcant/contracts";
import { sendEnvelope } from "@clarkcant/node-link";
import {
  type Database,
  activeGrants,
  countRecentInbox,
  getPeer,
  getTask,
  livePeerAllowance,
  nextOutboundSequence,
} from "@clarkcant/storage";

import { ownerLocale } from "./host-text.ts";
import { noticeText } from "./notice-text.ts";
import { type NodeNotice, type NoticeServices, tryRecordNodeNotice } from "./notices.ts";
import type { TurnedDown } from "./peer-transport.ts";

/**
 * Notices between paired nodes: something one Clark's owner should also hear about in the inbox of another.
 *
 * A notice from a peer is words and nothing more. The sender says what happened, how much it matters and a key for it;
 * the receiver decides everything else. It is recorded under the node the authenticated channel names, as the peer's
 * (`sourceKind` `peer`, `originNodeId`, subject `peer`), and what can be done with it is worked out by this host like
 * for any notice, so a peer cannot put a button, a command or a pointer to something of this node's in front of its
 * owner. Its text is bounded by the contract and treated as data.
 *
 * Only a decision this node's owner made admits a peer's notices: a live grant this node wrote to that peer, or a live
 * allowance for it. A grant the peer wrote to this node is the peer's decision, not this owner's, so it admits nothing.
 * Each peer is held to `PEER_NOTICES_PER_MINUTE`, and its notices to their own share of the inbox, so one peer cannot
 * flood it. Anything refused is answered with a code and the reason, and the refusal is final: the sender does not send
 * it again, and tells its own owner, once per peer and reason, that the notice did not arrive. A notice sent again under
 * the same key is recorded once.
 *
 * The sending side queues a notice only for a confirmed peer that said it takes them (its `notice` feature); whether
 * that peer's owner admits it is theirs to decide, which this node cannot see.
 */

export const PEER_NOTICE_KEY_PREFIX = "peer";

/** How many notices one peer may deliver here in a minute. Past it they are refused, not queued. */
export const PEER_NOTICES_PER_MINUTE = 30;

/** Whether this node's owner chose to work with a peer: a live grant this node wrote to it, or a live allowance for it. */
export function admitsPeerNotices(db: Database, nodeId: string, peerNodeId: string, at: Instant): boolean {
  return (
    activeGrants(db, nodeId, at).some((grant) => grant.receiverNodeId === peerNodeId) ||
    livePeerAllowance(db, peerNodeId, at) !== undefined
  );
}

export interface PeerNoticeSendDeps {
  db: Database;
  identity: { nodeId: string };
  now: () => Instant;
  newId: (prefix: string) => string;
}

export type QueuePeerNoticeResult =
  | { ok: true; messageId: string }
  | { ok: false; code: "PEER_UNKNOWN" | "NOTICES_UNSUPPORTED" | "NOTICE_INVALID"; message: string };

/**
 * Queue a notice for a confirmed peer that takes them. Recorded before any attempt, so it is sent even if this node
 * stops first.
 *
 * Refused here rather than sent to be refused there: a peer that is not confirmed, or one that has not said it takes
 * notices — a build from before them, which would refuse the envelope unread.
 */
export function queuePeerNotice(deps: PeerNoticeSendDeps, peerNodeId: string, notice: unknown): QueuePeerNoticeResult {
  const peer = getPeer(deps.db, peerNodeId);
  if (peer === undefined || peer.trustedAt === null || peer.revokedAt !== null) {
    return { ok: false, code: "PEER_UNKNOWN", message: "notices go only to a peer that is paired and confirmed" };
  }
  const read = peerNoticeSchema.safeParse(notice);
  if (!read.success) {
    return {
      ok: false,
      code: "NOTICE_INVALID",
      message: read.error.issues.map((issue) => `${issue.path.join(".") || "notice"}: ${issue.message}`).join("; "),
    };
  }
  if (!(peer.features ?? []).includes("notice")) {
    return {
      ok: false,
      code: "NOTICES_UNSUPPORTED",
      message:
        "that peer has not said it takes notices, so nothing was queued. This node learns it from the peer's answer to anything it delivers there: " +
        `if ClarkCant on that device is up to date, send it something first (a signal, POST /peers/${peerNodeId}/signals) and try again; ` +
        "if it runs a ClarkCant from before notices, update it there",
    };
  }
  const at = deps.now();
  const messageId = deps.newId("msg");
  sendEnvelope(deps, {
    protocol: "agent.nodelink",
    version: 1,
    messageId,
    correlationId: messageId,
    senderNodeId: deps.identity.nodeId,
    recipientNodeId: peerNodeId,
    kind: "notice",
    sourceSequence: nextOutboundSequence(deps.db, peerNodeId),
    sentAt: at,
    payload: { notice: read.data },
  });
  return { ok: true, messageId };
}

/**
 * Why a node did not take a peer's notice, as a code its sender can act on and words for a person. Answered as an
 * acknowledgement, so it is final: sending the same notice again would be refused the same way.
 */
export const PEER_NOTICE_REFUSAL_CODES = ["PEER_NOT_ALLOWED", "RATE_LIMITED", "NOTICE_UNREADABLE", "NOTICES_OFF"] as const;
export type PeerNoticeRefusalCode = (typeof PEER_NOTICE_REFUSAL_CODES)[number];
export interface PeerNoticeRefusal {
  accepted: false;
  code: PeerNoticeRefusalCode;
  reason: string;
}

export interface PeerNoticeReceiveDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  /** Record the notice in this node's owner's inbox; the same key twice is one notice. */
  record: (notice: NodeNotice) => { notificationId: string; created: boolean };
}

/**
 * A notice a confirmed peer sent. Recorded once under the peer's name when this node's owner chose to work with that
 * peer and the peer is within its rate, and refused with the reason otherwise.
 *
 * Linked to the conversation of a task only when that task is this node's own and was handed to that very peer, so a
 * notice cannot point at a conversation of this node it has nothing to do with.
 */
export function receivePeerNotice(
  deps: PeerNoticeReceiveDeps,
  envelope: PeerEnvelope,
): { accepted: true; noticeId: string; duplicate: boolean } | PeerNoticeRefusal {
  const read = peerNoticeSchema.safeParse(envelope.payload["notice"]);
  if (!read.success) return { accepted: false, code: "NOTICE_UNREADABLE", reason: "the notice is not one this node can read" };
  const peer = envelope.senderNodeId;
  const at = deps.now();
  if (!admitsPeerNotices(deps.db, deps.nodeId, peer, at)) {
    return {
      accepted: false,
      code: "PEER_NOT_ALLOWED",
      reason: "this node's owner has not chosen to work with that peer (no grant to it, no allowance for it), so it takes no notices from it",
    };
  }
  // The envelope being answered is recorded after this runs, so the count is of the ones before it.
  const minuteAgo = new Date(Date.parse(at) - 60_000).toISOString() as Instant;
  if (countRecentInbox(deps.db, { peerNodeId: peer, kind: "notice", since: minuteAgo }) >= PEER_NOTICES_PER_MINUTE) {
    return {
      accepted: false,
      code: "RATE_LIMITED",
      reason: `this node takes at most ${String(PEER_NOTICES_PER_MINUTE)} notices a minute from one peer; this one came past that and was not recorded`,
    };
  }
  const notice = read.data;
  const task = envelope.taskId === undefined ? undefined : getTask(deps.db, envelope.taskId);
  const conversationId =
    task !== undefined && task.homeNodeId === deps.nodeId && task.executionNodeId === peer ? task.conversationId : undefined;
  const recorded = deps.record({
    sourceKind: "peer",
    category: notice.category,
    severity: notice.severity,
    title: peerTextAsData(notice.title),
    ...(notice.body === undefined ? {} : { body: peerTextAsData(notice.body) }),
    ...(conversationId === undefined ? {} : { conversationId }),
    originNodeId: peer,
    subject: { kind: "peer", nodeId: peer },
    dedupKey: `${PEER_NOTICE_KEY_PREFIX}:${peer}:${notice.key}`,
    at,
  });
  return { accepted: true, noticeId: recorded.notificationId, duplicate: !recorded.created };
}

const TURNED_DOWN_KEY_PREFIX = "peer-notice-refused";

function isRefusalCode(code: string | undefined): code is PeerNoticeRefusalCode {
  return (PEER_NOTICE_REFUSAL_CODES as readonly (string | undefined)[]).includes(code);
}

/**
 * The notice this node's owner gets when a peer acknowledged one of this node's notices and did not take it: what did
 * not arrive and why, that nothing was recorded there and it is not sent again, and what would change that.
 *
 * One per peer and reason: a known reason is keyed by its code, anything else by a digest of the peer's words, so a
 * burst of refusals for the same reason is one notice. The peer's words are shown only when its code is not one this
 * node knows, and then as quoted data. Worded in this node's owner's `language`, Vietnamese when none is named: the
 * notice is for them, not for the peer.
 */
export function peerNoticeTurnedDownNotice(input: {
  peerNodeId: string;
  /** What the peer calls itself, already cleaned; its node id is shown when it never said. */
  label?: string;
  envelope: PeerEnvelope;
  reason: string;
  code?: string;
  at: Instant;
  language?: AppIntentLocale;
}): NodeNotice {
  const say = noticeText(input.language).peerTurnedDown;
  const name = input.label ?? input.peerNodeId;
  const sent = peerNoticeSchema.safeParse(input.envelope.payload["notice"]);
  const what = say.what(sent.success ? sent.data.title : undefined);
  const known = isRefusalCode(input.code) ? say.reasons[input.code] : undefined;
  const why = known?.why(PEER_NOTICES_PER_MINUTE) ?? say.otherWhy(input.reason);
  const next = known?.next ?? say.otherNext;
  const reasonKey = isRefusalCode(input.code) ? input.code : `other-${createHash("sha256").update(input.reason).digest("hex").slice(0, 16)}`;
  return {
    sourceKind: "system",
    category: "alert",
    severity: "warning",
    title: say.title,
    body: say.body(name, what, why, next),
    subject: { kind: "peer", nodeId: input.peerNodeId },
    dedupKey: `${TURNED_DOWN_KEY_PREFIX}:${input.peerNodeId}:${reasonKey}`,
    at: input.at,
  };
}

/** Tell this node's owner that a peer did not take one of this node's notices. Never throws into the delivery pass. */
export function tellNoticeTurnedDown(services: NoticeServices, turned: TurnedDown, at: Instant): void {
  const label = getPeer(services.runtime.db, turned.peerNodeId)?.label;
  tryRecordNodeNotice(
    services,
    peerNoticeTurnedDownNotice({
      peerNodeId: turned.peerNodeId,
      ...(label === undefined ? {} : { label }),
      envelope: turned.envelope,
      reason: turned.reason,
      ...(turned.code === undefined ? {} : { code: turned.code }),
      at,
      language: ownerLocale(services.runtime),
    }),
  );
}
