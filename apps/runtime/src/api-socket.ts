import type { Server } from "node:http";

import { type RawData, WebSocketServer, type WebSocket } from "ws";

import { isPersonOnlyRoute, PERSON_ONLY_REFUSAL, parseSseChunk } from "@clarkcant/contracts";

import { handleRequest, type GatewayRequest } from "./gateway.ts";
import { API_SOCKET_PATH, API_SOCKET_PROTOCOL } from "./open-interfaces.ts";
import { tokenMatches } from "./routes/http.ts";
import type { NodeServices } from "./services.ts";

/**
 * The gateway over one WebSocket, for a client that wants a single long-lived connection.
 *
 * Nothing here is a second API. A `request` frame is the same method, path and body an HTTP caller would send, and it
 * is answered by the same gateway handler under the same token, so every route — and every refusal — is identical on
 * both transports. What the socket adds is only what HTTP cannot do on one connection: several requests in flight at
 * once, each identified by the caller's `id`, and a streamed answer delivered as frames instead of an SSE body.
 *
 * A browser cannot set an `Authorization` header on a WebSocket, so, as on the voice and terminal sockets, the first
 * frame is `{ type: "auth", token }` and nothing else is read until it verifies.
 *
 * Client → node: `auth { token }`, `request { id, method, path, query?, body? }`, `ping`.
 * Node → client: `ready { protocol }`, `event { id, event, data }`, `response { id, status, body }`, `pong`,
 * `error { id?, code, message }`.
 */

const MAX_FRAME_BYTES = 256 * 1024;
/** How long an opened socket has to authenticate before it is closed. */
const AUTH_TIMEOUT_MS = 10_000;
/** Requests one socket may have running at once; a caller past this is told so rather than queued without bound. */
const MAX_IN_FLIGHT = 16;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface ApiSocket {
  close(): Promise<void>;
}

export function attachApiSocket(options: { server: Server; services: NodeServices; path?: string }): ApiSocket {
  const path = options.path ?? API_SOCKET_PATH;
  const localToken = options.services.runtime.identity.localToken;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  options.server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== path) return;
    wss.handleUpgrade(request, socket, head, (ws) => serve(ws));
  });

  function serve(ws: WebSocket): void {
    let token: string | undefined;
    let inFlight = 0;
    const authTimer = setTimeout(() => ws.close(4401, "unauthenticated"), AUTH_TIMEOUT_MS);
    authTimer.unref();

    const send = (frame: Record<string, unknown>): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    const error = (code: string, message: string, id?: string | number): void =>
      send({ type: "error", ...(id === undefined ? {} : { id }), code, message });

    ws.on("message", (data: RawData) => {
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        frame = parsed as Record<string, unknown>;
      } catch {
        if (token === undefined) {
          // Nothing but a valid auth frame is read before the socket verifies, so junk ends it like a wrong token.
          error("UNAUTHENTICATED", "the first frame must be auth with a valid token");
          ws.close(4401, "unauthenticated");
          return;
        }
        error("INVALID_FRAME", "every frame must be a JSON object");
        return;
      }

      if (token === undefined) {
        const presented = frame.type === "auth" ? frame.token : undefined;
        if (typeof presented !== "string" || !tokenMatches(localToken, presented)) {
          // Identical for a missing and a wrong token, as the HTTP gate is.
          error("UNAUTHENTICATED", "the first frame must be auth with a valid token");
          ws.close(4401, "unauthenticated");
          return;
        }
        token = presented;
        clearTimeout(authTimer);
        send({ type: "ready", protocol: API_SOCKET_PROTOCOL });
        return;
      }

      if (frame.type === "ping") {
        send({ type: "pong" });
        return;
      }
      if (frame.type !== "request") {
        error("UNKNOWN_FRAME", `unknown frame type: ${String(frame.type)}`);
        return;
      }

      // Echoed exactly as sent, so a client matching `response.id === 7` finds its answer.
      const id = typeof frame.id === "string" || typeof frame.id === "number" ? frame.id : undefined;
      if (id === undefined) {
        error("INVALID_FRAME", "a request needs an id to answer it by");
        return;
      }
      const method = typeof frame.method === "string" ? frame.method.toUpperCase() : "";
      const requestPath = typeof frame.path === "string" ? frame.path : "";
      if (!METHODS.has(method) || !requestPath.startsWith("/")) {
        error("INVALID_FRAME", "a request needs a method (GET, POST, PUT, PATCH, DELETE) and a path starting with /", id);
        return;
      }
      if (isPersonOnlyRoute(method, requestPath)) {
        // Answered as the route's refusal rather than an error frame: the request was well formed, it is just not
        // one this surface carries.
        send({ type: "response", id, status: 403, body: PERSON_ONLY_REFUSAL });
        return;
      }
      if (inFlight >= MAX_IN_FLIGHT) {
        error("TOO_MANY_REQUESTS", `at most ${String(MAX_IN_FLIGHT)} requests may run at once on one socket`, id);
        return;
      }

      const query: Record<string, string> = {};
      if (typeof frame.query === "object" && frame.query !== null) {
        for (const [key, value] of Object.entries(frame.query)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") query[key] = String(value);
        }
      }
      const request: GatewayRequest = {
        method,
        path: requestPath,
        query,
        // The token this socket proved, so the gateway makes the same decision it makes for HTTP.
        headers: { authorization: `Bearer ${token}` },
        body: frame.body === undefined ? "" : typeof frame.body === "string" ? frame.body : JSON.stringify(frame.body),
      };

      inFlight += 1;
      void run(request, id, send).finally(() => {
        inFlight -= 1;
      });
    });

    ws.on("close", () => clearTimeout(authTimer));
    ws.on("error", () => clearTimeout(authTimer));
  }

  async function run(request: GatewayRequest, id: string | number, send: (frame: Record<string, unknown>) => void): Promise<void> {
    try {
      const result = await handleRequest({ services: options.services }, request);
      if (result.binary !== undefined) {
        send({
          type: "response",
          id,
          status: 415,
          body: { code: "USE_HTTP", message: "this route answers with bytes; fetch it over HTTP instead" },
        });
        return;
      }
      if (result.stream !== undefined) {
        // The route writes SSE text; each event becomes its own frame, in the order it was written.
        const parser = sseParser((event, data) => send({ type: "event", id, event, data }));
        await result.stream.run(parser);
        send({ type: "response", id, status: result.status, body: null });
        return;
      }
      send({ type: "response", id, status: result.status, body: result.body });
    } catch (cause) {
      send({
        type: "response",
        id,
        status: 500,
        body: { code: "INTERNAL_ERROR", message: cause instanceof Error ? cause.message : String(cause) },
      });
    }
  }

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

/**
 * Split an SSE body into events as it is written.
 *
 * Buffered through the shared parser, because nothing promises one write is one event, and the keep-alive comment
 * carries no data. `data` is parsed as JSON when it is JSON, which is every event the gateway writes.
 */
export function sseParser(onEvent: (event: string, data: unknown) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    const parsed = parseSseChunk(buffer + chunk);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      let value: unknown = event.data;
      try {
        value = JSON.parse(event.data);
      } catch {
        // Not JSON: passed on as the text it is.
      }
      onEvent(event.event, value);
    }
  };
}
