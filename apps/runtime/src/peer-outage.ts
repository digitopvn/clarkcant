import type { Instant } from "@clarkcant/contracts";
import {
  type PeerRecord,
  dismissNotificationsByKeyPrefix,
  latestNotificationKeyWithPrefix,
  listPeers,
  peerDeliveryState,
} from "@clarkcant/storage";

import { type NodeNotice, type NoticeServices, tryRecordNodeNotice } from "./notices.ts";
import { answeredStatus } from "./peer-transport.ts";

/**
 * Telling the owner when delivery to a paired node is not working, once per outage, and taking it back when it is.
 *
 * Read from the outbox's own retry state, never a second record. Four situations are told apart, because what the
 * person can do differs:
 *
 *   - unreachable: nothing answers. The messages wait in the queue and are retried for a while.
 *   - refused: the node answers, but turns the messages down (a 4xx). Turning it on changes nothing; the pairing or the
 *     versions on the two machines are what to look at.
 *   - erroring: the node answers with an error of its own (a 5xx). It is on; ClarkCant there is what to look at.
 *   - given up: everything owed since the node last answered was given up on. Nothing will be retried, and the notice
 *     says so rather than promising a retry.
 *
 * A blip is not an outage, so nothing is said until delivery has been failing for `PEER_OFFLINE_NOTICE_AFTER_MS` of
 * time this node was actually watching: an outage is counted from no earlier than this process started or the machine
 * last woke from sleep, so a laptop opened after a night does not report the night as an outage the moment it wakes.
 * When that clamp moved the start, the notice says "at least since", because the real start is earlier.
 *
 * One outage is everything between two acknowledgements from the peer, and it has exactly one visible notice: its keys
 * are `peer-offline:<peer>:<lastAck|never>:<n>:<situation>`, and each change of situation within the outage takes the
 * next `n`, so a situation that comes back (unreachable, given up, unreachable again) is a new notice rather than the
 * dismissed row of the first one. While the situation stays the same, however often this runs, it is the same notice, so
 * one the person dismissed stays dismissed. Everything else about the peer is dismissed when a new notice is recorded,
 * as soon as the peer acknowledges anything, and when the pairing is revoked.
 */

/**
 * How long delivery to a peer has to have been failing before the owner is told: ten minutes. Long enough that a
 * laptop lid closed for a moment or a restart says nothing, short enough to be heard while it still matters. The outbox
 * keeps retrying past it (its backoff reaches fifteen minutes between tries, and it gives a message up after twelve).
 */
export const PEER_OFFLINE_NOTICE_AFTER_MS = 10 * 60_000;

const OFFLINE_KEY_PREFIX = "peer-offline";

const SITUATIONS = ["unreachable", "refused", "erroring", "given-up"] as const;
type Situation = (typeof SITUATIONS)[number];

function offlinePrefix(peerNodeId: string): string {
  return `${OFFLINE_KEY_PREFIX}:${peerNodeId}:`;
}

/** The keys of one outage: everything said between the peer's last acknowledgement and the next. */
function outagePrefix(peerNodeId: string, lastAcknowledgedAt: Instant | null): string {
  return `${offlinePrefix(peerNodeId)}${lastAcknowledgedAt ?? "never"}:`;
}

/** Where a key of this outage got to: its place in the outage and its situation. */
function toldAt(prefix: string, key: string | undefined): { step: number; situation: Situation } | undefined {
  if (key === undefined || !key.startsWith(prefix)) return undefined;
  const match = /^(\d+):([a-z-]+)$/.exec(key.slice(prefix.length));
  const situation = SITUATIONS.find((known) => known === match?.[2]);
  return match?.[1] === undefined || situation === undefined ? undefined : { step: Number(match[1]), situation };
}

/**
 * A moment as a person on this machine reads it: hour and minute, the day, and the zone — the node's own, as its other
 * surfaces use, falling back to UTC — so it is not read in another zone by someone looking from elsewhere.
 */
