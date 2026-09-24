import { type Instant, inboxReadRequestSchema } from "@clarkcant/contracts";
import { dismissNotification, markNotificationsRead } from "@clarkcant/storage";

import { type InboxServices, inboxSummary, readInbox } from "../inbox.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The inbox family.
 *
 *   GET  /inbox                              waiting items + notices, as a snapshot with the time it was read
 *   GET  /inbox/summary                      the two counts the header mark polls
 *   POST /inbox/read        { noticeIds? }   mark notices read (no ids: all of them)
 *   POST /inbox/notices/:id/dismiss          take one notice out of the list
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
  services: InboxServices;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
}

export function handleInboxRoutes(deps: InboxRouteDeps): GatewayResponse | undefined {
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

  if (segments.length === 4 && segments[1] === "notices" && segments[3] === "dismiss") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a notice is dismissed with POST");
    const noticeId = segments[2] ?? "";
    const dismissed = dismissNotification(services.runtime.db, { principalId, notificationId: noticeId, at: at() });
    if (!dismissed) return fail(404, "RESOURCE_NOT_FOUND", "that notice is not in the inbox");
    return json(200, { dismissed: true });
  }

  return fail(404, "NOT_FOUND", `no inbox handler for ${request.method} ${request.path}`);
}
