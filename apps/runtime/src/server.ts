import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { handleRequest, type GatewayResponse } from "./gateway.ts";
import type { NodeServices } from "./services.ts";

/**
 * The node's HTTP transport.
 *
 * Lifted out of `main.ts` so it can be started by a test. The body ceiling below lives in the
 * request listener rather than in `handleRequest`, and a limit that no test can reach is a limit
 * that quietly stops working: the previous arrangement collected chunks in the entry point, where
 * only a hand-run node could exercise it.
 *
 * What stays here is everything the handler cannot see: how a body is read, which headers the
 * transport owns, and the difference between a JSON answer, a streamed one and raw bytes.
 */

/**
 * How much of an upload the node is willing to hold in memory.
 *
 * 35 MiB for a 25 MiB file, which is the size base64 inflates it to. Scoped to `/attachments`
 * deliberately: a global ceiling would change the behaviour of every other route in a change about
 * attachments, and the routes that exist today have never been given a number.
 */
export const ATTACHMENT_UPLOAD_BODY_LIMIT = 36_700_160;

/** The one path with a body ceiling, and the ceiling. Everything else is read as it always was. */
export function bodyLimitForPath(path: string): number | undefined {
  return path === "/attachments" ? ATTACHMENT_UPLOAD_BODY_LIMIT : undefined;
}

/**
 * Headers the transport decides.
 *
 * A handler may add headers — the attachment route needs `nosniff` and a disposition — but it may
 * not take over the ones that describe the body it is being handed. Content type especially: a
 * route that could set its own would be able to serve bytes under a type the host never verified,
 * which is the property the image and attachment paths both depend on.
 */
export const HOST_OWNED_HEADERS: readonly string[] = [
  "content-type",
  "content-length",
  "cache-control",
  "access-control-allow-origin",
  "access-control-allow-headers",
  "access-control-allow-methods",
];

export interface NodeServerOptions {
  services: NodeServices;
  /** Used only to build an absolute URL for the request line, so query parsing works. */
  origin: string;
  /** Where a refused extra header is reported. Defaults to stderr. */
  onWarning?: (line: string) => void;
  /**
   * The ceiling for a path.
   *
   * A seam rather than a constant, for two reasons: a node may need a different ceiling than the
   * built-in one, and a chain that can only be exercised by sending 35 MiB is a chain nobody tests.
   * The default is the deployed policy.
   */
  bodyLimitFor?: (path: string) => number | undefined;
}

export function createNodeServer(options: NodeServerOptions): Server {
  const warn = options.onWarning ?? ((line: string) => process.stderr.write(`${line}\n`));

  return createServer((request, response) => {
    handleOne({ ...options, bodyLimitFor: options.bodyLimitFor ?? bodyLimitForPath }, request, response, warn);
  });
}

function handleOne(
  options: NodeServerOptions & { bodyLimitFor: (path: string) => number | undefined },
  request: IncomingMessage,
  response: ServerResponse,
  warn: (line: string) => void,
): void {
  const url = new URL(request.url ?? "/", options.origin);
  const limit = options.bodyLimitFor(url.pathname);
  const chunks: Buffer[] = [];
  let received = 0;
  let overLimit = false;

  request.on("data", (chunk: Buffer) => {
    received += chunk.byteLength;
    if (limit !== undefined && received > limit) {
      /*
       * Stop holding bytes, and stop remembering the ones already held.
       *
       * The request is not destroyed: destroying it races the response, and the caller then sees a
       * broken connection instead of the reason. Memory is what the ceiling protects — the node
       * never holds more than the limit — and the wire cost of an oversized upload is the sender's.
       */
      overLimit = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });

  request.on("end", () => {
    void (async () => {
      if (overLimit) {
        writeJson(response, 413, {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: `a request to ${url.pathname} may carry at most ${limit ?? 0} bytes`,
          },
        });
        return;
      }

      // The handler is guarded. A request that cannot be satisfied is the request's problem, and
      // answering it with a 500 is the whole job of this boundary — letting it reach the process
      // means one bad message takes the node down and every other conversation with it.
      let result: GatewayResponse;
      try {
        result = await handleRequest(
          { services: options.services },
          {
            method: request.method ?? "GET",
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            headers: request.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          },
        );
      } catch (cause) {
        // Reported rather than swallowed, because a caller that cannot see why a request failed
        // will retry it unchanged.
        warn(
          `request ${request.method ?? "GET"} ${url.pathname} failed: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`,
        );
        result = {
          status: 500,
          body: {
            error: {
              code: "INTERNAL_ERROR",
              message: cause instanceof Error ? cause.message : String(cause),
            },
          },
        };
      }

      writeResult(response, result, warn);
    })();
  });
}

