import { isIP } from "node:net";

import {
  EGRESS_ERROR_CODES,
  type EffectCategory,
  type EgressFetchResult,
  egressFetchRequestSchema,
  egressHeaderProblem,
  egressMethodProblem,
  SERVICE_EGRESS_CAPABILITY,
  SERVICE_EGRESS_LIMITS,
  SERVICE_EGRESS_METHOD,
  SERVICE_EGRESS_RATE,
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
 *   - never to a loopback, private or link-local address unless the node was started with
 *     `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`: a request from the host is outside the service's sandbox, and the local
 *     daemons on those addresses trust whoever can reach them;
 *   - only while a host call to that service is in flight, so a service cannot reach anything on its own schedule,
 *     and its requests stop when the last call ends, when the call is cancelled, or when the service is stopped;
 *   - only `GET` and `HEAD` unless a call in flight was decided as external-write or higher, so a capability declared
 *     `read` cannot write to a provider with the person's key without the policy having decided on a write;
 *   - at a bounded rate per running service (`SERVICE_EGRESS_RATE`);
 *   - with the declared credential header added by the host from the secret broker, for the consumer
 *     `package:<id>`, which the secret must name explicitly; a header the service sets with that name is dropped;
 *   - for an endpoint of the facet's `connection`, with `authorization: Bearer <access token>` added by the host from
 *     the node's connection broker, fetched for this one request; an `authorization` header the service sets is
 *     dropped, and a 401 from the provider is reported to the broker, which refreshes once or marks the connection
 *     ended. The request itself is never retried;
 *   - with framing, cookie, proxy, forwarding and encoding headers stripped, an uncompressed answer asked for, and
 *     bounded request and response bodies;
 *   - without following redirects: a redirect comes back as it is, so a credential never travels to another origin;
 *   - with the secret removed from every header and from the body of what comes back, as it was sent and in its
 *     JSON-escaped, URL-encoded and base64 forms. This is a best-effort guard against a provider that echoes the key,
 *     not a guarantee: a provider that returns it transformed some other way hands it to the service.
 *
 * Every request is written to the trail by package, method, origin and secret name. Never a path, a body, a value or
 * a length. Refusals are coalesced: the first of a kind in a window is written as it happens, and the rest of that
 * window as one row with their count, so a service that loops on refused requests cannot flood the trail.
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

/** What the trail keeps about one egress request, or about a run of refusals of one kind. */
export interface EgressAuditEvent {
  packageId: string;
  method: string;
  origin: string;
  secret?: string;
  /** The provider whose connection's credential was added, by id. */
  connection?: string;
  status?: number;
  outcome: "done" | "failed" | "refused" | "stopped";
  reason?: string;
  /** How many refusals this row stands for, when it stands for more than one. */
  count?: number;
}

/** The calls in flight to a service: aborted when the last one ends, and the effects each was decided as. */
export interface EgressCallScope {
  signal: AbortSignal;
  effects: readonly EffectCategory[];
}

/** Whether the node lets services reach loopback, private and link-local addresses: a setting of the node, never a manifest's. */
export function egressAllowsPrivateNetwork(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["CC_EGRESS_ALLOW_PRIVATE_NETWORK"] === "1";
}

function privateIPv4(address: string): boolean {
  const [a = -1, b = -1] = address.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

/**
 * Whether a URL's host is a loopback, private or link-local address: `localhost` and its subdomains, 0/8, 10/8, 127/8,
 * 169.254/16, 172.16/12, 192.168/16, `::`, `::1`, fc00::/7, fe80::/10, and those IPv4 ranges written as IPv6.
 *
 * Read from the URL's own host. A public name that resolves to such an address is not caught here.
 */
export function isPrivateNetworkHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return privateIPv4(host);
  if (isIP(host) !== 6) return false;
  if (host === "::" || host === "::1") return true;
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
  // An IPv4 address written as IPv6 (`::ffff:a.b.c.d`, which the URL parser writes as two hex groups).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1] ?? "0", 16);
    const low = Number.parseInt(mapped[2] ?? "0", 16);
    return privateIPv4(`${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`);
  }
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  return dotted !== null && privateIPv4(dotted[1] ?? "");
}

/** A facet's connection, as the egress handler uses it: where its credential may go, and how to get one. */
export interface EgressConnection {
  provider: string;
  /** The declared API origins. The credential is added for these and no others. */
  endpoints: readonly string[];
  /** The access token for this one request, or why there is none. */
  credential: () => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;
  /** The provider answered 401 to a request that carried this access token. */
  rejected?: (sentToken: string) => Promise<void>;
}

