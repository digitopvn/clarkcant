import {
  EGRESS_ERROR_CODES,
  type EgressFetchResult,
  egressFetchRequestSchema,
  egressHeaderProblem,
  SERVICE_EGRESS_CAPABILITY,
  SERVICE_EGRESS_LIMITS,
  SERVICE_EGRESS_METHOD,
  SERVICE_EGRESS_VERSION,
  type ServiceEgress,
} from "@clarkcant/contracts";
import { McpServerRequestError, JSON_RPC_METHOD_NOT_FOUND } from "@clarkcant/mcp-adapters";
import { type Database, getSecretMetadata, secretBackendFor } from "@clarkcant/storage";

import type { SecretBroker } from "./secret-broker.ts";

/**
 * Egress for package services: the host makes a service's HTTP requests, so the service never holds a secret.
 *
 * A service container has no network. When its package declares `egress` on the tools facet, the host answers the
 * request `clarkcant/egress.fetch` the service sends over its stdio connection, and makes the HTTP request itself:
 *
 *   - only to an origin the package declared, compared exactly; a URL with credentials in it is refused;
 *   - only while a host call to that service is in flight, so a service cannot reach anything on its own schedule,
 *     and its requests stop when the last call ends, when the call is cancelled, or when the service is stopped;
 *   - with the declared credential header added by the host from the secret broker, for the consumer
 *     `package:<id>`, which the secret must name explicitly; a header the service sets with that name is dropped;
 *   - with framing, cookie, proxy and forwarding headers stripped, and bounded request and response bodies;
 *   - without following redirects: a redirect comes back as it is, so a credential never travels to another origin;
 *   - with the secret removed from every header and from the body of what comes back, so a provider that echoes the
 *     key does not hand it to the service.
 *
 * Every request is written to the trail by package, method, origin and secret name. Never a path, a body, a value or
 * a length.
 */

/** The consumer a package's secret must list for the host to use it on the package's behalf. */
export function packageConsumer(packageId: string): string {
  return `package:${packageId}`;
}

/**
 * Why a declared secret cannot be used for a package right now, or `undefined` when it can.
 *
 * Read from the metadata and the backend's own `has`, so checking readiness never reads a value. An empty consumer
 * list does not count: a package's secret is one the person stored for that package.
 */
export function egressSecretProblem(
  deps: { db: Database; principalId: string },
  packageId: string,
  name: string,
): string | undefined {
  const metadata = getSecretMetadata(deps.db, deps.principalId, name);
  if (metadata === undefined) return `the secret ${name} has not been provided on this node`;
  if (!metadata.allowedConsumers.includes(packageConsumer(packageId))) {
    return `the secret ${name} is not stored for this package`;
  }
  if (metadata.injectionPolicy !== "http-header" && metadata.injectionPolicy !== "agent-context") {
    return `the secret ${name} is not allowed to be sent as a request header`;
  }
  const backend = secretBackendFor(deps.db, deps.principalId, metadata.backend);
  if (backend === undefined || !backend.has(metadata.backendRef)) return `the secret ${name} has no value on this node`;
  return undefined;
}

/** What the trail keeps about one egress request. */
export interface EgressAuditEvent {
  packageId: string;
  method: string;
  origin: string;
  secret?: string;
  status?: number;
  outcome: "done" | "failed" | "refused" | "stopped";
  reason?: string;
}

export interface EgressHandlerDeps {
  packageId: string;
  egress: ServiceEgress;
  secrets: Pick<SecretBroker, "headersFor">;
  /** The explicit-consumer check in `egressSecretProblem`, bound to the node's store. */
  secretProblem: (name: string) => string | undefined;
  /** Aborts when no host call to the service is in flight any more; undefined when none is in flight now. */
  inCall: () => AbortSignal | undefined;
  fetch?: typeof fetch;
  audit?: (event: EgressAuditEvent) => void;
  timeoutMs?: number;
}

