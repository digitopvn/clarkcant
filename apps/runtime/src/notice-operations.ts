import {
  type Instant,
  type Notice,
  type NoticeActionUnavailable,
  type NoticeOperationId,
  type NoticeOperationResponse,
  type Principal,
  NOTICE_SNOOZE_MAX_MS,
  isNoticeOperation,
  isReconcileAction,
  noticeActionIdSchema,
  noticeSuppressionKey,
} from "@clarkcant/contracts";
import {
  type Database,
  type SkippedVersionKind,
  dismissNotification,
  findNoticeSuppression,
  getNotification,
  markNotificationsRead,
  markNotificationsUnread,
  removeNoticeSuppression,
  skipVersion,
  snoozeNotification,
  suppressNoticeKind,
  unsnoozeNotification,
} from "@clarkcant/storage";

import { installPackage, packageInstallDepsOf } from "./application/package-install.ts";
import { noticeActionsFor } from "./notice-actions.ts";
import { askExpiredQuestionAgain, retryBackgroundWork } from "./routes/conversations.ts";
import type { NodeServices } from "./services.ts";

/**
 * A notice's actions, carried out by the node, for every surface that can ask for one.
 *
 * The inbox panel, a typed or spoken "dismiss the latest notification", the main and the voice agent's `act_on_notice`,
 * MCP and `clarkcant api` all land in `performNoticeOperation`, and it does each action with the same storage calls and
 * the same application functions the inbox's own routes use (`retryBackgroundWork`, `installPackage`,
 * `askExpiredQuestionAgain`, the snooze and skip helpers below). A second way to dismiss or to retry would be a second
 * set of checks, and the one nobody exercises is the one that rots.
 *
 * What may be done to a notice is never taken on the caller's word. The node reads the notice, works out its actions now
 * (`noticeActionsFor`, the same resolver that draws the panel's buttons), and refuses one that is not offered, or offered
 * with a reason it cannot be taken, before anything changes. So an agent cannot retry work the panel would not offer to
 * retry, and a stale request — the package already updated, the question already asked again — is told so.
 *
 * None of these is the person's decision about something an agent wants to do, which is why no machine surface is kept
 * from them. The two that are — the answers about an effect whose outcome nobody observed — are refused here and have
 * their own person-only route; an install that needs approval stops at `approval-required`, and the approval stays the
 * person's.
 */

export type NoticeOperationServices = Pick<NodeServices, "runtime" | "conductor" | "search" | "turnControl" | "serviceHost">;

export interface NoticeOperationInput {
  noticeId: string;
  /** As the caller named it: checked here, so a route and a tool refuse an unknown name the same way. */
  action: string;
  /** The end of a snooze; required by `snooze` and read by nothing else. */
  until?: string;
}

export type NoticeOperationOutcome =
  | { ok: true; response: NoticeOperationResponse }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 422 | 429 | 500;
      code: string;
      message: string;
      /** Why an offered action cannot be taken now, when that is the refusal. */
      reason?: NoticeActionUnavailable;
    };

/** The actions only the person's own screen can carry out, because they change what that screen shows. */
const SURFACE_ACTIONS: ReadonlySet<string> = new Set(["open", "ask-clark", "add-to-context", "review-update"]);

/**
 * Said when a notice kind is too wide to quiet (`noticeKindQuietable`). The panel never offers it for such a notice, but
 * the route refuses it anyway, because the route is reachable without the panel.
 */
export const SUPPRESSION_TOO_BROAD_MESSAGE =
  "Không tắt báo được cho loại thông báo này: nó không gắn với một việc tự động, nguồn, gói hay node cụ thể, nên tắt báo sẽ tắt luôn cả lời nhắc và thông báo của những việc khác. Bạn vẫn có thể bỏ hoặc hoãn riêng thông báo này.";

/**
 * The end of a snooze as the node stores it, or nothing when it is not after `now` and within `NOTICE_SNOOZE_MAX_MS`.
 *
 * Stored in one form, milliseconds included: storage compares instants as text, and `…T18:00:00Z` sorts after
 * `…T18:00:00.500Z` although it is earlier.
 */
export function snoozeEndWithinRange(until: string, now: Instant): Instant | undefined {
  const at = Date.parse(until);
  if (!Number.isFinite(at)) return undefined;
  const ahead = at - Date.parse(now);
  if (ahead <= 0 || ahead > NOTICE_SNOOZE_MAX_MS) return undefined;
  // SAFETY: `toISOString` of a finite date is a UTC instant.
  return new Date(at).toISOString() as Instant;
}

