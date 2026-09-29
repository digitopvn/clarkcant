import type { Instant } from "@clarkcant/contracts";
import { dismissNotificationsByKeyPrefix, listPeers, peerDeliveryState } from "@clarkcant/storage";

import { type NodeNotice, type NoticeServices, tryRecordNodeNotice } from "./notices.ts";

/**
 * Telling the owner when a paired node cannot be reached, once per outage, and taking it back when it can.
 *
 * Read from the outbox's own retry state, never a second record: a peer is failing while something owed to it keeps
 * failing after its last acknowledgement. A blip is not an outage, so nothing is said until delivery has been failing
 * for `PEER_OFFLINE_NOTICE_AFTER_MS`; the outbox goes on retrying either way. The notice is keyed by the last
 * acknowledgement before the outage, which is what names one outage: however often this runs while the peer is away it
 * is one notice, and the next outage, after the peer answered again, is a new one. It is dismissed as soon as the peer
 * acknowledges anything, and when the pairing is revoked, since nothing is being sent to it any more.
 */

/**
 * How long delivery to a peer has to have been failing before the owner is told: ten minutes. Long enough that a
 * laptop lid closed for a moment or a restart says nothing, short enough to be heard while it still matters. The outbox
 * keeps retrying well past it (its backoff reaches fifteen minutes between tries, and it gives a message up after twelve).
 */
export const PEER_OFFLINE_NOTICE_AFTER_MS = 10 * 60_000;

const OFFLINE_KEY_PREFIX = "peer-offline";

function offlinePrefix(peerNodeId: string): string {
  return `${OFFLINE_KEY_PREFIX}:${peerNodeId}:`;
}

/** A moment as a person on this machine reads it: hour and minute, then the day. */
function readableTime(at: Instant): string {
  const date = new Date(at);
  const time = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const day = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  return `${time} ngày ${day}`;
}

/** The notice for one outage: what failed and since when, what is kept, and what happens next. */
export function peerOfflineNotice(input: { peerNodeId: string; since: Instant; lastAcknowledgedAt: Instant | null; at: Instant }): NodeNotice {
  return {
    sourceKind: "system",
    category: "alert",
    severity: "warning",
    title: "Không gửi được tới thiết bị khác",
    body:
      `Không gửi được tới thiết bị ${input.peerNodeId} từ lúc ${readableTime(input.since)}. ` +
      "Những gì cần gửi vẫn nằm trong hàng đợi trên máy này và được thử lại tự động; thông báo này tự đóng khi gửi được. " +
      "Nếu thiết bị đó đã tắt hẳn hoặc đổi địa chỉ, hãy bật nó lên hoặc ghép cặp lại.",
    subject: { kind: "peer", nodeId: input.peerNodeId },
    dedupKey: `${offlinePrefix(input.peerNodeId)}${input.lastAcknowledgedAt ?? "never"}`,
    at: input.at,
  };
}

/** One look at every paired node: record the outage that has lasted long enough, dismiss the one that ended. */
export function reconcilePeerOutages(services: NoticeServices, at: Instant): void {
  const { db, identity } = services.runtime;
  for (const peer of listPeers(db)) {
    const prefix = offlinePrefix(peer.peerNodeId);
    if (peer.trustedAt === null || peer.revokedAt !== null) {
      dismissNotificationsByKeyPrefix(db, { principalId: identity.ownerPrincipalId, dedupKeyPrefix: prefix, at });
      continue;
    }
    const state = peerDeliveryState(db, peer.peerNodeId);
    const current = `${prefix}${state.lastAcknowledgedAt ?? "never"}`;
    // An outage recorded before the peer's latest acknowledgement is over, whether or not a new one has begun.
    dismissNotificationsByKeyPrefix(db, { principalId: identity.ownerPrincipalId, dedupKeyPrefix: prefix, at, except: current });
    if (state.failingSince === null || Date.parse(at) - Date.parse(state.failingSince) < PEER_OFFLINE_NOTICE_AFTER_MS) continue;
    tryRecordNodeNotice(
      services,
      peerOfflineNotice({ peerNodeId: peer.peerNodeId, since: state.failingSince, lastAcknowledgedAt: state.lastAcknowledgedAt, at }),
    );
  }
}