function readableTime(at: Instant): string {
  const date = new Date(at);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const time = new Intl.DateTimeFormat("vi-VN", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const day = new Intl.DateTimeFormat("vi-VN", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(date).find((part) => part.type === "timeZoneName")
      ?.value ?? timeZone;
  return `${time} ngày ${day} (${zone})`;
}

const TITLES: Record<Situation, string> = {
  unreachable: "Không gửi được tới thiết bị khác",
  refused: "Thiết bị khác từ chối nhận",
  erroring: "Thiết bị khác báo lỗi khi nhận",
  "given-up": "Đã ngừng gửi tới thiết bị khác",
};

function body(situation: Situation, name: string, since: string, status: number | undefined): string {
  const code = status === undefined ? "" : ` (mã ${String(status)})`;
  switch (situation) {
    case "unreachable":
      return (
        `Không gửi được tới thiết bị ${name} ${since}: thiết bị đó không trả lời. ` +
        "Những gì cần gửi vẫn nằm trong hàng đợi trên máy này và còn được thử lại tự động một thời gian; thông báo này tự đóng khi gửi được. " +
        "Nếu thiết bị đó đã tắt hẳn hoặc đổi địa chỉ, hãy bật nó lên hoặc ghép cặp lại."
      );
    case "refused":
      return (
        `Thiết bị ${name} vẫn trả lời nhưng từ chối những gì máy này gửi ${since}${code}. ` +
        "Máy này còn thử lại một thời gian rồi sẽ dừng; thông báo này tự đóng nếu thiết bị đó nhận. " +
        "Hãy kiểm tra việc ghép cặp trên thiết bị đó, hoặc cập nhật ClarkCant trên cả hai máy."
      );
    case "erroring":
      return (
        `Thiết bị ${name} vẫn trả lời nhưng báo lỗi khi nhận những gì máy này gửi ${since}${code}: nó đang chạy, nhưng ClarkCant trên đó chưa xử lý được. ` +
        "Những gì cần gửi vẫn nằm trong hàng đợi trên máy này và còn được thử lại tự động một thời gian; thông báo này tự đóng khi gửi được. " +
        "Nếu lỗi kéo dài, hãy mở ClarkCant trên thiết bị đó để xem lỗi, rồi khởi động lại hoặc cập nhật nó."
      );
    case "given-up":
      return (
        `Máy này đã ngừng gửi tới thiết bị ${name}: những gì cần gửi ${since} không gửi được sau nhiều lần thử và đã bị bỏ, sẽ không được gửi lại. ` +
        "Việc đã giao cho thiết bị đó được chốt trong hội thoại của từng việc (thất bại hoặc chưa rõ). " +
        "Khi thiết bị đó hoạt động lại, hãy gửi lại những gì còn cần; thông báo này tự đóng khi thiết bị đó nhận được tin mới từ máy này."
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
  /** The failure may have started before `since`: this node was not watching then. */
  atLeast?: boolean;
  /** The status the peer answered with, when it answered. */
  status?: number;
  lastAcknowledgedAt: Instant | null;
  /** This outage's place in the sequence of situations it went through. */
  step: number;
  at: Instant;
}): NodeNotice {
  const since = `${input.atLeast === true ? "ít nhất từ lúc" : "từ lúc"} ${readableTime(input.since)}`;
  return {
    sourceKind: "system",
    category: "alert",
    severity: input.situation === "given-up" ? "error" : "warning",
    title: TITLES[input.situation],
    body: body(input.situation, input.label ?? input.peerNodeId, since, input.status),
    subject: { kind: "peer", nodeId: input.peerNodeId },
    dedupKey: `${outagePrefix(input.peerNodeId, input.lastAcknowledgedAt)}${String(input.step)}:${input.situation}`,
    at: input.at,
  };
}

const later = (first: Instant, second: Instant): Instant => (second > first ? second : first);

function situationOf(status: number | undefined): Situation {
  if (status === undefined) return "unreachable";
  return status >= 400 && status < 500 ? "refused" : "erroring";
}

/** One look at one paired node: record the outage that has lasted long enough, dismiss what no longer holds. */
function reconcilePeer(services: NoticeServices, peer: PeerRecord, at: Instant, observingSince: Instant): void {
  const { db, identity } = services.runtime;
  const principalId = identity.ownerPrincipalId;
  const prefix = offlinePrefix(peer.peerNodeId);
  if (peer.trustedAt === null || peer.revokedAt !== null) {
    dismissNotificationsByKeyPrefix(db, { principalId, dedupKeyPrefix: prefix, at });
    return;
  }
  const state = peerDeliveryState(db, peer.peerNodeId);
  const status = answeredStatus(state.lastError);
  const outage: { situation: Situation; since: Instant } | undefined =
    state.failingSince !== null
      ? { situation: situationOf(status), since: state.failingSince }
      : state.givenUpSince !== null
        ? { situation: "given-up", since: state.givenUpSince }
        : undefined;
  if (outage === undefined) {
    // Nothing is failing: whatever was said about this peer is over.
    dismissNotificationsByKeyPrefix(db, { principalId, dedupKeyPrefix: prefix, at });
    return;
  }

  const thisOutage = outagePrefix(peer.peerNodeId, state.lastAcknowledgedAt);
  const latest = latestNotificationKeyWithPrefix(db, { principalId, dedupKeyPrefix: thisOutage });
  const told = toldAt(thisOutage, latest);
  // Failing is counted only over time this node watched; a message given up on was given up on, watched or not.
  const since = outage.situation === "given-up" ? outage.since : later(outage.since, observingSince);
  const due = Date.parse(at) - Date.parse(since) >= PEER_OFFLINE_NOTICE_AFTER_MS;
  const step = told?.situation === outage.situation ? told.step : (told?.step ?? -1) + 1;
  // The same situation keeps its notice, dismissed or not; a new one is said once it is due, and until then the last
  // thing said about this outage stands. An earlier outage's notice never does.
  const keep = told?.situation === outage.situation || due ? `${thisOutage}${String(step)}:${outage.situation}` : latest;
  dismissNotificationsByKeyPrefix(db, { principalId, dedupKeyPrefix: prefix, at, ...(keep === undefined ? {} : { except: keep }) });
  if (!due) return;
  tryRecordNodeNotice(
    services,
    peerOfflineNotice({
      peerNodeId: peer.peerNodeId,
      ...(peer.label === undefined ? {} : { label: peer.label }),
      situation: outage.situation,
      since,
      atLeast: since !== outage.since,
      ...(outage.situation !== "unreachable" && outage.situation !== "given-up" && status !== undefined ? { status } : {}),
      lastAcknowledgedAt: state.lastAcknowledgedAt,
      step,
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
