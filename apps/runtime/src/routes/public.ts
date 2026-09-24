import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { protocolRangeSchema } from "@clarkcant/contracts";

import { DISCOVERY_PATH, OPENAPI_PATH, discoveryDocument, openApiDocument } from "../open-interfaces.ts";
import { type GatewayRequest, type GatewayResponse, fail, json } from "./http.ts";

/**
 * The routes that answer before the token check.
 *
 * There are four, and each one is unauthenticated for a reason the route states where it is written:
 * the CORS preflight (a browser sends it without credentials by definition), the readiness probe (an
 * open probe must not become a way to enumerate nodes), and the node's own web build (public code a
 * browser fetches to load the app, and a sandboxed frame cannot present a token anyway), and the descriptions of the
 * node's open interfaces (they describe routes, not this node, and a client reads them before it holds a token).
 *
 * `undefined` means "not one of mine", which is how the dispatch keeps the order these branches had
 * when they lived in the gateway.
 */
export interface PublicRouteDeps {
  services: {
    /** Runtime description surfaced by the health route. Contains no node identity. */
    describe: () => { node: string; platform: string; arch: string };
  };
  request: GatewayRequest;
  at: () => string;
}

/**
 * The pre-auth family. `undefined` means the request is not one of these routes.
 */
export function handlePublicRoutes(deps: PublicRouteDeps): GatewayResponse | undefined {
  const { request } = deps;

  /*
   * CORS preflight, answered before the token check.
   *
   * A browser sends `OPTIONS` without credentials before any request that carries an
   * `Authorization` header, so requiring a token here would make every cross-origin request
   * fail at the preflight and look like a network error in the client. The preflight grants
   * nothing: the actual request still has to present the token.
   */
  if (request.method === "OPTIONS") {
    return { status: 204, body: null };
  }

  // The only unauthenticated route, and it deliberately discloses no node identity: an
  // open readiness probe must not become a way to enumerate nodes.
  if (request.method === "GET" && request.path === "/health") {
    return json(200, {
      status: "ok",
      runtime: deps.services.describe(),
      negotiatedProtocol: protocolRangeSchema.parse({ name: "agent.nodelink", min: 1, max: 2 }),
      checkedAt: deps.at(),
    });
  }

  /*
   * How a third-party app or AI tool finds its way in: the discovery document and the OpenAPI description.
   *
   * Static documents about routes, with no node identity in them, so answering them without a token tells a caller
   * nothing a published README would not.
   */
  if (request.method === "GET" && request.path === DISCOVERY_PATH) {
    return json(200, discoveryDocument());
  }
  if (request.method === "GET" && request.path === OPENAPI_PATH) {
    return json(200, openApiDocument());
  }

  /*
   * The node's own web build: the widget runtime bundle and the chunks it imports.
   *
   * The bundle re-exports from a shared chunk — the app and the runtime use the same SDK — and a frame that could load
   * one but not the other would fail at the import. Both come from here so the frame's scripts are same-origin.
   *
   * Unauthenticated on purpose, and it is the one route where that is honest: this is the app's own build output, the
   * same public code any browser fetches to load the app, and a sandboxed frame cannot present a token anyway. The path
   * is resolved and checked to be inside the build, so it is not a way to read anything else.
   */
  if (request.method === "GET" && (request.path === "/widget-runtime.js" || request.path.startsWith("/assets/"))) {
    const dist = process.env["CC_WEB_DIST"];
    if (dist === undefined || dist === "") {
      return fail(503, "NO_WEB_BUILD", "this node was not told where its web build is, so it cannot serve a widget runtime");
    }
    const relative = request.path === "/widget-runtime.js" ? "widget-runtime.js" : request.path.slice(1);
    const root = resolve(dist);
    const candidate = resolve(join(root, relative));
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      return fail(403, "FILE_OUTSIDE_PACKAGE", "that path is outside the node's web build");
    }
    try {
      const bytes = readFileSync(candidate);
      const type = request.path.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : request.path.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
      return { status: 200, body: null, binary: { bytes, contentType: type, cache: "no-store" } };
    } catch {
      return fail(404, "FILE_NOT_FOUND", "this node's web build has no such file");
    }
  }

  return undefined;
}
