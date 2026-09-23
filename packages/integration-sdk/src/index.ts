import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Integration and auth descriptors.
 *
 * The OAuth helpers here are real cryptography and real validation: PKCE verifier
 * generation, the S256 challenge, state nonce comparison and scope-subset checks.
 * What is *not* here is a live token exchange, because that needs a registered
 * client identity and a real account. The distinction is kept explicit so nothing
 * claims a connection exists when only the machinery to build one does.
 */

export const authFlowSchema = [
  "oauth-native-pkce",
  "oauth-server-code",
  "device-authorization",
  "api-key",
  "mcp-oauth",
  "none",
] as const;
export type AuthFlow = (typeof authFlowSchema)[number];

export interface ConnectionDescriptor {
  provider: string;
  flow: AuthFlow;
  /** Scopes requested at authorization time. Always start from the least needed. */
  requestedScopes: string[];
  /** Scopes the integration can work without, so partial consent stays usable. */
  optionalScopes: string[];
  /** Probe that proves the capability, not merely that a token exists. */
  capabilityProbe: { capabilityRef: string; description: string };
  /** Redirect constraint: `loopback` is valid only for a desktop owner node. */
  redirectKind: "loopback" | "registered-https" | "none";
}

/* ------------------------------------------------------------------ *
 * PKCE
 * ------------------------------------------------------------------ */

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/**
 * Generate a PKCE pair.
 *
 * The verifier is 32 random bytes base64url-encoded and the challenge is its
 * SHA-256 digest, both per RFC 7636. `randomBytes` is the CSPRNG, not `Math.random`.
 */
export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: s256(verifier), method: "S256" };
}

export function s256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function randomState(): string {
  return base64url(randomBytes(24));
}

/**
 * Compare the returned `state` against the value we issued.
 *
 * Constant-time, because a mismatch here means a possible CSRF and the comparison
 * should not leak how many leading characters matched.
 */
export function verifyState(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ *
 * Scope handling
 * ------------------------------------------------------------------ */

export interface ScopeVerification {
  granted: string[];
  missingRequired: string[];
  missingOptional: string[];
  /** `full` when every required scope came back, `partial` when some did not. */
  status: "full" | "partial" | "denied";
}

/**
 * Compare granted scopes against what was requested.
 *
 * Providers return what they decided, not what was asked for. Recording the
 * difference is what lets the UI say "partial" instead of implying full access —
 * the failure mode acceptance test T30 covers.
 */
export function verifyScopes(
  descriptor: Pick<ConnectionDescriptor, "requestedScopes" | "optionalScopes">,
  granted: readonly string[],
): ScopeVerification {
  const grantedSet = new Set(granted);
  const required = descriptor.requestedScopes.filter((scope) => !descriptor.optionalScopes.includes(scope));
  const missingRequired = required.filter((scope) => !grantedSet.has(scope));
  const missingOptional = descriptor.optionalScopes.filter((scope) => !grantedSet.has(scope));

  const status: ScopeVerification["status"] =
    granted.length === 0 ? "denied" : missingRequired.length > 0 ? "partial" : "full";

  return {
    granted: [...grantedSet],
    missingRequired,
    missingOptional,
    status,
  };
}

/**
 * Whether a stored connection can satisfy a capability.
 *
 * A token with the wrong scopes is not a usable connection, and a connection that
 * has never passed a capability probe is not "connected" either. Both checks are
 * required, which is what stops "authorization succeeded" from being reported as
 * "integration works".
 */
export function connectionUsable(input: {
  status: string;
  grantedScopes: readonly string[];
  requiredScopes: readonly string[];
  lastProbeResult: "pass" | "fail" | "not-run" | undefined;
}): { usable: true } | { usable: false; reason: string } {
  if (input.status !== "connected") {
    return { usable: false, reason: `connection status is ${input.status}` };
  }
  const missing = input.requiredScopes.filter((scope) => !input.grantedScopes.includes(scope));
  if (missing.length > 0) {
    return { usable: false, reason: `the account did not grant: ${missing.join(", ")}` };
  }
  if (input.lastProbeResult !== "pass") {
    return {
      usable: false,
      reason: `the capability probe has not passed (last result: ${String(input.lastProbeResult ?? "not-run")})`,
    };
  }
  return { usable: true };
}

/**
 * Reject an endpoint that a model chose.
 *
 * A model must not be able to point credential-bearing traffic at an origin it
 * invented, so endpoints are checked against a declared allowlist and refused
 * unless they are HTTPS.
 */

/**
 * Whether a host is this machine.
 *
 * `localhost` is included because a URL may name it, but the check is on the host, not on a resolved address: this
 * function decides whether a string may be sent a credential, and DNS is not consulted to answer that.
 */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

export function validateEndpoint(input: {
  url: string;
  allowedOrigins: readonly string[];
}): { ok: true; origin: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, reason: `${input.url} is not a valid absolute URL` };
  }
  if (parsed.protocol !== "https:") {
    /*
     * Loopback is the one exception, and it is not a weakening of the rule: traffic to 127.0.0.1 never leaves the
     * machine, so "credentials must not travel in the clear" is not a statement about it. A desktop owner node's
     * redirect is loopback by design, and a local token endpoint is how this machinery is exercised without an
     * account. Anything else that is not HTTPS is still refused.
     */
    if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname)) {
      return { ok: false, reason: `endpoint ${input.url} is not HTTPS; credentials must not travel in the clear` };
    }
  }
  if (!input.allowedOrigins.includes(parsed.origin)) {
    return {
      ok: false,
      reason: `endpoint origin ${parsed.origin} is not in the connection's declared allowlist [${input.allowedOrigins.join(", ")}]`,
    };
  }
  return { ok: true, origin: parsed.origin };
}

/**
 * @status-ref integration-sdk.token-exchange
 *
 * The exchange and refresh loop live in `token-exchange.ts`. They are real: PKCE is sent and checked, state is
 * compared before a code travels, and scopes are verified against what was requested. What this repository still
 * does not hold is a registered OAuth client and a real account, so the endpoint a live connection would use has
 * never been called — which is why the `V09` row in the registry and the conformance table stay PARTIAL.
 */
export const LIVE_TOKEN_EXCHANGE_STATUS = "implemented-against-injected-endpoint";

export {
  exchangeAuthorizationCode,
  refreshAccessToken,
  type TokenExchangeResult,
  type TokenGrant,
} from "./token-exchange.ts";

/**
 * The reference integration's Calendar client.
 *
 * Exported because the pack that owns Google Calendar is where this belongs: the SDK owns the request shape and the
 * vocabulary for what came back, the pack owns the events, the conflicts and the freshness rule. A pack that
 * re-implemented the request would be a second client for one API, and the two would drift in exactly the place
 * where "did that write land?" is decided.
 */
export {
  CALENDAR_API_STATUS,
  readAgenda,
  writeEvent,
  type AgendaRead,
  type CalendarEvent as CalendarApiEvent,
  type CalendarWriteOutcome,
} from "./calendar-api.ts";
