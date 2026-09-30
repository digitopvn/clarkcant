import {
  type Instant,
  type Notice,
  type NoticeActionUnavailable,
  type NoticeOperationId,
  type NoticeOperationResponse,
  type NoticeOperationSource,
  type Principal,
  NOTICE_SNOOZE_MAX_MS,
  NOTICE_UPDATE_PERSON_ONLY_MESSAGE,
  isNoticeOperation,
  isPersonOnlyNoticeOperation,
  isReconcileAction,
  noticeActionIdSchema,
  noticeSuppressionKey,
} from "@clarkcant/contracts";
import {
  type Database,
  type SkippedVersionKind,
  appendEvent,
  dismissNotification,
  findNoticeSuppression,
  getNotification,
  markNotificationsRead,
  markNotificationsUnread,
  removeNoticeSuppression,
  restoreNotification,
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
 * Most of these are attention state or a retry of the person's own work, and any surface may ask for them. Three are
 * not. The answers about an effect whose outcome nobody observed are refused here and have their own person-only route.
 * `update` installs new code and grants it what its manifest asks for, so it is the person's
 * (`PERSON_ONLY_NOTICE_OPERATIONS`): its route is person-only, and the agents and machine surfaces that reach this
 * function in process are refused by `surface` before anything is read. An install the policy asks about stops at
 * `approval-required`, and that approval stays the person's too.
 *
 * Every call is recorded (`inbox.notice-action`) with the surface it came from and what came of it, so the audit can
 * tell a press from a sentence, an agent from an MCP client.
 */

export type NoticeOperationServices = Pick<NodeServices, "runtime" | "conductor" | "search" | "turnControl" | "serviceHost">;

/**
 * Who asked. `click`, `chat` and `voice` are the person's own page, as it labels itself; `agent` and `voice-agent` are the
 * models' `act_on_notice`; `mcp` and `relay` are the machine surfaces that reach the route in process and say so; `api`
 * is any other HTTP caller that gave no label. Only the in-process surfaces are known for certain — a label a request
 * carries is recorded, never trusted — so the only thing decided from this is to refuse more, never to allow more.
 */
export type NoticeOperationSurface = NoticeOperationSource | "agent" | "voice-agent" | "mcp" | "relay" | "api";

/** The surfaces that are never the person deciding: an agent, or a machine surface the node knows it is serving. */
const NOT_THE_PERSON: ReadonlySet<NoticeOperationSurface> = new Set(["agent", "voice-agent", "mcp", "relay"]);

export interface NoticeOperationInput {
  noticeId: string;
  /** As the caller named it: checked here, so a route and a tool refuse an unknown name the same way. */
  action: string;
  /** The end of a snooze; required by `snooze` and read by nothing else. */
  until?: string;
  surface: NoticeOperationSurface;
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

/**
 * The updates being installed now, per node database, by notice. Two presses — the panel and an agent's sentence, two
 * windows — would otherwise both pass the offered check before either install lands and install twice; the second is
 * told the first is still running instead.
 */
const updatesInFlight = new WeakMap<Database, Set<string>>();

export async function performNoticeOperation(
  services: NoticeOperationServices,
  input: NoticeOperationInput,
  at: () => Instant,
): Promise<NoticeOperationOutcome> {
  let outcome: NoticeOperationOutcome;
  try {
    outcome = await carryOutNoticeOperation(services, input, at);
  } catch (cause) {
    recordNoticeAction(services, input, at, { result: "failed" });
    throw cause;
  }
  recordNoticeAction(
    services,
    input,
    at,
    outcome.ok ? { result: outcome.response.outcome } : { result: "refused", code: outcome.code },
  );
  return outcome;
}

/**
 * The audit record of one notice action: which notice, which action, from which surface, and what came of it. Written
 * after the action, so it says what happened rather than what was asked; a failure to write it is reported on the node
 * and does not turn an action that happened into one that reads as failed.
 */
function recordNoticeAction(
  services: NoticeOperationServices,
  input: NoticeOperationInput,
  at: () => Instant,
  result: { result: "done" | "approval-required" | "refused" | "failed"; code?: string },
): void {
  const { db, identity } = services.runtime;
  try {
    appendEvent(db, {
      eventId: services.conductor.newId("evt"),
      kind: "inbox.notice-action",
      stream: "inbox.notice-action",
      nodeId: identity.nodeId,
      document: {
        // Bounded: both come from the caller, and a record is not a place to store whatever a request carried.
        noticeId: input.noticeId.slice(0, 128),
        action: input.action.slice(0, 40),
        surface: input.surface,
        ...result,
      },
      occurredAt: at(),
    });
  } catch (cause) {
    process.stderr.write(`notice actions: could not record ${input.action} (${cause instanceof Error ? cause.message : String(cause)})\n`);
  }
}

async function carryOutNoticeOperation(
  services: NoticeOperationServices,
  input: NoticeOperationInput,
  at: () => Instant,
): Promise<NoticeOperationOutcome> {
  const { db, identity } = services.runtime;
  const principalId = identity.ownerPrincipalId;
  const asked = input.action;
  if (!isNoticeOperation(asked)) {
    const known = noticeActionIdSchema.safeParse(asked);
    if (!known.success) {
      return { ok: false, status: 400, code: "UNKNOWN_ACTION", message: `"${asked.slice(0, 40)}" is not a notice action` };
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
    // `open`, `ask-clark`, `add-to-context`, `review-update`: every other action a notice offers.
    return {
      ok: false,
      status: 409,
      code: "SURFACE_ACTION",
      message: `${known.data} changes what the person's own screen shows, so only that screen carries it out`,
    };
  }
  const action: NoticeOperationId = asked;
  if (isPersonOnlyNoticeOperation(action) && NOT_THE_PERSON.has(input.surface)) {
    // Refused before the notice is read, the same answer the person-only route gives a machine surface.
    return { ok: false, status: 403, code: "PERSON_ONLY", message: NOTICE_UPDATE_PERSON_ONLY_MESSAGE };
  }

  const now = at();
  const stored = getNotification(db, principalId, input.noticeId, now);
  if (action === "restore") return restoreDismissedNotice(db, principalId, stored, now);
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
      // The reason travels as `reason`, a code each surface words in its own language; the message is the fallback.
      return {
        ok: false,
        status: 409,
        code: "ACTION_UNAVAILABLE",
        message: `${action} cannot be taken on this notice now`,
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
      let inFlight = updatesInFlight.get(db);
      if (inFlight === undefined) {
        inFlight = new Set();
        updatesInFlight.set(db, inFlight);
      }
      if (inFlight.has(notice.noticeId)) {
        return { ok: false, status: 409, code: "ACTION_IN_PROGRESS", message: "this update is already being installed" };
      }
      inFlight.add(notice.noticeId);
      try {
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
        // Said, not dropped: the package runs without these until the person grants them, and "installed" alone would
        // read as "installed with everything it asked for".
        return done({
          version: installed.version,
          pendingCapabilities: installed.pendingCapabilities.length,
          deniedCapabilities: installed.deniedCapabilities.length,
        });
      } finally {
        inFlight.delete(notice.noticeId);
      }
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

/**
 * Undo a dismissal, while it is recent enough to be one (`NOTICE_DISMISS_UNDO_WINDOW_MS`). A notice already back —
 * from a second press, or the panel's own Undo — is what was asked for, so it is not an error.
 */
function restoreDismissedNotice(
  db: Database,
  principalId: string,
  stored: { notice: Notice; dismissed: boolean } | undefined,
  now: Instant,
): NoticeOperationOutcome {
  if (stored === undefined) return { ok: false, status: 404, code: "RESOURCE_NOT_FOUND", message: "that notice is not in the inbox" };
  const response: NoticeOperationResponse = { noticeId: stored.notice.noticeId, action: "restore", outcome: "done" };
  if (!stored.dismissed) return { ok: true, response };
  switch (restoreNotification(db, { principalId, notificationId: stored.notice.noticeId, at: now })) {
    case "restored":
    case "not-dismissed":
      return { ok: true, response };
    case "expired":
      return { ok: false, status: 409, code: "UNDO_EXPIRED", message: "that notice was dismissed too long ago to undo" };
    case "not-found":
      return { ok: false, status: 404, code: "RESOURCE_NOT_FOUND", message: "that notice is not in the inbox" };
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
