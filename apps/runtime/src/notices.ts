import type {
  AppIntentLocale,
  Instant,
  NoticeCategory,
  NoticeSeverity,
  NoticeSourceKind,
  NoticeSubject,
  RiskLane,
} from "@clarkcant/contracts";
import { type Database, dismissNotificationsByKeyPrefix, recordNotification } from "@clarkcant/storage";

import { noticeText } from "./notice-text.ts";

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
 * `originNodeId` is set for a notice a paired node sent (`peer-notices.ts`): it is recorded through this same function,
 * under a dedup key built from the peer and the peer's own key for it, so at-least-once delivery lands once. Nothing
 * recorded here is passed on to a peer by itself: a notice leaves this node only when something asks for it to be sent.
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
  /**
   * What the notice is about, when it is more than its conversation: the task, the background work, the package. A
   * pointer the host resolves when the inbox is read; a producer names the thing and never what can be done with it.
   */
  subject?: NoticeSubject;
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
 * Record an update notice and retire the ones it supersedes: every earlier undismissed update notice for the same
 * package, whichever version it offered. An inbox that says "0.85.1 → 0.87.1" beside "0.85.1 → 1.0.2" tells the
 * person two things where only the newer is still worth doing.
 *
 * Retired, not deleted: the same dismissal a person makes (`dismissNotificationsByKeyPrefix`), so the rows stay for the
 * retention window, keep their audit trail, and keep the producer deduplicated — an older version checked again does
 * not come back. Matched on the dedup key rather than the stored subject, so a row written before subjects existed is
 * retired too. Recorded first and retired after, so a write that fails never leaves the person with no notice at all;
 * like `tryRecordNodeNotice`, a storage failure is reported on stderr and never fails the check that found the update.
 *
 * Only a notice this call actually wrote supersedes anything. A check that finds a version it already announced — the
 * directory withdrew the newer one, say — changes nothing: retiring then would take down the newer notice while the
 * older one, dismissed earlier, stays down, and leave the inbox saying nothing at all.
 */
export function tryRecordUpdateNotice(services: NoticeServices, notice: NodeNotice, supersedes: readonly string[]): void {
  try {
    if (!recordNodeNotice(services, notice).created) return;
    for (const dedupKeyPrefix of supersedes) {
      dismissNotificationsByKeyPrefix(services.runtime.db, {
        principalId: services.runtime.identity.ownerPrincipalId,
        dedupKeyPrefix,
        at: notice.at,
        except: notice.dedupKey,
        // A version never contains `@`; another package whose id merely starts with this one's does.
        restWithout: "@",
      });
    }
  } catch (cause) {
    process.stderr.write(
      `inbox: could not record a ${notice.sourceKind} update notice (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
  }
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
 * The one inbox entry a dispatched task gets for how it ended.
 *
 * Shared by the notice a task leaves when it settles and the one for an effect of it whose outcome is unknown, so a
 * task that became uncertain because of that effect is one warning, whichever of the two is written first.
 */
export function workerNoticeKey(taskId: string): string {
  return `worker:${taskId}`;
}

/**
 * The notice a dispatched task leaves when it settles.
 *
 * A cancellation was the person's own doing, so it is information rather than something that went wrong;
 * "uncertain" is a warning because the task may or may not have had its effect, and that is worth a look. The task id
 * is the dedup key and never the title: it is an internal handle, and the title is what a person reads first. The title
 * is in the owner's `language` (Vietnamese when none is named); the body is the task's own message.
 */
export function workerSettledNotice(input: {
  taskId: string;
  conversationId: string;
  outcome: "succeeded" | "failed" | "cancelled" | "uncertain";
  message: string;
  at: Instant;
  language?: AppIntentLocale;
}): NodeNotice {
  return {
    sourceKind: "worker",
    category: "result",
    severity: WORKER_SEVERITY[input.outcome],
    title: noticeText(input.language).workerOutcome[input.outcome],
    body: input.message,
    conversationId: input.conversationId,
    subject: { kind: "task", taskId: input.taskId, conversationId: input.conversationId },
    dedupKey: workerNoticeKey(input.taskId),
    at: input.at,
  };
}

const WORKER_SEVERITY: Record<"succeeded" | "failed" | "cancelled" | "uncertain", NoticeSeverity> = {
  succeeded: "success",
  failed: "error",
  cancelled: "info",
  uncertain: "warning",
};

/** Every package update notice for `packageId` from `sourceKind`, whatever version it offers, starts with this. */
export function packageUpdateKeyPrefix(sourceKind: "npm" | "git" | "local", packageId: string): string {
  return `update:${sourceKind}:${packageId}@`;
}

/**
 * The key prefixes of every update notice about `packageId`, from any source: one installed package has one update
 * worth offering, so a newer version from git supersedes an older one announced from npm as well.
 */
export function packageUpdateKeyPrefixes(packageId: string): string[] {
  return (["npm", "git", "local"] as const).map((sourceKind) => packageUpdateKeyPrefix(sourceKind, packageId));
}

/** Every Pi SDK update notice this node ever wrote starts with this. */
const PI_UPDATE_KEY_PREFIX = "update:pi:";

/**
 * Retire the Pi SDK update notices a node wrote before the SDK stopped being checked: it ships pinned with ClarkCant,
 * so nothing in the inbox could act on one. The ordinary dismissal, as for any notice that stopped being true, so the
 * rows age out with the retention window; a storage failure is reported on stderr and never fails the check.
 */
export function tryRetirePiUpdateNotices(services: NoticeServices, at: Instant): void {
  try {
    dismissNotificationsByKeyPrefix(services.runtime.db, {
      principalId: services.runtime.identity.ownerPrincipalId,
      dedupKeyPrefix: PI_UPDATE_KEY_PREFIX,
      at,
    });
  } catch (cause) {
    process.stderr.write(
      `inbox: could not retire Pi update notices (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
  }
}

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
 *
 * Worded in the owner's `language` (Vietnamese when none is named). The risk lane follows the same four lanes and the
 * same rule `packages/conversation-client/src/package-provenance.ts` uses for the marketplace list: a native Pi
 * extension is trusted process-level code that runs beside the host, and an isolated widget is opaque-origin code with
 * none of that — AGENTS.md names showing the two with the same wording as the one mistake this exists to prevent.
 */
export function packageUpdateNotice(input: {
  packageId: string;
  currentVersion: string;
  newVersion: string;
  sourceKind: "npm" | "git" | "local";
  lane: RiskLane;
  at: Instant;
  language?: AppIntentLocale;
}): NodeNotice {
  const say = noticeText(input.language).packageUpdate;
  return {
    sourceKind: "package",
    category: "update",
    severity: "info",
    title: say.title(input.packageId),
    body: say.body(input.currentVersion, input.newVersion, input.sourceKind, say.lane[input.lane]),
    subject: { kind: "package", packageId: input.packageId, version: input.newVersion, source: input.sourceKind },
    dedupKey: `${packageUpdateKeyPrefix(input.sourceKind, input.packageId)}${input.newVersion}`,
    at: input.at,
  };
}
