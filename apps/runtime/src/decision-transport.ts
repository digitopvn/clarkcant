/**
 * The HTTP sink every decision provider is called through.
 *
 * Provider-neutral on purpose: both providers this node speaks to take one JSON POST with a bearer credential, so the
 * policy that matters here - which URLs may be called at all, and what happens to an error body - is written once and
 * cannot differ between them. What a provider's URL is, and how its answer is read, belongs to its adapter.
 */

/**
 * Whether an endpoint is one this node is willing to call.
 *
 * The endpoint is operator configuration, not user input, so this is not the primary control
 * against a hostile URL — it is the control against an environment variable that points somewhere
 * it should not. `https` only, no embedded credentials, and no loopback or private-range host,
 * which is what keeps a misconfigured `CLARKCANT_JEV_ENDPOINT` from turning the node into a proxy
 * for whatever else is listening on its own network.
 */
export function validateProviderEndpoint(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "the configured endpoint is not a valid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "the configured endpoint must use https" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "the configured endpoint must not embed credentials in its URL" };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isPrivateHost(host)
  ) {
    return { ok: false, reason: "the configured endpoint must not point at a loopback or private address" };
  }
  return { ok: true, url: parsed.toString() };
}

function isPrivateHost(host: string): boolean {
  if (host === "[::1]" || host === "::1") return true;
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

export interface DecisionTransportRequest {
  url: string;
  apiKey: string;
  body: unknown;
  signal: AbortSignal;
}

export interface DecisionTransportResponse {
  status: number;
  body: unknown;
}

export type DecisionTransport = (request: DecisionTransportRequest) => Promise<DecisionTransportResponse>;

/**
 * Thrown when a URL is refused at the sink.
 *
 * A distinct type rather than a message match, so the caller can report the refusal itself instead of the generic
 * "the call failed" that a network error produces.
 */
export class EndpointRefusedError extends Error {}

/**
 * The one URL this transport will call, or a refusal.
 *
 * A function rather than a variable so the refusal cannot be skipped: the value handed to `fetch` is only ever one
 * that passed the policy, which is an allowlist and not a sanitizer - https only, no credentials in the URL, and no
 * loopback or private address. The configuration path refuses the same things, and this is the second half of that
 * check rather than a replacement for it.
 */
function allowlistedEndpoint(url: string): string {
  const allowed = validateProviderEndpoint(url);
  if (!allowed.ok) throw new EndpointRefusedError(allowed.reason);
  return allowed.url;
}

/** The only protocols this transport will call. Written as data so the policy is reviewable, not inferred. */
const CALLABLE_PROTOCOLS = Object.freeze(["https:"]);

/**
 * The endpoint as a URL this transport will call, or a refusal.
 *
 * A malformed URL is refused rather than thrown at the caller as a parse error: it is the same class of problem as
 * a wrong scheme, and both mean this node will not open a socket.
 */
function callableTarget(url: string): URL {
  let target: URL;
  try {
    target = new URL(allowlistedEndpoint(url));
  } catch {
    throw new EndpointRefusedError("the configured endpoint is not a URL this transport can call");
  }
  if (!CALLABLE_PROTOCOLS.includes(target.protocol)) {
    throw new EndpointRefusedError(`scheme ${target.protocol} is not allowed; only ${CALLABLE_PROTOCOLS.join(", ")} is called`);
  }
  return target;
}

/**
 * The largest decision response this node reads. A real answer is a few kilobytes; anything near this is not one, and
 * reading it in full would let a provider hold memory the decision never needed.
 */
export const MAX_DECISION_RESPONSE_BYTES = 256 * 1024;

/**
 * Reads a response body as text, or gives `undefined` once it is larger than `limit` bytes.
 *
 * The declared length is checked first so an honest oversized answer is refused without reading it; the stream is
 * still counted, because a length header is the provider's claim and need not be present or true.
 */
async function readCappedText(response: Response, limit: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
}

/**
 * The real transport.
 *
 * The error path is where this differs from a naive fetch: a non-JSON error body is returned as
 * `{status, body: undefined}` rather than being parsed and logged, because the interesting thing
 * about a 529 is the status and the interesting thing about an error body is that it sometimes
 * echoes the request.
 */
export function createFetchTransport(): DecisionTransport {
  return async (request) => {
    // A plain local name, assigned only from the allowlist above, so the call below cannot reach anything else.
    const allowlistedUrl = callableTarget(request.url).href;
    const response = await fetch(allowlistedUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(request.body),
      signal: request.signal,
      // A redirect would carry the bearer token to a host the allowlist never checked, so one is a failure.
      redirect: "error",
    });

    if (!response.ok) {
      // The body is discarded unread on purpose: it is never returned, logged or stored.
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, body: undefined };
    }

    // An oversized answer reads as no answer, which the caller treats as malformed and falls back from.
    const text = await readCappedText(response, MAX_DECISION_RESPONSE_BYTES);
    if (text === undefined) return { status: response.status, body: undefined };
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: undefined };
    }
  };
}
