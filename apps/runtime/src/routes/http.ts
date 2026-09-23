import { timingSafeEqual } from "node:crypto";

/**
 * The HTTP primitives every route module shares.
 *
 * These live outside `gateway.ts` because a route module is a plain function over a request: it needs
 * the request and response shapes, one way to parse a JSON body and one way to write a refusal. None of
 * it is state, so moving it here removes a copy per family rather than a decision from the gateway.
 *
 * `tokenMatches` is exported for the same reason it was exported from the gateway: the voice socket has
 * to make the identical decision, and a second comparison written beside this one is a second
 * comparison that can drift.
 */

export interface GatewayRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface GatewayResponse {
  status: number;
  body: unknown;
  /**
   * A body written over time rather than returned at once.
   *
   * A conversation turn takes as long as the model takes, and the whole point of streaming it is that
   * the text is readable while that happens. The alternative — a promise that resolves with the whole
   * reply — cannot express "here is part of it", so the shape has to allow the transport to write
   * before the handler returns. Validation still happens in the handler, so a malformed request or a
   * missing conversation is still an ordinary JSON refusal with a status code; only the events are
   * streamed, because by the time they exist the status has been sent.
   */
  stream?: {
    contentType: string;
    run: (send: (chunk: string) => void) => Promise<void>;
  };
  /**
   * Bytes to send verbatim instead of a JSON body.
   *
   * Only imported images and stored attachments use this. Answering an image request with a base64
   * JSON envelope would mean the browser holds a copy of the file in memory as text and the content
   * type is whatever the caller decides, which is the opposite of serving an approved artifact under
   * the type the host verified.
   *
   * `headers` are additional headers a route needs and the transport does not own — a disposition for
   * an attachment, `nosniff` for anything served back to a browser. The transport refuses a key it
   * owns, so a route cannot serve bytes under a content type the host never verified.
   *
   * `cache` is how a route asks for the one host-owned header it has an opinion about. It is a field
   * rather than a header because the transport owns `cache-control`, and a route that set it directly
   * had its value refused and silently replaced — which is how a frame meant never to be cached came
   * back with a five-minute lifetime.
   */
  binary?: {
    bytes: Uint8Array;
    contentType: string;
    /** `private` is the default: these bytes are authorized by a token and a shared cache must not reuse them. */
    cache?: "private" | "no-store";
    headers?: Record<string, string>;
  };
}

/**
 * Constant-time comparison, so the gate does not leak a token's length or prefix.
 *
 * Exported because the voice socket has to make the identical decision, and a second comparison
 * written beside this one is a second comparison that can drift: the failure mode of two
 * well-meant token checks is that one of them quietly stops being constant-time.
 */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearer(headers: GatewayRequest["headers"]): string | undefined {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const [scheme, token] = value.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || token === undefined) return undefined;
  return token;
}

export function json(status: number, body: unknown): GatewayResponse {
  return { status, body };
}

export function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): GatewayResponse {
  return json(status, { code, message, ...(extra ?? {}) });
}

/** Parse a JSON body, reporting a malformed one rather than throwing. */
export function readJson(request: GatewayRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: GatewayResponse } {
  if (request.body.trim() === "") return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(request.body) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, response: fail(400, "INVALID_SCHEMA", "the request body must be a JSON object") };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: fail(400, "INVALID_SCHEMA", "the request body is not valid JSON") };
  }
}