/** What the host advertises in `initialize`, so a service knows it may ask. */
export const EGRESS_EXPERIMENTAL = { [SERVICE_EGRESS_CAPABILITY]: { version: SERVICE_EGRESS_VERSION, methods: [SERVICE_EGRESS_METHOD] } };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Every occurrence of any needle in `bytes`, replaced. Longest needle first, so a header value wins over its token. */
function redactBytes(bytes: Buffer, needles: readonly string[]): Buffer {
  let current = bytes;
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    const target = Buffer.from(needle, "utf8");
    if (target.length === 0 || current.indexOf(target) < 0) continue;
    const parts: Buffer[] = [];
    let from = 0;
    let at = current.indexOf(target, from);
    while (at >= 0) {
      parts.push(current.subarray(from, at), Buffer.from("[redacted]"));
      from = at + target.length;
      at = current.indexOf(target, from);
    }
    parts.push(current.subarray(from));
    current = Buffer.concat(parts);
  }
  return current;
}

function redactText(text: string, needles: readonly string[]): string {
  let current = text;
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    if (needle !== "") current = current.split(needle).join("[redacted]");
  }
  return current;
}

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Buffer | "too-large"> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw signal.reason instanceof Error ? signal.reason : new Error("stopped");
    }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * The handler the stdio transport calls for each request a service sends. Rejects with `McpServerRequestError`, whose
 * code says what the service can do about it, and whose message never carries a secret.
 */
