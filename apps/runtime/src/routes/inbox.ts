import {
  type Instant,
  type NoticeOperationSource,
  inboxReadRequestSchema,
  inboxSnoozeRequestSchema,
  inboxUnreadRequestSchema,
  noticeOperationRequestSchema,
} from "@clarkcant/contracts";
import {
  dismissNotification,
  getNotification,
  markNotificationsRead,
  markNotificationsUnread,
  removeNoticeSuppression,
  restoreNotification,
  snoozeNotification,
  suppressNoticeKind,
  unsnoozeNotification,
  unskipVersion,
} from "@clarkcant/storage";

import { inboxSummary, readInbox } from "../inbox.ts";
import {
  type NoticeOperationServices,
  type NoticeOperationSurface,
  SUPPRESSION_TOO_BROAD_MESSAGE,
  performNoticeOperation,
  skipNoticeVersion,
  skippedVersionOf,
  snoozeEndWithinRange,
  unsuppressNoticeKindOf,
} from "../notice-operations.ts";
import { type GatewayRequest, type GatewayResponse, SURFACE_HEADER, fail, json, readJson } from "./http.ts";

/**
 * The inbox family.
 *
 *   GET  /inbox                              waiting items + notices, as a snapshot with the time it was read
 *   GET  /inbox/summary                      the two counts the header mark polls
 *   POST /inbox/read        { noticeIds? }   mark notices read (no ids: all of them)
 *   POST /inbox/unread      { noticeIds }    mark notices unread again
 *   POST /inbox/notices/:id/dismiss          take one notice out of the list
 *   POST /inbox/notices/:id/restore          undo a dismissal, while it is recent enough to be an undo
 *   POST /inbox/notices/:id/snooze { until } out of the list and the count until then; back unread after
 *   POST /inbox/notices/:id/unsnooze         take a snooze back: the notice returns as it was
 *   POST /inbox/notices/:id/suppress         stop notifying about notices of this one's kind (409 when too broad)
 *   POST /inbox/notices/:id/unsuppress       notify about this one's kind again
 *   POST /inbox/notices/:id/skip-version     stop reporting the version an update notice names (and older); dismisses it
 *   POST /inbox/notices/:id/unskip-version   take that back: the version is reported again and the notice returns
 *   DELETE /inbox/suppressions/:id           the same, from the list of quieted kinds
 *   DELETE /inbox/skipped-versions/:kind/:name/:version
 *                                            take a skip back from the list of skipped versions, which outlasts its notice
 *   POST /inbox/notices/:id/actions/:action { until?, source? }
 *                                            any action the node carries out on a notice, by the name the resolver gives
 *                                            it (`NOTICE_OPERATION_IDS`), checked against what the notice offers now;
 *                                            `restore` undoes a recent dismissal; `update` is person-only
 *
 * The last route is the one every surface shares — the page's commands and Undo, MCP, `clarkcant api` and the agents'
 * `act_on_notice` reach the same function (`performNoticeOperation`), which records who asked — and the routes above it
 * stay for the panel, which also has Undo for them. Its action segment is read raw, like `isPersonOnlyRoute` reads it.
 *
 * There is no route that decides anything. Approving a command, granting a capability and answering a question
 * each already have a route, and the inbox calls those: a second way to approve would be a second set of checks,
 * and the set that is not exercised is the one that rots. Waiting items cannot be dismissed for the same reason
 * — hiding a question is not answering it.
 *
 * Behind the gateway's bearer check like every route after it, and scoped to the node's owner: the principal is
 * the authenticated identity, never a field in the body.
 */
export interface InboxRouteDeps {
  services: NoticeOperationServices;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
}