/** The three shapes a handler may answer with, and the headers each one owns. */
function writeResult(response: ServerResponse, result: GatewayResponse, warn: (line: string) => void): void {
  const headers = baseHeaders();

  // A body that is written over time: the status line and headers go out now, and the handler sends
  // the rest as it produces it. The turn keeps running even if the client leaves, because the answer
  // is stored either way — stopping it would discard work the user paid for because they closed a tab.
  if (result.stream !== undefined) {
    headers["content-type"] = result.stream.contentType;
    // `no-transform` as well as `no-cache`: the point of this response is its timing, so an
    // intermediary that may buffer and re-chunk it is being told not to.
    headers["cache-control"] = "no-cache, no-transform";
    response.writeHead(result.status, headers);
    response.flushHeaders();

    // `writableFinished` is what distinguishes a finished response from a client that hung up: the
    // 'close' event fires for both, and only the second one means there is nobody to write to.
    let clientGone = false;
    response.on("close", () => {
      if (!response.writableFinished) clientGone = true;
    });
    // A write to a socket the peer has dropped reports itself here rather than throwing, and an
    // unhandled 'error' on a response stream takes the process with it.
    response.on("error", () => {
      clientGone = true;
    });

    // A comment frame every fifteen seconds. A stream waiting on a model looks like an idle
    // connection to anything between here and the browser, and an idle connection is what gets
    // closed; a comment is valid SSE that the parser ignores.
    const keepAlive = setInterval(() => {
      if (!clientGone) response.write(": keep-alive\n\n");
    }, 15_000);
    keepAlive.unref();

    void (async () => {
      try {
        await result.stream?.run((chunk) => {
          if (!clientGone) response.write(chunk);
        });
      } finally {
        clearInterval(keepAlive);
        response.end();
      }
    })();
    return;
  }

  // Stored bytes are served as themselves under the type the host verified from the file's magic
  // bytes, rather than wrapped in a JSON envelope the client would have to decode and re-type.
  if (result.binary !== undefined) {
    headers["content-type"] = result.binary.contentType;
    headers["content-length"] = String(result.binary.bytes.byteLength);
    // Private by default: these bytes are authorized by a token, and a shared cache in front of a node must not
    // hand one principal's file to another. A route that says `no-store` gets it, because the transport owns this
    // key and a route cannot set it itself.
    headers["cache-control"] = result.binary.cache === "no-store" ? "no-store" : "private, max-age=300";
    for (const [key, value] of Object.entries(result.binary.headers ?? {})) {
      const name = key.toLowerCase();
      if (HOST_OWNED_HEADERS.includes(name)) {
        warn(`refused handler-supplied header ${name}: the transport owns it`);
        continue;
      }
      headers[name] = value;
    }
    response.writeHead(result.status, headers);
    response.end(Buffer.from(result.binary.bytes));
    return;
  }

  headers["content-type"] = "application/json";
  response.writeHead(result.status, headers);
  response.end(`${JSON.stringify(result.body)}\n`);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { ...baseHeaders(), "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

function baseHeaders(): Record<string, string> {
  return {
    // The browser client is served from a different origin during development, and the gateway is
    // token-authenticated rather than cookie-authenticated, so a wildcard origin here grants nothing
    // a caller does not already need the token for.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    /*
     * Every method the gateway routes.
     *
     * `PUT` was missing, and that made the whole preferences surface unusable from a browser: a PUT with a
     * JSON body is not a simple request, so the preflight asked whether PUT was allowed, was told it was
     * not, and the write never happened. Every settings control — theme's siblings, execution policy, the
     * orb profile, personal instructions — returned "Failed to fetch" while the node-side tests passed,
     * because those call the handler directly and never cross an origin.
     *
     * Kept as one list in one place: a route added without its method being allowed here fails only in a
     * browser, which is the hardest place to notice it.
     */
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  };
}