export function egressRequestHandler(
  deps: EgressHandlerDeps,
): (request: { method: string; params: unknown; signal: AbortSignal }) => Promise<EgressFetchResult> {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? SERVICE_EGRESS_LIMITS.timeoutMs;

  return async (request) => {
    if (request.method !== SERVICE_EGRESS_METHOD) {
      throw new McpServerRequestError(JSON_RPC_METHOD_NOT_FOUND, `the host does not answer ${request.method.slice(0, 80)}`);
    }
    const parsed = egressFetchRequestSchema.safeParse(request.params);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new McpServerRequestError(
        EGRESS_ERROR_CODES.invalid,
        `the egress request is not valid: ${issue === undefined ? "unknown shape" : `${issue.path.join(".") || "request"} ${issue.message}`}`.slice(0, 300),
      );
    }
    const params = parsed.data;

    let url: URL;
    try {
      url = new URL(params.url);
    } catch {
      throw new McpServerRequestError(EGRESS_ERROR_CODES.invalid, "the egress request's url is not a URL");
    }
    /** The refusal the service receives, written to the trail first. */
    const refuse = (code: number, reason: string, origin: string, secret?: string): McpServerRequestError => {
      deps.audit?.({
        packageId: deps.packageId,
        method: params.method,
        origin,
        ...(secret === undefined ? {} : { secret }),
        outcome: "refused",
        reason,
      });
      return new McpServerRequestError(code, reason);
    };
    if (url.username !== "" || url.password !== "") {
      throw refuse(EGRESS_ERROR_CODES.invalid, "an egress url may not carry credentials", url.origin);
    }
    const declared = deps.egress.origins.find((entry) => entry.origin === url.origin);
    if (declared === undefined) {
      throw refuse(EGRESS_ERROR_CODES.originNotDeclared, `${url.origin} is not an origin this package declared`, url.origin);
    }
    const credential = declared.credential;
    const callSignal = deps.inCall();
    if (callSignal === undefined || callSignal.aborted) {
      throw refuse(EGRESS_ERROR_CODES.notInCall, "egress is answered only while the host is calling this service", url.origin, credential?.secret);
    }

    // The service's own headers, less the ones only the host's client sets and the one the host adds itself.
    const headers: Record<string, string> = {};
    const entries = Object.entries(params.headers ?? {});
    if (entries.length > SERVICE_EGRESS_LIMITS.headers) {
      throw refuse(EGRESS_ERROR_CODES.invalid, `an egress request carries at most ${String(SERVICE_EGRESS_LIMITS.headers)} headers`, url.origin);
    }
    for (const [name, value] of entries) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || /[\r\n\0]/.test(value)) {
        throw refuse(EGRESS_ERROR_CODES.invalid, "an egress header is not a valid HTTP header", url.origin);
      }
      if (egressHeaderProblem(name) !== undefined) continue;
      if (credential !== undefined && name.toLowerCase() === credential.header.toLowerCase()) continue;
      headers[name.toLowerCase()] = value;
    }

    let body: Buffer | undefined;
    if (params.body !== undefined) {
      if (params.method === "GET" || params.method === "HEAD") {
        throw refuse(EGRESS_ERROR_CODES.invalid, `a ${params.method} egress request carries no body`, url.origin);
      }
      if (params.body.encoding === "base64" && !BASE64.test(params.body.data)) {
        throw refuse(EGRESS_ERROR_CODES.invalid, "the egress body is not base64", url.origin);
      }
      body = Buffer.from(params.body.data, params.body.encoding);
      if (body.byteLength > SERVICE_EGRESS_LIMITS.requestBodyBytes) {
        throw refuse(EGRESS_ERROR_CODES.tooLarge, `an egress request body is at most ${String(SERVICE_EGRESS_LIMITS.requestBodyBytes)} bytes`, url.origin);
      }
    }

    // The value exists from here to the end of this function, and only in `headers` and `redacted`.
    const redacted: string[] = [];
    if (credential !== undefined) {
      const problem = deps.secretProblem(credential.secret);
      if (problem !== undefined) throw refuse(EGRESS_ERROR_CODES.credentialUnavailable, problem, url.origin, credential.secret);
      const found = deps.secrets.headersFor(
        { name: credential.secret, consumer: packageConsumer(deps.packageId) },
        credential.header,
      );
      if (!found.ok) {
        throw refuse(EGRESS_ERROR_CODES.credentialUnavailable, `the secret ${credential.secret} cannot be used: ${found.code}`, url.origin, credential.secret);
      }
      const value = found.headers[credential.header] ?? "";
      const sent = credential.scheme === "bearer" ? `Bearer ${value}` : value;
      headers[credential.header.toLowerCase()] = sent;
      redacted.push(sent, value);
    }

    const signal = AbortSignal.any([request.signal, callSignal, AbortSignal.timeout(timeoutMs)]);
    const settle = (event: Omit<EgressAuditEvent, "packageId" | "method" | "origin" | "secret">): void => {
      deps.audit?.({
        packageId: deps.packageId,
        method: params.method,
        origin: url.origin,
        ...(credential === undefined ? {} : { secret: credential.secret }),
        ...event,
      });
    };

    let response: Response;
    try {
      response = await doFetch(url, {
        method: params.method,
        headers,
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
        redirect: "manual",
        signal,
      });
    } catch {
      if (request.signal.aborted || callSignal.aborted) {
        settle({ outcome: "stopped", reason: "the call ended before the request finished" });
        throw new McpServerRequestError(EGRESS_ERROR_CODES.stopped, "the call ended before the request finished");
      }
      const reason = signal.aborted ? `the request to ${url.origin} took longer than ${String(timeoutMs)} ms` : `the request to ${url.origin} failed`;
      settle({ outcome: "failed", reason });
      throw new McpServerRequestError(EGRESS_ERROR_CODES.upstreamFailed, reason);
    }

    let bytes: Buffer | "too-large";
    try {
      bytes = await readBounded(response, SERVICE_EGRESS_LIMITS.responseBodyBytes, signal);
    } catch {
      const stopped = request.signal.aborted || callSignal.aborted;
      const reason = stopped ? "the call ended before the request finished" : `the response from ${url.origin} could not be read`;
      settle({ outcome: stopped ? "stopped" : "failed", status: response.status, reason });
      throw new McpServerRequestError(stopped ? EGRESS_ERROR_CODES.stopped : EGRESS_ERROR_CODES.upstreamFailed, reason);
    }
    if (bytes === "too-large") {
      const reason = `the response from ${url.origin} is larger than ${String(SERVICE_EGRESS_LIMITS.responseBodyBytes)} bytes`;
      settle({ outcome: "failed", status: response.status, reason });
      throw new McpServerRequestError(EGRESS_ERROR_CODES.tooLarge, reason);
    }

    const returned: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name === "set-cookie") return;
      returned[name] = redactText(value, redacted);
    });
    settle({ outcome: "done", status: response.status });
    return {
      version: SERVICE_EGRESS_VERSION,
      status: response.status,
      headers: returned,
      body: { encoding: "base64", data: redactBytes(bytes, redacted).toString("base64") },
    };
  };
}