/** The package or Pi SDK version an update notice names, as `skipped_versions` keys it, or nothing for any other notice. */
export function skippedVersionOf(notice: Notice): { subjectKind: SkippedVersionKind; name: string; version: string } | undefined {
  const subject = notice.subject;
  if (notice.category !== "update") return undefined;
  if (subject?.kind === "package" && subject.version !== undefined) {
    return { subjectKind: "package", name: subject.packageId, version: subject.version };
  }
  if (subject?.kind === "pi-update") return { subjectKind: "pi", name: subject.packageName, version: subject.version };
  return undefined;
}

/**
 * "Skip this version": stop reporting the version the notice names, and any older one, then take the notice out. The
 * version is read from the notice this node stored, never from a request, so a caller cannot name some other package or
 * version through it.
 */
export function skipNoticeVersion(
  db: Database,
  input: { principalId: string; notice: Notice; at: Instant },
): { subjectKind: SkippedVersionKind; name: string; version: string } | undefined {
  const skipped = skippedVersionOf(input.notice);
  if (skipped === undefined) return undefined;
  skipVersion(db, { principalId: input.principalId, ...skipped, at: input.at });
  dismissNotification(db, { principalId: input.principalId, notificationId: input.notice.noticeId, at: input.at });
  return skipped;
}

/** Notify about this notice's kind again. Nothing quieted for it any more is what was asked for, so it is not an error. */
export function unsuppressNoticeKindOf(db: Database, principalId: string, notice: Notice): void {
  const suppression = findNoticeSuppression(db, principalId, noticeSuppressionKey(notice));
  if (suppression !== undefined) removeNoticeSuppression(db, { principalId, suppressionId: suppression.suppressionId });
}

