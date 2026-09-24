import type { Instant, NoticeCategory, NoticeSeverity, NoticeSourceKind, RiskLane } from "@clarkcant/contracts";
import { type Database, recordNotification } from "@clarkcant/storage";

/**
 * Writing a notice into the person's inbox, from anywhere on this node.
 *
 * The one door producers use, so the rules live in one place: the notice belongs to the node's owner, its id is
 * minted here, and its text is redacted and bounded by the repository before it is stored. A producer says *what
 * happened* and *what key identifies it*; it does not get to pick who reads it.
 *
 * A notice is a pointer and a sentence, never the result itself. The result of background work is a message in its
 * conversation, which is where the person reads it; the notice exists because nobody was looking at that
 * conversation when it arrived.
 *
 * `originNodeId` is here for the NodeLink path that does not exist yet: a peer's notice is recorded through this
 * same function, with the peer's message id as its dedup key, so at-least-once delivery lands once.
 */
export interface NoticeServices {
  runtime: { db: Database; identity: { ownerPrincipalId: string } };
  conductor: { newId: (prefix: string) => string };
}

export interface NodeNotice {
  sourceKind: NoticeSourceKind;
  category: NoticeCategory;
  severity: NoticeSeverity;
  title: string;
  body?: string;
  conversationId?: string;
  originNodeId?: string;
  dedupKey: string;
  at: Instant;
}

export function recordNodeNotice(services: NoticeServices, notice: NodeNotice): { notificationId: string; created: boolean } {
  return recordNotification(services.runtime.db, {
    notificationId: services.conductor.newId("ntf"),
    principalId: services.runtime.identity.ownerPrincipalId,
    ...notice,
  });
}

/**
 * The same, for a producer that must not fail because the inbox did.
 *
 * Background work has already finished and written its result into the conversation by the time this runs. A
 * notice that could not be written is a missed pointer, not a lost result, so it is reported on stderr and the
 * producer carries on — throwing here would turn a finished job into a failed one.
 */
export function tryRecordNodeNotice(services: NoticeServices, notice: NodeNotice): void {
  try {
    recordNodeNotice(services, notice);
  } catch (cause) {
    process.stderr.write(
      `inbox: could not record a ${notice.sourceKind} notice (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
  }
}

/**
 * The notice a dispatched task leaves when it settles.
 *
 * A cancellation was the person's own doing, so it is information rather than something that went wrong;
 * "uncertain" is a warning because the task may or may not have had its effect, and that is worth a look. The task id
 * is the dedup key and never the title: it is an internal handle, and the title is what a person reads first.
 */
export function workerSettledNotice(input: {
  taskId: string;
  conversationId: string;
  outcome: "succeeded" | "failed" | "cancelled" | "uncertain";
  message: string;
  at: Instant;
}): NodeNotice {
  const { severity, title } = WORKER_OUTCOMES[input.outcome];
  return {
    sourceKind: "worker",
    category: "result",
    severity,
    title,
    body: input.message,
    conversationId: input.conversationId,
    dedupKey: `worker:${input.taskId}`,
    at: input.at,
  };
}

const WORKER_OUTCOMES: Record<
  "succeeded" | "failed" | "cancelled" | "uncertain",
  { severity: NoticeSeverity; title: string }
> = {
  succeeded: { severity: "success", title: "Việc chạy nền đã xong" },
  failed: { severity: "error", title: "Việc chạy nền không xong" },
  cancelled: { severity: "info", title: "Việc chạy nền đã được hủy" },
  uncertain: { severity: "warning", title: "Việc chạy nền chưa rõ kết quả" },
};

/**
 * The risk lane's wording, in Vietnamese, for a notice body.
 *
 * The same four lanes and the same rule `packages/conversation-client/src/package-provenance.ts` uses for the
 * marketplace list: a native Pi extension is trusted process-level code that runs beside the host, and an isolated
 * widget is opaque-origin code with none of that — AGENTS.md names showing the two with the same wording as the
 * one mistake this exists to prevent, so an update notice about a `trusted-native` package says so plainly rather
 * than reusing the isolated-widget sentence for both.
 */
const LANE_LABEL: Record<RiskLane, string> = {
  declarative: "chỉ dữ liệu",
  "isolated-ui": "widget cách ly",
  service: "service riêng tiến trình",
  "trusted-native": "extension Pi gốc — chạy cùng tiến trình",
};

/**
 * The notice that a directory-listed package or widget has a newer version than the one installed on this node.
 *
 * `dedupKey` names the exact artifact a repeated check would find again (`update:<source>:<packageId>@<version>`),
 * so polling this every few hours never adds a second row for the same version while its row is still there.
 * That is not forever: `recordNotification` removes a dismissed notice once it is more than
 * `DISMISSED_RETENTION_MS` (30 days) past dismissal, and separately caps the undismissed inbox at
 * `MAX_NOTIFICATIONS`, oldest evicted first. Once this row is gone either way, the same version checking again
 * writes a fresh notice — so a person who dismissed an update notice can see the very same version come back, not
 * only a newer one, once that row has aged out or been evicted.
 */
export function packageUpdateNotice(input: {
  packageId: string;
  currentVersion: string;
  newVersion: string;
  sourceKind: "npm" | "git" | "local";
  lane: RiskLane;
  at: Instant;
}): NodeNotice {
  return {
    sourceKind: "package",
    category: "update",
    severity: "info",
    title: `Có bản cập nhật: ${input.packageId}`,
    body: `${input.currentVersion} → ${input.newVersion} · nguồn ${input.sourceKind} · ${LANE_LABEL[input.lane]}`,
    dedupKey: `update:${input.sourceKind}:${input.packageId}@${input.newVersion}`,
    at: input.at,
  };
}

/**
 * The notice that a newer Pi SDK is published than the one `packages/pi-adapter` runs.
 *
 * The Pi SDK is host-owned, in-process code — the same `trusted-native` lane a native Pi extension runs in — so the
 * body says that explicitly rather than leaving the reader to guess how trusted an SDK bump is.
 */
export function piUpdateNotice(input: {
  packageName: string;
  currentVersion: string;
  newVersion: string;
  at: Instant;
}): NodeNotice {
  return {
    sourceKind: "pi",
    category: "update",
    severity: "info",
    title: "Có bản cập nhật cho Pi SDK",
    body: `${input.currentVersion} → ${input.newVersion} · ${LANE_LABEL["trusted-native"]}`,
    dedupKey: `update:pi:${input.packageName}@${input.newVersion}`,
    at: input.at,
  };
}
