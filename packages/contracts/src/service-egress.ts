import { z } from "zod";

import { networkOriginSchema } from "./network-origin.ts";

/**
 * Service egress: how a package service reaches a provider without ever holding its secret.
 *
 * A service container has no network (`--network none`), and that does not change. A service that needs a provider
 * asks the host instead, over the same stdio connection the host already speaks MCP on: it sends the request
 * `clarkcant/egress.fetch`, and the host makes the HTTP request for it. The host sends only to an origin the package
 * declared, adds the declared credential header itself from the secret broker, and removes the secret from whatever
 * comes back. The service sees a response; it never sees the key, an environment variable holding it, or a socket.
 *
 * The declaration below is what consent and the host read. It names origins and secrets, never values: a value is
 * typed by the person into the node's credential store, stored for the consumer `package:<id>`.
 */

export const SERVICE_EGRESS_VERSION = 1;
/** The request a service sends the host. */
export const SERVICE_EGRESS_METHOD = "clarkcant/egress.fetch";
/** The experimental capability the host advertises in `initialize` when it answers that request. */
export const SERVICE_EGRESS_CAPABILITY = "clarkcant/egress";

const MIB = 1024 * 1024;

/** Bounds on one egress request. A service that needs more is a service that should be a job reading an artifact. */
export const SERVICE_EGRESS_LIMITS = {
  requestBodyBytes: MIB,
  responseBodyBytes: 2 * MIB,
  headers: 32,
  headerValueChars: 8_192,
  urlChars: 2_048,
  timeoutMs: 30_000,
} as const;

/** A secret's name as the credential store keys it. */
export const egressSecretNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, { error: "must be a secret name of letters, digits, _ . or -" });

/**
 * Headers a service may not set and a credential may not be written into.
 *
 * Framing and connection headers belong to the host's HTTP client; cookies and proxy credentials are ambient authority
 * nobody declared; forwarding headers would let a service lie about where a request came from.
 */
const FORBIDDEN_EGRESS_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
const FORBIDDEN_EGRESS_HEADER_PREFIXES: readonly string[] = ["proxy-", "sec-"];

/** Why a header name may not be sent through egress, or `undefined` when it may. */
export function egressHeaderProblem(name: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)) return "must be a header name of letters, digits and -";
  const lower = name.toLowerCase();
  if (FORBIDDEN_EGRESS_HEADERS.has(lower) || FORBIDDEN_EGRESS_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return "is a header only the host's HTTP client sets";
  }
  return undefined;
}

const egressHeaderNameSchema = z
  .string()
  .refine((value) => egressHeaderProblem(value) === undefined, {
    error: (issue) => `header ${JSON.stringify(issue.input)} ${egressHeaderProblem(String(issue.input)) ?? "is invalid"}`,
  });

/**
 * The credential the host adds to requests for one origin.
 *
 * `bearer` sends `Bearer <secret>`, `raw` sends the secret as the whole value (an `x-api-key` style header).
 */
export const egressCredentialSchema = z.strictObject({
  secret: egressSecretNameSchema,
  header: egressHeaderNameSchema,
  scheme: z.enum(["bearer", "raw"]),
});
export type EgressCredential = z.infer<typeof egressCredentialSchema>;

export const serviceEgressSchema = z.strictObject({
  version: z.literal(SERVICE_EGRESS_VERSION),
  /** The secrets the package needs a person to provide, by name, with what each is for. */
  secrets: z
    .array(z.strictObject({ name: egressSecretNameSchema, purpose: z.string().min(1).max(300) }))
    .max(8),
  origins: z
    .array(
      z.strictObject({
        origin: networkOriginSchema,
        purpose: z.string().min(1).max(300),
        credential: egressCredentialSchema.optional(),
      }),
    )
    .min(1)
    .max(16),
});
export type ServiceEgress = z.infer<typeof serviceEgressSchema>;

/** Rules that relate one part of an egress declaration to another. Empty means it is coherent. */
export function serviceEgressProblems(egress: ServiceEgress): string[] {
  const problems: string[] = [];
  const secrets = new Set<string>();
  for (const secret of egress.secrets) {
    if (secrets.has(secret.name)) problems.push(`secret ${secret.name} is declared twice`);
    secrets.add(secret.name);
  }
  const origins = new Set<string>();
  const used = new Set<string>();
  for (const entry of egress.origins) {
    if (origins.has(entry.origin)) problems.push(`origin ${entry.origin} is declared twice`);
    origins.add(entry.origin);
    // A WebSocket is a long-lived channel the host would have to relay; egress is one request and one response.
    if (!entry.origin.startsWith("https://") && !entry.origin.startsWith("http://")) {
      problems.push(`origin ${entry.origin} must be http or https; egress makes requests, not connections`);
    }
    if (entry.credential !== undefined) {
      used.add(entry.credential.secret);
      if (!secrets.has(entry.credential.secret)) {
        problems.push(`origin ${entry.origin} uses secret ${entry.credential.secret}, which is not declared in secrets`);
      }
    }
  }
  for (const name of secrets) {
    if (!used.has(name)) problems.push(`secret ${name} is declared but no origin uses it`);
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * The request and its answer, as they cross the stdio connection
 * ------------------------------------------------------------------ */

export const EGRESS_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

export const egressFetchRequestSchema = z.strictObject({
  version: z.literal(SERVICE_EGRESS_VERSION),
  url: z.string().min(1).max(SERVICE_EGRESS_LIMITS.urlChars),
  method: z.enum(EGRESS_METHODS).default("GET"),
  headers: z.record(z.string().min(1).max(64), z.string().max(SERVICE_EGRESS_LIMITS.headerValueChars)).optional(),
  /** Base64 for bytes, utf8 for text. Bounded again after decoding, against `requestBodyBytes`. */
  body: z
    .strictObject({
      encoding: z.enum(["utf8", "base64"]),
      data: z.string().max(Math.ceil((SERVICE_EGRESS_LIMITS.requestBodyBytes * 4) / 3) + 4),
    })
    .optional(),
});
export type EgressFetchRequest = z.infer<typeof egressFetchRequestSchema>;

/** What the host answers. A redirect is returned as it came, with its `location`; it is never followed. */
export interface EgressFetchResult {
  version: typeof SERVICE_EGRESS_VERSION;
  status: number;
  headers: Record<string, string>;
  body: { encoding: "base64"; data: string };
}

/**
 * JSON-RPC error codes the host answers an egress request with, in the range JSON-RPC leaves to applications.
 * Each says what the service can do about it: nothing (not declared), wait for a call (not in a call), ask the person
 * (no credential), send less (too large), or try again later (upstream).
 */
export const EGRESS_ERROR_CODES = {
  invalid: -32602,
  originNotDeclared: -32010,
  notInCall: -32011,
  credentialUnavailable: -32012,
  tooLarge: -32013,
  upstreamFailed: -32014,
  stopped: -32015,
} as const;
