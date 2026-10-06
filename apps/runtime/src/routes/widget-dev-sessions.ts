import { z } from "zod";

import { widgetDevSessionCreateSchema } from "@clarkcant/contracts";

import type { WidgetDevResult, WidgetDevSessions } from "../application/widget-dev-sessions.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * Live widget authoring sessions (`application/widget-dev-sessions.ts`), over HTTP.
 *
 *   POST   /widget-dev/sessions              start watching a package folder on this node (`{ root, conversationId?, widgetId? }`);
 *                                            answers once the first build has run and been activated as far as the policy allows
 *   GET    /widget-dev/sessions              every session on this node
 *   GET    /widget-dev/sessions/:id          one session: its newest build, what runs, and whether that is the last good build
 *   DELETE /widget-dev/sessions/:id          stop watching; what runs keeps running where it was placed
 *   POST   /widget-dev/sessions/:id/rebuild  build the folder now
 *   POST   /widget-dev/sessions/:id/place    place the running widget in a conversation (`{ conversationId, widgetId? }`)
 *
 * Starting, rebuilding and placing install the folder's package, so a machine surface cannot call them
 * (`isPersonOnlyRoute`); it asks Clark, whose `develop_widget` the execution policy decides. Reading and stopping are
 * reachable everywhere.
 */
export interface WidgetDevRouteDeps {
  services: { widgetDev?: WidgetDevSessions | undefined };
  request: GatewayRequest;
  segments: string[];
}

const placeSchema = z.strictObject({
  conversationId: z.string().min(1).max(200),
  widgetId: z.string().min(1).max(160).optional(),
});

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

function answer<T>(result: WidgetDevResult<T>, status = 200): GatewayResponse {
  return result.ok ? json(status, result.value) : fail(result.status, result.code, result.message);
}

export async function handleWidgetDevRoutes(deps: WidgetDevRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments } = deps;
  if (segments[0] !== "widget-dev" || segments[1] !== "sessions") return undefined;
  const sessions = deps.services.widgetDev;
  if (sessions === undefined) return fail(503, "WIDGET_DEV_UNAVAILABLE", "this node is not running widget dev sessions");
  const method = request.method.toUpperCase();
  const sessionId = segments[2];
  if (sessionId !== undefined && !SESSION_ID.test(sessionId)) return fail(404, "SESSION_NOT_FOUND", "there is no such widget dev session on this node");

  if (segments.length === 2) {
    if (method === "GET") return json(200, { sessions: await sessions.list() });
    if (method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "use GET or POST");
    const body = readJson(request);
    if (!body.ok) return body.response;
    const parsed = widgetDevSessionCreateSchema.safeParse(body.value);
    if (!parsed.success) return fail(400, "INVALID_SCHEMA", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
    return answer(
      await sessions.start({
        root: parsed.data.root,
        ...(parsed.data.conversationId === undefined ? {} : { conversationId: parsed.data.conversationId }),
        ...(parsed.data.widgetId === undefined ? {} : { widgetId: parsed.data.widgetId }),
      }),
      201,
    );
  }

  if (sessionId === undefined) return undefined;
  if (segments.length === 3) {
    if (method === "GET") {
      const view = await sessions.get(sessionId);
      return view === undefined ? fail(404, "SESSION_NOT_FOUND", "there is no such widget dev session on this node") : json(200, view);
    }
    if (method === "DELETE") return answer(await sessions.stop(sessionId));
    return fail(405, "METHOD_NOT_ALLOWED", "use GET or DELETE");
  }

  if (segments.length === 4 && segments[3] === "rebuild") {
    if (method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "use POST");
    return answer(await sessions.rebuild(sessionId));
  }

  if (segments.length === 4 && segments[3] === "place") {
    if (method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "use POST");
    const body = readJson(request);
    if (!body.ok) return body.response;
    const parsed = placeSchema.safeParse(body.value);
    if (!parsed.success) return fail(400, "INVALID_SCHEMA", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
    const placed = await sessions.place(sessionId, {
      conversationId: parsed.data.conversationId,
      ...(parsed.data.widgetId === undefined ? {} : { widgetId: parsed.data.widgetId }),
    });
    return placed.ok ? json(200, { session: placed.value.session, text: placed.value.text }) : fail(placed.status, placed.code, placed.message);
  }

  return fail(404, "RESOURCE_NOT_FOUND", "no such widget dev route");
}
