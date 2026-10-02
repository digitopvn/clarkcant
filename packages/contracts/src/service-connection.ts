import { z } from "zod";

import { networkOriginSchema } from "./network-origin.ts";

/**
 * A service's connection to a person's account at a provider.
 *
 * A package declares what it needs — a provider, the scopes, the endpoints it may reach with the account — and the
 * host does everything that touches a credential: it runs the authorization in host-owned UI (the system browser,
 * redirected back to the node over loopback), exchanges the code, keeps the tokens on the node, refreshes them, and
 * adds `authorization: Bearer <token>` to the service's egress requests for the declared endpoints only. The service
 * sees responses; the widget sees a status. Neither ever holds a token, a refresh token or an authorization code.
 *
 * One connection per package and one account per connection: multiple accounts are not part of this contract.
 */

export const SERVICE_CONNECTION_VERSION = 1;

/** A scope as the provider spells it. Space is the OAuth separator, so it can never be part of one. */
export const connectionScopeSchema = z
  .string()
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/, { error: "must be a scope of printable characters without space, quote or backslash" });

const endpointUrlSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => connectionUrlProblem(value) === undefined, {
    error: (issue) => `${JSON.stringify(issue.input)} ${connectionUrlProblem(String(issue.input)) ?? "is invalid"}`,
  });

/** Why a URL the host would send a credential or a code to is not acceptable, or `undefined` when it is. */
export function connectionUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not an absolute URL";
  }
  if (url.username !== "" || url.password !== "") return "must not carry credentials";
  if (url.hash !== "") return "must not carry a fragment";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return "must use https unless it is a loopback address";
  }
  return undefined;
}

export const serviceConnectionSchema = z.strictObject({
  version: z.literal(SERVICE_CONNECTION_VERSION),
  /** The provider, as a stable id the person and the node's records use. */
  provider: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/, { error: "must be a provider id of lowercase letters, digits, . or -" }),
  displayName: z.string().min(1).max(120),
  /** Authorization code with PKCE (S256). The only flow a package may declare: it needs no client secret. */
  flow: z.literal("oauth-pkce"),
  authorization: z.strictObject({
    authorizationEndpoint: endpointUrlSchema,
    tokenEndpoint: endpointUrlSchema,
    revocationEndpoint: endpointUrlSchema.optional(),
    /** A public client id. Never a secret: a package is readable by anyone who installs it. */
    clientId: z.string().min(1).max(200),
  }),
  /** Every scope the connection asks for, with what each is for; consent shows these. */
  scopes: z
    .array(z.strictObject({ scope: connectionScopeSchema, purpose: z.string().min(1).max(300) }))
    .min(1)
    .max(16),
  /** The API origins the host may send the connection's credential to. Enforced by the host, not the package. */
  endpoints: z.array(networkOriginSchema).min(1).max(8),
  /** A read the host makes after connecting to prove the account works, not merely that a token came back. */
  probe: z.strictObject({ url: endpointUrlSchema }),
});
export type ServiceConnectionRequirement = z.infer<typeof serviceConnectionSchema>;

/** Rules that relate one part of a connection declaration to another. Empty means it is coherent. */
export function serviceConnectionProblems(connection: ServiceConnectionRequirement): string[] {
  const problems: string[] = [];
  const scopes = new Set<string>();
  for (const entry of connection.scopes) {
    if (scopes.has(entry.scope)) problems.push(`scope ${entry.scope} is declared twice`);
    scopes.add(entry.scope);
  }
  const endpoints = new Set<string>();
  for (const origin of connection.endpoints) {
    if (endpoints.has(origin)) problems.push(`endpoint ${origin} is declared twice`);
    endpoints.add(origin);
    if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
      problems.push(`endpoint ${origin} must be http or https; the host makes requests, not connections`);
    }
  }
  const probe = safeOrigin(connection.probe.url);
  if (probe !== undefined && !endpoints.has(probe)) {
    problems.push(`probe ${connection.probe.url} is not on one of the declared endpoints`);
  }
  return problems;
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * What a UI may see
 * ------------------------------------------------------------------ */

/**
 * A connection's state as the node records it.
 *
 * - `not-connected`: never connected, or disconnected by the person.
 * - `connected`: every declared scope was granted and the probe passed.
 * - `partial`: the probe passed but the account granted fewer scopes than asked; capabilities that need a missing
 *   scope are not ready, the rest are.
 * - `expired`: the access token lapsed and could not be refreshed. Reconnecting fixes it.
 * - `revoked`: the provider no longer accepts the grant, or the person revoked it.
 */
export const CONNECTION_STATES = ["not-connected", "connected", "partial", "expired", "revoked"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * The only connection data that leaves the node's broker: no token, no code, no refresh token, no client secret.
 * Settings, the widget's availability notice and the agent all read this.
 */
export interface ConnectionStatus {
  provider: string;
  displayName: string;
  state: ConnectionState;
  /** Opaque id of the stored connection; names a record on the node, never a credential. */
  connectionRef?: string;
  requestedScopes: string[];
  grantedScopes: string[];
  missingScopes: string[];
  connectedAt?: string;
  /** In plain words, why the connection is not fully usable. Absent when it is. */
  reason?: string;
}

/**
 * Why a capability that needs these scopes cannot run on this connection, or `undefined` when it can.
 * The words name the provider and, for a partial grant, the scope that is missing.
 */
export function connectionCapabilityProblem(
  status: Pick<ConnectionStatus, "displayName" | "state" | "grantedScopes">,
  requiredScopes: readonly string[],
): string | undefined {
  switch (status.state) {
    case "not-connected":
      return `${status.displayName} is not connected; connect it in Settings`;
    case "expired":
      return `the ${status.displayName} connection expired; reconnect it in Settings`;
    case "revoked":
      return `the ${status.displayName} connection was revoked; reconnect it in Settings`;
    case "connected":
    case "partial": {
      const missing = requiredScopes.filter((scope) => !status.grantedScopes.includes(scope));
      if (missing.length === 0) return undefined;
      return `the ${status.displayName} account did not grant ${missing.join(", ")}; reconnect it in Settings and allow ${missing.length === 1 ? "it" : "them"}`;
    }
  }
}