export interface EgressHandlerDeps {
  packageId: string;
  /** Absent when the facet declares only a connection. */
  egress?: ServiceEgress;
  connection?: EgressConnection;
  secrets: Pick<SecretBroker, "headersFor">;
  /** The explicit-consumer check in `egressSecretProblem`, bound to the node's store. */
  secretProblem: (name: string) => string | undefined;
  /** The calls in flight to the service now, or undefined when there are none. */
  inCall: () => EgressCallScope | undefined;
  /** The node's setting for loopback, private and link-local origins (`egressAllowsPrivateNetwork`). Off by default. */
  allowPrivateNetwork?: boolean;
  fetch?: typeof fetch;
  audit?: (event: EgressAuditEvent) => void;
  timeoutMs?: number;
  rate?: { burst: number; refillPerSecond: number };
  /** How long refusals of one kind are gathered into one trail row. */
  refusalWindowMs?: number;
  /** The clock the rate and the windows are measured on, in milliseconds. */
  now?: () => number;
}

/** The handler a service's stdio connection calls, and `flush`, which writes the refusals still being gathered. */
export type EgressRequestHandler = ((request: { method: string; params: unknown; signal: AbortSignal }) => Promise<EgressFetchResult>) & {
  flush(): void;
};

/** What the host advertises in `initialize`, so a service knows it may ask. */
export const EGRESS_EXPERIMENTAL = { [SERVICE_EGRESS_CAPABILITY]: { version: SERVICE_EGRESS_VERSION, methods: [SERVICE_EGRESS_METHOD] } };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Shorter encoded forms are left alone: they could match ordinary text that merely shares a few characters. */
const MIN_ENCODED_FORM = 12;

/**
 * The secret as a provider might echo it: as sent, JSON-escaped (with and without `\/`), URL-encoded (either hex case,
 * `+` for a space), and base64 or base64url at each of the three alignments it can take inside a longer encoded text.
 */