export async function handleInboxRoutes(deps: InboxRouteDeps): Promise<GatewayResponse | undefined> {
  const { services, request, segments } = deps;
  if (segments[0] !== "inbox") return undefined;
  // SAFETY: the gateway's clock is `nowInstant` or a test's injected instant; it is typed as a string there only
  // because the other route families take it that way.
  const at = (): Instant => deps.at() as Instant;
  const principalId = services.runtime.identity.ownerPrincipalId;

  if (segments.length === 1) {
    if (request.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "the inbox is read with GET");
    return json(200, readInbox(services, at()));
  }

  if (segments.length === 2 && segments[1] === "summary") {
    if (request.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "the inbox summary is read with GET");
    return json(200, inboxSummary(services, at()));
  }

  if (segments.length === 2 && segments[1] === "read") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "notices are marked read with POST");
    const body = readJson(request);
    if (!body.ok) return body.response;
    const parsed = inboxReadRequestSchema.safeParse(body.value);
    if (!parsed.success) return fail(400, "INVALID_SCHEMA", "noticeIds must be a list of notice ids");
    const marked = markNotificationsRead(services.runtime.db, {
      principalId,
      at: at(),
      ...(parsed.data.noticeIds === undefined ? {} : { notificationIds: parsed.data.noticeIds }),
    });
    return json(200, { marked });
  }

  if (segments.length === 2 && segments[1] === "unread") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "notices are marked unread with POST");
    const body = readJson(request);
    if (!body.ok) return body.response;
    const parsed = inboxUnreadRequestSchema.safeParse(body.value);
    if (!parsed.success) return fail(400, "INVALID_SCHEMA", "noticeIds must be a non-empty list of notice ids");
    return json(200, { marked: markNotificationsUnread(services.runtime.db, { principalId, notificationIds: parsed.data.noticeIds }) });
  }

  if (segments.length === 4 && segments[1] === "notices" && segments[3] === "restore") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a dismissed notice is restored with POST");
    const outcome = restoreNotification(services.runtime.db, { principalId, notificationId: segments[2] ?? "", at: at() });
    switch (outcome) {
      case "restored":
        return json(200, { restored: true });
      case "not-dismissed":
        // Already back, from a second press or another surface: what was asked for is true.
        return json(200, { restored: true });
      case "expired":
        return fail(409, "UNDO_EXPIRED", "that notice was dismissed too long ago to undo");
      case "not-found":
        return fail(404, "RESOURCE_NOT_FOUND", "that notice is not in the inbox");
    }
  }

  if (segments.length === 4 && segments[1] === "notices" && segments[3] === "dismiss") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a notice is dismissed with POST");
    const noticeId = segments[2] ?? "";
    const dismissed = dismissNotification(services.runtime.db, { principalId, notificationId: noticeId, at: at() });
    if (!dismissed) return fail(404, "RESOURCE_NOT_FOUND", "that notice is not in the inbox");
    return json(200, { dismissed: true });
  }

  if (segments.length === 4 && segments[1] === "notices" && segments[3] === "snooze") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a notice is snoozed with POST");
    const body = readJson(request);
    if (!body.ok) return body.response;
    const parsed = inboxSnoozeRequestSchema.safeParse(body.value);
    if (!parsed.success) return fail(400, "INVALID_SCHEMA", "until must be a UTC instant such as 2026-09-29T18:00:00.000Z");
    const now = at();
    const until = snoozeEndWithinRange(parsed.data.until, now);
    if (until === undefined) {
      return fail(400, "SNOOZE_OUT_OF_RANGE", "a notice is snoozed until a time after now and at most 30 days away");
    }
    const snoozed = snoozeNotification(services.runtime.db, { principalId, notificationId: segments[2] ?? "", until, at: now });
    if (!snoozed) return fail(404, "RESOURCE_NOT_FOUND", "that notice is not in the inbox");
    return json(200, { snoozedUntil: until });
  }

  if (segments.length === 4 && segments[1] === "notices" && segments[3] === "unsnooze") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a snoozed notice is brought back with POST");
    const outcome = unsnoozeNotification(services.runtime.db, { principalId, notificationId: segments[2] ?? "", at: at() });
    // Already back, from a second press or because its time came: what was asked for is true.
    if (outcome === "not-found") return fail(404, "RESOURCE_NOT_FOUND", "that notice is not in the inbox");
    return json(200, { unsnoozed: true });
  }

  if (segments.length === 4 && segments[1] === "notices" && segments[3] === "suppress") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a kind of notice is quieted with POST");
    const outcome = suppressNoticeKind(services.runtime.db, {
      principalId,
      notificationId: segments[2] ?? "",
      suppressionId: services.conductor.newId("nsp"),
      at: at(),
    });
    if (outcome === "not-found") return fail(404, "RESOURCE_NOT_FOUND", "that notice is not in the inbox");
    if (outcome === "too-broad") {
      // Refused here, not only left off the menu: without a scope this would also quiet reminders the person asked for
      // and every other automation's or source's notices of the same level.
      return fail(409, "SUPPRESSION_TOO_BROAD", SUPPRESSION_TOO_BROAD_MESSAGE);
    }
    return json(200, outcome);
  }

  if (segments.length === 4 && segments[1] === "notices" && segments[3] === "unsuppress") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a quieted kind of notice is restored with POST");
    const stored = getNotification(services.runtime.db, principalId, segments[2] ?? "");
    if (stored === undefined || stored.dismissed) return fail(404, "RESOURCE_NOT_FOUND", "that notice is not in the inbox");
    // Nothing quieted for this kind any more, from a second press or the list: what was asked for is true.
    unsuppressNoticeKindOf(services.runtime.db, principalId, stored.notice);
    return json(200, { unsuppressed: true });
  }

  if (segments.length === 4 && segments[1] === "notices" && (segments[3] === "skip-version" || segments[3] === "unskip-version")) {
    const skip = segments[3] === "skip-version";
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a version is skipped or unskipped with POST");
    const noticeId = segments[2] ?? "";
    const stored = getNotification(services.runtime.db, principalId, noticeId);
    if (stored === undefined) return fail(404, "RESOURCE_NOT_FOUND", "that notice is not in the inbox");
    // What is skipped is read from the notice this node stored, never from the request: the person skips the version
    // they were told about, and a caller cannot name some other package or version through this route.
    const skipped = skippedVersionOf(stored.notice);
    if (skipped === undefined) return fail(409, "NOT_AN_UPDATE", "only an update notice names a version that can be skipped");
    if (skip) {
      if (stored.dismissed) return fail(404, "RESOURCE_NOT_FOUND", "that notice is not in the inbox");
      skipNoticeVersion(services.runtime.db, { principalId, notice: stored.notice, at: at() });
      return json(200, { skipped: true, ...skipped });
    }
    unskipVersion(services.runtime.db, { principalId, ...skipped });
    // Undo brings the notice back too, while a dismissal can still be undone; an older one stays dismissed.
    const restored = stored.dismissed ? restoreNotification(services.runtime.db, { principalId, notificationId: noticeId, at: at() }) : "not-dismissed";
    return json(200, { skipped: false, restored: restored === "restored" || restored === "not-dismissed" });
  }

  if (segments.length === 5 && segments[1] === "notices" && segments[3] === "actions") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a notice action is taken with POST");
    const body = readJson(request);
    if (!body.ok) return body.response;
    const parsed = noticeOperationRequestSchema.safeParse(body.value);
    if (!parsed.success) return fail(400, "INVALID_SCHEMA", "the body may only carry until, a UTC instant such as 2026-09-29T18:00:00.000Z");
    const noticeId = decodeSegment(segments[2] ?? "");
    if (noticeId === undefined || noticeId === "") {
      return fail(400, "INVALID_SCHEMA", "a notice action is named by the notice id and the action");
    }
    // Taken as sent, never decoded: `isPersonOnlyRoute` matches the raw segment, so `%75pdate` must not become `update`
    // here after the relays let it through. Every action id is lower-case letters and hyphens, so anything else —
    // an escape included — is not one.
    const action = segments[4] ?? "";
    if (!ACTION_SEGMENT.test(action)) {
      return fail(400, "UNKNOWN_ACTION", "a notice action is named in lower-case letters and hyphens, not encoded");
    }
    const outcome = await performNoticeOperation(
      services,
      {
        noticeId,
        action,
        ...(parsed.data.until === undefined ? {} : { until: parsed.data.until }),
        surface: surfaceOf(request, parsed.data.source),
      },
      at,
    );
    if (!outcome.ok) return fail(outcome.status, outcome.code, outcome.message, outcome.reason === undefined ? undefined : { reason: outcome.reason });
    // 202 rather than 200 when an install waits for the person's approval: nothing failed, and nothing is installed yet.
    return json(outcome.response.outcome === "approval-required" ? 202 : 200, outcome.response);
  }

  if (segments.length === 5 && segments[1] === "skipped-versions") {
    if (request.method !== "DELETE") return fail(405, "METHOD_NOT_ALLOWED", "a skipped version is taken back with DELETE");
    const [kind, name, version] = segments.slice(2).map(decodeSegment);
    if ((kind !== "package" && kind !== "pi") || name === undefined || name === "" || version === undefined || version === "") {
      return fail(400, "INVALID_SCHEMA", "a skipped version is named by package or pi, then its name and version");
    }
    // Only this principal's own skips: the key is completed with the authenticated identity, never read from the path.
    const removed = unskipVersion(services.runtime.db, { principalId, subjectKind: kind, name, version });
    if (!removed) return fail(404, "RESOURCE_NOT_FOUND", "that version is not skipped");
    return json(200, { removed: true });
  }

  if (segments.length === 3 && segments[1] === "suppressions") {
    if (request.method !== "DELETE") return fail(405, "METHOD_NOT_ALLOWED", "a quieted kind of notice is removed with DELETE");
    const removed = removeNoticeSuppression(services.runtime.db, { principalId, suppressionId: segments[2] ?? "" });
    if (!removed) return fail(404, "RESOURCE_NOT_FOUND", "nothing is quieted under that id");
    return json(200, { removed: true });
  }

  return fail(404, "NOT_FOUND", `no inbox handler for ${request.method} ${request.path}`);
}

/** What a notice action's name looks like on the path: `NOTICE_OPERATION_IDS` and the other action ids all fit. */
const ACTION_SEGMENT = /^[a-z][a-z-]{0,39}$/;

/**
 * Which surface a call came through, for the audit: the relay or MCP when the node's own surface said so, the page's
 * label when it gave one, `api` otherwise. A machine surface's own marker wins over any label in the body.
 */
function surfaceOf(request: GatewayRequest, source: NoticeOperationSource | undefined): NoticeOperationSurface {
  const marker = request.headers[SURFACE_HEADER];
  if (marker === "mcp" || marker === "relay") return marker;
  return source ?? "api";
}

/** A path segment as the client encoded it (a package id may hold `@` and `/`), or nothing when it is not valid. */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
