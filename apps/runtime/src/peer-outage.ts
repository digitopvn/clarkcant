import type { Instant } from "@clarkcant/contracts";
import { type PeerRecord, dismissNotificationsByKeyPrefix, listPeers, peerDeliveryState } from "@clarkcant/storage";

import { type NodeNotice, type NoticeServices, tryRecordNodeNotice } from "./notices.ts";
import { refusalStatus } from "./peer-transport.ts";

/**
 * Telling the owner when delivery to a paired node is not working, once per outage, and taking it back when it is.
 *
 * Read from the outbox's own retry state, never a second record. Three situations are told apart, because what the
 * person can do differs:
 *
 *   - unreachable: nothing answers. The messages wait in the queue and are retried for a while.
 *   - refused: the node answers, but turns the messages down (a 4xx). Turning it on changes nothing; the pairing or the
 *     versions on the two machines are what to look at.
 *   - given up: everything owed since the node last answered was given up on. Nothing will be retried, and the notice
 *     says so rather than promising a retry.
 *
 * A blip is not an outage, so nothing is said until delivery has been failing for `PEER_OFFLINE_NOTICE_AFTER_MS` of
 * time this node was actually watching: an outage is counted from no earlier than this process started or the machine
 * last woke from sleep, so a laptop opened after a night does not report the night as an outage the moment it wakes.
 *
 * The notice is keyed by the last acknowledgement before the outage and by the situation, which is what names one
 * outage: however often this runs while the peer is away it is one notice, and the next outage, after the peer answered
 * again, is a new one. It is dismissed as soon as the peer acknowledges anything, when the situation changes, and when
 * the pairing is revoked, since nothing is being sent to it any more.
 */

/**
 * How long delivery to a peer has to have been failing before the owner is told: ten minutes. Long enough that a
 * laptop lid closed for a moment or a restart says nothing, short enough to be heard while it still matters. The outbox
 * keeps retrying past it (its backoff reaches fifteen minutes between tries, and it gives a message up after twelve).
 */
export const PEER_OFFLINE_NOTICE_AFTER_MS = 10 * 60_000;

const OFFLINE_KEY_PREFIX = "peer-offline";

type Situation = "unreachable" | "refused" | "given-up";

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

const TITLES: Record<Situation, string> = {
  unreachable: "Không gửi được tới thiết bị khác",
  refused: "Thiết bị khác từ chối nhận",
  "given-up": "Đã ngừng gửi tới thiết bị khác",
};

function body(situation: Situation, name: string, since: Instant, status: number | undefined): string {
  const time = readableTime(since);
  switch (situation) {
    case "unreachable":
      return (
        `Không gửi được tới thiết bị ${name} từ lúc ${time}: thiết bị đó không trả lời. ` +
        "Những gì cần gửi vẫn nằm trong hàng đợi trên máy này và còn được thử lại tự động một thời gian; thông báo này tự đóng khi gửi được. " +
        "Nếu thiết bị đó đã tắt hẳn hoặc đổi địa chỉ, hãy bật nó lên hoặc ghép cặp lại."
      );
    case "refused":
      return (
        `Thiết bị ${name} vẫn trả lời nhưng từ chối những gì máy này gửi từ lúc ${time}${status === undefined ? "" : ` (mã ${String(status)})`}. ` +
        "Máy này còn thử lại một thời gian rồi sẽ dừng; thông báo này tự đóng nếu thiết bị đó nhận. " +
        "Hãy kiểm tra việc ghép cặp trên thiết bị đó, hoặc cập nhật ClarkCant trên cả hai máy."
      );
    case "given-up":
      return (
        `Máy này đã ngừng gửi tới thiết bị ${name}: những gì cần gửi từ lúc ${time} không gửi được sau nhiều lần thử và đã bị bỏ, sẽ không được gửi lại. ` +
        "Thông báo này tự đóng khi thiết bị đó nhận được tin mới từ máy này."
      );
  }
}