export async function performNoticeOperation(
  services: NoticeOperationServices,
  input: NoticeOperationInput,
  at: () => Instant,
): Promise<NoticeOperationOutcome> {
  const { db, identity } = services.runtime;
  const principalId = identity.ownerPrincipalId;
  const known = noticeActionIdSchema.safeParse(input.action);
  if (!known.success) {
    return { ok: false, status: 400, code: "UNKNOWN_ACTION", message: `"${input.action}" is not a notice action` };
  }
  if (isReconcileAction(known.data)) {
    // The person's answer about an effect is theirs alone; its route is person-only and this one is not.
    return {
      ok: false,
      status: 403,
      code: "PERSON_ONLY",
      message: "whether an effect took effect is recorded only by the person, through POST /effects/:effectId/reconcile",
    };
  }
  if (SURFACE_ACTIONS.has(known.data) || !isNoticeOperation(known.data)) {
    return {
      ok: false,
      status: 409,
      code: "SURFACE_ACTION",
      message: `${known.data} changes what the person's own screen shows, so only that screen carries it out`,
    };
  }
  const action: NoticeOperationId = known.data;

  const now = at();
  const stored = getNotification(db, principalId, input.noticeId, now);
  // Another principal's notice is not found at all, rather than refused: saying it exists would be saying too much.
  if (stored === undefined || stored.dismissed) {
    return { ok: false, status: 404, code: "RESOURCE_NOT_FOUND", message: "that notice is not in the inbox" };
  }
  const notice = stored.notice;

  // Read and unread are attention state and always true to ask for: marking a read notice read changes nothing.
  if (action !== "mark-read" && action !== "mark-unread") {
    const offered = noticeActionsFor(db, principalId, notice, { nodeId: identity.nodeId, now }).find((entry) => entry.id === action);
    if (offered === undefined) {
      return { ok: false, status: 409, code: "ACTION_NOT_OFFERED", message: `${action} is not something that can be done to this notice now` };
    }
    if (offered.unavailable !== undefined) {
      return {
        ok: false,
        status: 409,
        code: "ACTION_UNAVAILABLE",
        message: `${action} cannot be taken now: ${offered.unavailable}`,
        reason: offered.unavailable,
      };
    }
  }

  const done = (extra: Partial<NoticeOperationResponse> = {}): NoticeOperationOutcome => ({
    ok: true,
    response: { noticeId: notice.noticeId, action, outcome: "done", ...extra },
  });

  switch (action) {
    case "mark-read":
      markNotificationsRead(db, { principalId, at: now, notificationIds: [notice.noticeId] });
      return done();
    case "mark-unread":
      markNotificationsUnread(db, { principalId, notificationIds: [notice.noticeId] });
      return done();
    case "dismiss":
      if (!dismissNotification(db, { principalId, notificationId: notice.noticeId, at: now })) {
        return { ok: false, status: 404, code: "RESOURCE_NOT_FOUND", message: "that notice is not in the inbox" };
      }
      return done();
    case "snooze": {
      if (input.until === undefined) {
        return { ok: false, status: 400, code: "INVALID_SCHEMA", message: "a snooze needs until, the UTC instant the notice comes back" };
      }
      const until = snoozeEndWithinRange(input.until, now);
      if (until === undefined) {
        return { ok: false, status: 400, code: "SNOOZE_OUT_OF_RANGE", message: "a notice is snoozed until a time after now and at most 30 days away" };
      }
      if (!snoozeNotification(db, { principalId, notificationId: notice.noticeId, until, at: now })) {
        return { ok: false, status: 404, code: "RESOURCE_NOT_FOUND", message: "that notice is not in the inbox" };
      }
      return done({ snoozedUntil: until });
    }
    case "unsnooze":
      if (unsnoozeNotification(db, { principalId, notificationId: notice.noticeId, at: now }) === "not-found") {
        return { ok: false, status: 404, code: "RESOURCE_NOT_FOUND", message: "that notice is not in the inbox" };
      }
      return done();
    case "suppress": {
      const outcome = suppressNoticeKind(db, {
        principalId,
        notificationId: notice.noticeId,
        suppressionId: services.conductor.newId("nsp"),
        at: now,
      });
      if (outcome === "not-found") return { ok: false, status: 404, code: "RESOURCE_NOT_FOUND", message: "that notice is not in the inbox" };
      if (outcome === "too-broad") return { ok: false, status: 409, code: "SUPPRESSION_TOO_BROAD", message: SUPPRESSION_TOO_BROAD_MESSAGE };
      return done();
    }
    case "unsuppress":
      unsuppressNoticeKindOf(db, principalId, notice);
      return done();
    case "retry": {
      // Offered only for a background-work subject (`subjectOperations`); checked again so the type says so.
      if (notice.subject?.kind !== "background-work") return notOffered(action);
      const owner: Principal = {
        principalId: principalId as Principal["principalId"],
        kind: "user",
        nodeId: identity.nodeId as Principal["nodeId"],
      };
      const retried = retryBackgroundWork(services, owner, at, notice.subject.workId);
      if (!retried.ok) return { ok: false, status: retried.status, code: retried.code, message: retried.message };
      return done({ workId: retried.workId, state: retried.state, ...(retried.position === undefined ? {} : { position: retried.position }) });
    }
    case "update": {
      const subject = notice.subject;
      if (subject?.kind !== "package" || subject.version === undefined) return notOffered(action);
      // The ordinary install, so every check an install makes applies, and an approval it needs stays the person's.
      const installed = await installPackage(packageInstallDepsOf(services), { packageId: subject.packageId, version: subject.version });
      if (installed.kind === "refused") {
        return { ok: false, status: httpStatusOf(installed.status), code: installed.code, message: installed.message };
      }
      if (installed.kind === "approval-required") {
        return {
          ok: true,
          response: { noticeId: notice.noticeId, action, outcome: "approval-required", version: subject.version, approvalId: installed.approvalId },
        };
      }
      // The notice has done its job. Not dismissed (it was dismissed meanwhile) is not a failure: it then says the
      // version is already installed, which is true.
      dismissNotification(db, { principalId, notificationId: notice.noticeId, at: at() });
      return done({ version: installed.version });
    }
    case "skip-version": {
      const skipped = skipNoticeVersion(db, { principalId, notice, at: now });
      if (skipped === undefined) return { ok: false, status: 409, code: "NOT_AN_UPDATE", message: "only an update notice names a version that can be skipped" };
      return done({ version: skipped.version });
    }
    case "ask-again": {
      if (notice.subject?.kind !== "question") return notOffered(action);
      const asked = askExpiredQuestionAgain(services, notice.subject.conversationId, notice.subject.questionId, at);
      if (!asked.ok) return { ok: false, status: asked.status, code: asked.code, message: asked.message };
      return done({ questionId: asked.questionId });
    }
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}

function notOffered(action: NoticeOperationId): NoticeOperationOutcome {
  return { ok: false, status: 409, code: "ACTION_NOT_OFFERED", message: `${action} is not something that can be done to this notice now` };
}

/** An install refusal's status, kept to the ones this route answers with; anything else is the node's own failure. */
function httpStatusOf(status: number): 400 | 403 | 404 | 409 | 422 | 429 | 500 {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 422:
    case 429:
      return status;
    default:
      return status >= 500 ? 500 : 409;
  }
}