export function secretForms(value: string): string[] {
  if (value === "") return [];
  const forms = new Set<string>([value]);
  const json = JSON.stringify(value).slice(1, -1);
  forms.add(json);
  forms.add(json.replaceAll("/", "\\/"));
  const encoded = encodeURIComponent(value);
  forms.add(encoded);
  forms.add(encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
  forms.add(encoded.replaceAll("%20", "+"));
  const bytes = Buffer.from(value, "utf8");
  for (const shift of [0, 1, 2]) {
    const text = Buffer.concat([Buffer.alloc(shift), bytes]).toString("base64").replace(/=+$/, "");
    // Drop the characters that also hold bits of the bytes before it, and the last one when it holds bits after it.
    const start = shift === 0 ? 0 : shift + 1;
    const end = (shift + bytes.length) % 3 === 0 ? text.length : text.length - 1;
    const core = text.slice(start, end);
    if (core.length >= MIN_ENCODED_FORM) {
      forms.add(core);
      forms.add(core.replaceAll("+", "-").replaceAll("/", "_"));
    }
  }
  return [...forms].filter((form) => form.length > 0);
}

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
export function egressRequestHandler(deps: EgressHandlerDeps): EgressRequestHandler {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? SERVICE_EGRESS_LIMITS.timeoutMs;
  const clock = deps.now ?? ((): number => Date.now());
  const rate = deps.rate ?? SERVICE_EGRESS_RATE;
  const windowMs = deps.refusalWindowMs ?? 60_000;

  /** A request bucket that refills for the time since its last request; spends one, or says it is empty. */
  let tokens: number = rate.burst;
  let refilledAt = clock();
  const takeToken = (): boolean => {
    const at = clock();
    tokens = Math.min(rate.burst, tokens + (Math.max(0, at - refilledAt) / 1000) * rate.refillPerSecond);
    refilledAt = at;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  /**
   * Refusals gathered by kind. The first of a kind is written at once; the ones after it in the same window are
   * counted, and written as one row when the window closes, so the trail says how many there were without a row each.
   */
  const gathering = new Map<number, { first: EgressAuditEvent; more: number; timer: ReturnType<typeof setTimeout> }>();
  const closeWindow = (code: number): void => {
    const open = gathering.get(code);
    if (open === undefined) return;
    gathering.delete(code);
    clearTimeout(open.timer);
    if (open.more === 0) return;
    deps.audit?.({
      ...open.first,
      reason: `${String(open.more)} more refused like this in the ${String(Math.round(windowMs / 1000))} s after: ${open.first.reason ?? ""}`.slice(0, 400),
      count: open.more,
    });
  };
  const auditRefusal = (code: number, event: EgressAuditEvent): void => {
    const open = gathering.get(code);
    if (open !== undefined) {
      open.more += 1;
      return;
    }
    deps.audit?.(event);
    const timer = setTimeout(() => closeWindow(code), windowMs);
    timer.unref?.();
    gathering.set(code, { first: event, more: 0, timer });
  };

  const handle = async (request: { method: string; params: unknown; signal: AbortSignal }): Promise<EgressFetchResult> => {
    if (!takeToken()) {
      const reason = `at most ${String(rate.refillPerSecond)} egress requests a second, after a burst of ${String(rate.burst)}`;
      auditRefusal(EGRESS_ERROR_CODES.rateLimited, { packageId: deps.packageId, method: "-", origin: "-", outcome: "refused", reason });
      throw new McpServerRequestError(EGRESS_ERROR_CODES.rateLimited, reason);
    }
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
    /** The refusal the service receives, written to the trail first, gathered with the others of its kind. */
    const refuse = (code: number, reason: string, origin: string, secret?: string): McpServerRequestError => {
      auditRefusal(code, {
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
    const declared = deps.egress?.origins.find((entry) => entry.origin === url.origin);
    const connection = deps.connection?.endpoints.includes(url.origin) === true ? deps.connection : undefined;
    if (declared === undefined && connection === undefined) {
      throw refuse(EGRESS_ERROR_CODES.originNotDeclared, `${url.origin} is not an origin this package declared`, url.origin);
    }
    if (deps.allowPrivateNetwork !== true && isPrivateNetworkHost(url)) {
      throw refuse(
        EGRESS_ERROR_CODES.originNotAllowed,
        `${url.origin} is a loopback, private or link-local address, which this node does not let services reach (CC_EGRESS_ALLOW_PRIVATE_NETWORK)`,
        url.origin,
      );
    }
    const credential = declared?.credential;
    const calls = deps.inCall();
    if (calls === undefined || calls.signal.aborted) {
      throw refuse(EGRESS_ERROR_CODES.notInCall, "egress is answered only while the host is calling this service", url.origin, credential?.secret);
    }
    const callSignal = calls.signal;
    const methodProblem = egressMethodProblem(params.method, calls.effects);
    if (methodProblem !== undefined) throw refuse(EGRESS_ERROR_CODES.effectNotAllowed, methodProblem, url.origin, credential?.secret);

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
      if (connection !== undefined && name.toLowerCase() === "authorization") continue;
      headers[name.toLowerCase()] = value;
    }
    // Uncompressed, so the answer can be searched for the secret before the service sees it.
    headers["accept-encoding"] = "identity";

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
      redacted.push(...secretForms(sent), ...secretForms(value));
    }
    let connectionToken: string | undefined;
    if (connection !== undefined) {
      const found = await connection.credential();
      if (!found.ok) throw refuse(EGRESS_ERROR_CODES.credentialUnavailable, found.reason.slice(0, 300), url.origin);
      connectionToken = found.token;
      const sent = `Bearer ${found.token}`;
      headers["authorization"] = sent;
      redacted.push(...secretForms(sent), ...secretForms(found.token));
    }

    const signal = AbortSignal.any([request.signal, callSignal, AbortSignal.timeout(timeoutMs)]);
    const settle = (event: Omit<EgressAuditEvent, "packageId" | "method" | "origin" | "secret">): void => {
      deps.audit?.({
        packageId: deps.packageId,
        method: params.method,
        origin: url.origin,
        ...(credential === undefined ? {} : { secret: credential.secret }),
        ...(connection === undefined ? {} : { connection: connection.provider }),
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
    // The provider no longer accepts the credential. The broker refreshes once or ends the connection; this request is
    // answered as it came, and not retried: whether a write sent with it took effect is not this handler's to guess.
    if (connectionToken !== undefined && response.status === 401) await connection?.rejected?.(connectionToken).catch(() => undefined);
    return {
      version: SERVICE_EGRESS_VERSION,
      status: response.status,
      headers: returned,
      body: { encoding: "base64", data: redactBytes(bytes, redacted).toString("base64") },
    };
  };

  return Object.assign(handle, {
    flush: (): void => {
      for (const code of [...gathering.keys()]) closeWindow(code);
    },
  });
}
