import { createHash } from "node:crypto";

import { type Instant, type PeerEnvelope, type PeerNotice, peerNoticeSchema } from "@clarkcant/contracts";
import { sendEnvelope } from "@clarkcant/node-link";
import { type Database, activeGrants, getPeer, getTask, nextOutboundSequence } from "@clarkcant/storage";

import type { NodeNotice } from "./notices.ts";

/**
 * Notices between paired nodes: something one Clark's owner should also hear about in the inbox of another.
 *
 * A notice from a peer is words and nothing more. The sender says what happened, how much it matters and a key for it;
 * the receiver decides everything else. It is recorded under the node the authenticated channel names, as the peer's
 * (`sourceKind` `peer`, `originNodeId`, subject `peer`), and what can be done with it is worked out by this host like
 * for any notice, so a peer cannot put a button, a command or a pointer to something of this node's in front of its
 * owner. Its text is bounded by the contract and treated as data.
 *
 * A notice needs more than a pairing: the two nodes must hold a live grant between them, in either direction, which is
 * what says their owners work together. Anything else is refused with the reason, and a notice sent again under the
 * same key is recorded once.
 */

export const PEER_NOTICE_KEY_PREFIX = "peer";

/** Whether this node and a peer hold a live grant between them, whichever of them wrote it. */
export function holdsLiveGrant(db: Database, nodeId: string, peerNodeId: string, at: Instant): boolean {
  return (
    activeGrants(db, peerNodeId, at).some((grant) => grant.receiverNodeId === nodeId) ||
    activeGrants(db, nodeId, at).some((grant) => grant.receiverNodeId === peerNodeId)
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
  | { ok: false; code: "PEER_UNKNOWN" | "NO_LIVE_GRANT" | "NOTICE_INVALID"; message: string };

/**
 * Queue a notice for a confirmed peer this node holds a live grant with. Recorded before any attempt, so it is sent
 * even if this node stops first; `taskId` names the task it is about when the peer handed that task over.
 *
 * Refused here rather than sent to be refused there: a peer that is not confirmed, or one no live grant ties to this
 * node, would not take it.
 */
export function queuePeerNotice(
  deps: PeerNoticeSendDeps,
  peerNodeId: string,
  notice: unknown,
  about?: { taskId: string },
): QueuePeerNoticeResult {
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
  const at = deps.now();
  if (!holdsLiveGrant(deps.db, deps.identity.nodeId, peerNodeId, at)) {
    return { ok: false, code: "NO_LIVE_GRANT", message: "a notice goes only to a peer this node holds a live grant with, in either direction" };
  }
  const messageId = deps.newId("msg");
  sendEnvelope(deps, {
    protocol: "agent.nodelink",
    version: 1,
    messageId,
    correlationId: about?.taskId ?? messageId,
    senderNodeId: deps.identity.nodeId,
    recipientNodeId: peerNodeId,
    kind: "notice",
    ...(about === undefined ? {} : { taskId: about.taskId }),
    sourceSequence: nextOutboundSequence(deps.db, peerNodeId),
    sentAt: at,
    payload: { notice: read.data },
  });
  return { ok: true, messageId };
}

/**
 * The key a notice travels under: this node's own dedup key when it fits the contract, its digest when it does not, so
 * the same notice always travels under the same key.
 */
function travellingKey(dedupKey: string): string {
  return dedupKey.length <= 160 ? dedupKey : `sha256:${createHash("sha256").update(dedupKey).digest("hex")}`;
}

/**
 * Pass a notice about a task a peer handed this node on to that peer, for its owner's inbox.
 *
 * Only a notice whose subject is such a task: a failure, an outcome nobody can vouch for, anything else this node says
 * about work the peer asked for. Nothing unrelated to the peer leaves this node. The text is the notice as it was
 * stored here, already redacted and bounded. Answers whether it was queued.
 */
export function forwardDelegatedNotice(
  deps: PeerNoticeSendDeps,
  stored: { dedupKey: string; category: PeerNotice["category"]; severity: PeerNotice["severity"]; title: string; body?: string; taskId: string },
): boolean {
  const task = getTask(deps.db, stored.taskId);
  if (task?.origin?.kind !== "delegated") return false;
  const queued = queuePeerNotice(
    deps,
    task.origin.peerNodeId,
    {
      key: travellingKey(stored.dedupKey),
      category: stored.category,
      severity: stored.severity,
      title: stored.title,
      ...(stored.body === undefined ? {} : { body: stored.body }),
    },
    { taskId: task.taskId },
  );
  if (!queued.ok) {
    process.stderr.write(`inbox: a notice about ${task.taskId} was not sent to ${task.origin.peerNodeId} (${queued.message})\n`);
  }
  return queued.ok;
}

export interface PeerNoticeReceiveDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  /** Record the notice in this node's owner's inbox; the same key twice is one notice. */
  record: (notice: NodeNotice) => { notificationId: string; created: boolean };
}

/** A peer's words as text for a notice: no control characters, nothing else changed. */
function asData(text: string): string {
  return text.replace(/\p{Cc}+/gu, " ");
}

/**
 * A notice a confirmed peer sent. Recorded once under the peer's name while a live grant ties the two nodes, and
 * refused with the reason otherwise.
 *
 * Linked to the conversation of a task only when that task is this node's own and was handed to that very peer, so a
 * notice cannot point at a conversation of this node it has nothing to do with.
 */
export function receivePeerNotice(
  deps: PeerNoticeReceiveDeps,
  envelope: PeerEnvelope,
): { accepted: true; noticeId: string; duplicate: boolean } | { accepted: false; reason: string } {
  const read = peerNoticeSchema.safeParse(envelope.payload["notice"]);
  if (!read.success) return { accepted: false, reason: "the notice is not one this node can read" };
  const peer = envelope.senderNodeId;
  const at = deps.now();
  if (!holdsLiveGrant(deps.db, deps.nodeId, peer, at)) {
    return { accepted: false, reason: "this node holds no live grant with that peer, so it takes no notices from it" };
  }
  const notice = read.data;
  const task = envelope.taskId === undefined ? undefined : getTask(deps.db, envelope.taskId);
  const conversationId =
    task !== undefined && task.homeNodeId === deps.nodeId && task.executionNodeId === peer ? task.conversationId : undefined;
  const recorded = deps.record({
    sourceKind: "peer",
    category: notice.category,
    severity: notice.severity,
    title: asData(notice.title),
    ...(notice.body === undefined ? {} : { body: asData(notice.body) }),
    ...(conversationId === undefined ? {} : { conversationId }),
    originNodeId: peer,
    subject: { kind: "peer", nodeId: peer },
    dedupKey: `${PEER_NOTICE_KEY_PREFIX}:${peer}:${notice.key}`,
    at,
  });
  return { accepted: true, noticeId: recorded.notificationId, duplicate: !recorded.created };
}