/** The notice for one outage: what failed and since when, what is kept, and what happens next. */
export function peerOfflineNotice(input: {
  peerNodeId: string;
  /** What the peer calls itself, already cleaned; its node id is shown when it never said. */
  label?: string;
  situation: Situation;
  since: Instant;
  /** The status a refusing peer answered with. */
  status?: number;
  lastAcknowledgedAt: Instant | null;
  at: Instant;
}): NodeNotice {
  return {
    sourceKind: "system",
    category: "alert",
    severity: input.situation === "given-up" ? "error" : "warning",
    title: TITLES[input.situation],
    body: body(input.situation, input.label ?? input.peerNodeId, input.since, input.status),
    subject: { kind: "peer", nodeId: input.peerNodeId },
    dedupKey: `${offlinePrefix(input.peerNodeId)}${input.lastAcknowledgedAt ?? "never"}:${input.situation}`,
    at: input.at,
  };
}

const later = (first: Instant, second: Instant): Instant => (second > first ? second : first);

/** One look at one paired node: record the outage that has lasted long enough, dismiss the one that ended. */
function reconcilePeer(services: NoticeServices, peer: PeerRecord, at: Instant, observingSince: Instant): void {
  const { db, identity } = services.runtime;
  const prefix = offlinePrefix(peer.peerNodeId);
  if (peer.trustedAt === null || peer.revokedAt !== null) {
    dismissNotificationsByKeyPrefix(db, { principalId: identity.ownerPrincipalId, dedupKeyPrefix: prefix, at });
    return;
  }
  const state = peerDeliveryState(db, peer.peerNodeId);
  const status = refusalStatus(state.lastError);
  const outage: { situation: Situation; since: Instant } | undefined =
    state.failingSince !== null
      ? { situation: status === undefined ? "unreachable" : "refused", since: state.failingSince }
      : state.givenUpSince !== null
        ? { situation: "given-up", since: state.givenUpSince }
        : undefined;
  const current = outage === undefined ? undefined : `${prefix}${state.lastAcknowledgedAt ?? "never"}:${outage.situation}`;
  // An outage recorded before the peer's latest acknowledgement, or under a situation that no longer holds, is over.
  dismissNotificationsByKeyPrefix(db, {
    principalId: identity.ownerPrincipalId,
    dedupKeyPrefix: prefix,
    at,
    ...(current === undefined ? {} : { except: current }),
  });
  if (outage === undefined) return;
  // Failing is counted only over time this node watched; a message given up on was given up on, watched or not.
  const since = outage.situation === "given-up" ? outage.since : later(outage.since, observingSince);
  if (Date.parse(at) - Date.parse(since) < PEER_OFFLINE_NOTICE_AFTER_MS) return;
  tryRecordNodeNotice(
    services,
    peerOfflineNotice({
      peerNodeId: peer.peerNodeId,
      ...(peer.label === undefined ? {} : { label: peer.label }),
      situation: outage.situation,
      since,
      ...(outage.situation === "refused" && status !== undefined ? { status } : {}),
      lastAcknowledgedAt: state.lastAcknowledgedAt,
      at,
    }),
  );
}

/** One look at every paired node. One node that cannot be read is reported and does not stop the look at the others. */
export function reconcilePeerOutages(services: NoticeServices, at: Instant, observingSince: Instant): void {
  for (const peer of listPeers(services.runtime.db)) {
    try {
      reconcilePeer(services, peer, at, observingSince);
    } catch (cause) {
      process.stderr.write(
        `inbox: could not check delivery to ${peer.peerNodeId} (${cause instanceof Error ? cause.message : String(cause)})\n`,
      );
    }
  }
}

export interface PeerOutageWatch {
  /** Look at every paired node now. */
  reconcile(at: Instant): void;
  /** The machine was asleep until `at`: what failed before it is not counted as watched time. */
  woke(at: Instant): void;
}

/**
 * Watching for outages from this process's start. Kept in memory on purpose: after a restart or a wake the clock
 * starts again, which is what makes the threshold mean ten minutes this node saw, not ten minutes of stored history.
 */
export function watchPeerOutages(services: NoticeServices, startedAt: Instant): PeerOutageWatch {
  let observingSince = startedAt;
  return {
    reconcile(at) {
      reconcilePeerOutages(services, at, observingSince);
    },
    woke(at) {
      observingSince = later(observingSince, at);
    },
  };
}
