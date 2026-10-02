import {
  connectionCapabilityProblem,
  type ConnectionStatus,
  type Instant,
  type ServiceConnectionRequirement,
} from "@clarkcant/contracts";
import { createPkcePair, exchangeAuthorizationCode, randomState, refreshAccessToken, type TokenExchangeResult } from "@clarkcant/integration-sdk";
import {
  type Database,
  deletePackageConnection,
  endPackageConnection,
  getPackageConnection,
  packageConnectionTokens,
  refreshPackageConnectionTokens,
  savePackageConnection,
  type StoredConnection,
} from "@clarkcant/storage";

import { isPrivateNetworkHost } from "./service-egress.ts";
import type { ServiceConnectionBroker } from "./service-host.ts";

/**
 * The node's connection broker: how a package service comes to work on a person's account without holding it.
 *
 * The package declares a connection (`service-connection.ts` in contracts); everything that touches a credential
 * happens here, on the node, in host-owned steps:
 *
 *   1. `start` — a person presses Connect in Settings, which is host UI. The broker makes a PKCE pair and a single-use
 *      `state`, keeps them in memory for ten minutes, and answers the provider's authorization URL, which the client
 *      opens in the system browser. Never inside a widget frame.
 *   2. `complete` — the provider redirects the browser to the node's loopback callback. The state is checked before the
 *      code is sent anywhere, the code is exchanged at the declared token endpoint, the granted scopes are compared with
 *      the declared ones, and the declared probe must answer before the connection is kept. Tokens are written to their
 *      own table (`package_connection_tokens`); the status row is all anything else reads.
 *   3. `credential` — for each egress request to a declared endpoint, the service host asks for the access token and
 *      adds it as `authorization: Bearer …` itself. A lapsed token is refreshed first.
 *   4. `rejected` — the provider answered 401: refresh once, and if that is refused too, the connection is revoked.
 *   5. `revoke` — a person presses Revoke: the provider's revocation endpoint is called, the tokens are deleted and the
 *      connection reads `revoked` at once, so every capability that needs it is not ready, with that as the reason.
 *
 * What leaves this module is `ConnectionStatus`: no access token, refresh token, code or verifier, ever.
 */

/** How long a started authorization waits for its callback. */
const PENDING_TTL_MS = 10 * 60_000;
/** At most this many authorizations wait at once; the oldest is dropped first. */
const PENDING_LIMIT = 32;
/** A token this close to expiry is refreshed before it is used, so it does not lapse in flight. */
const EXPIRY_MARGIN_MS = 30_000;
const PROVIDER_TIMEOUT_MS = 15_000;

export interface ConnectionAuditEvent {
  packageId: string;
  provider: string;
  outcome: "done" | "failed" | "refused";
  /** In words; never a token, code or verifier. */
  summary: string;
}

export interface PackageConnectionBroker extends ServiceConnectionBroker {
  /** What a person or a widget may be told about a package's connection. */
  status(packageId: string, connection: ServiceConnectionRequirement): ConnectionStatus;
  /** Begin an authorization; answers the URL to open in the system browser. */
  start(input: {
    packageId: string;
    connection: ServiceConnectionRequirement;
    redirectUri: string;
  }): { ok: true; authorizationUrl: string } | { ok: false; code: "ENDPOINT_REFUSED"; message: string };
  /** Finish one from the provider's redirect. The answer names the package, never the code. */
  complete(query: Record<string, string>): Promise<
    | { ok: true; packageId: string; status: ConnectionStatus }
    | { ok: false; packageId?: string; message: string }
  >;
  /** End a connection at the provider and on this node. The status reads `revoked` afterwards. */
  revoke(packageId: string, connection: ServiceConnectionRequirement): Promise<ConnectionStatus>;
  /** Forget a package's connection: its package was uninstalled. Revokes at the provider when it can. */
  forget(packageId: string, connection: ServiceConnectionRequirement | undefined): Promise<void>;
}

interface Pending {
  packageId: string;
  connection: ServiceConnectionRequirement;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

export interface PackageConnectionBrokerOptions {
  db: Database;
  principalId: string;
  newId: (prefix: string) => string;
  now?: () => number;
  fetch?: typeof fetch;
  /** The node's `CC_EGRESS_ALLOW_PRIVATE_NETWORK`: loopback and private provider endpoints only when it is on. */
  allowPrivateNetwork?: boolean;
  audit?: (event: ConnectionAuditEvent) => void;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function iso(ms: number): Instant {
  return new Date(ms).toISOString() as Instant;
}

/** An OAuth error code is a short token; anything else a provider puts in the redirect is not repeated. */
function oauthError(value: string | undefined): string {
  return value !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "an error";
}

export function createPackageConnectionBroker(options: PackageConnectionBrokerOptions): PackageConnectionBroker {
  const { db, principalId } = options;
  const clock = options.now ?? ((): number => Date.now());
  const doFetch = options.fetch ?? fetch;
  const pending = new Map<string, Pending>();
  const refreshing = new Map<string, Promise<void>>();

  const audit = (event: ConnectionAuditEvent): void => {
    options.audit?.({ ...event, summary: event.summary.slice(0, 400) });
  };

  /** Why the node will not send a code, token or credential to this URL, or undefined. */
  function endpointProblem(url: string): string | undefined {
    if (options.allowPrivateNetwork === true) return undefined;
    return isPrivateNetworkHost(new URL(url))
      ? `${originOf(url)} is a loopback, private or link-local address, which this node does not connect to (CC_EGRESS_ALLOW_PRIVATE_NETWORK)`
      : undefined;
  }

  function declaredScopes(connection: ServiceConnectionRequirement): string[] {
    return connection.scopes.map((entry) => entry.scope);
  }

  function statusOf(stored: StoredConnection | undefined, connection: ServiceConnectionRequirement): ConnectionStatus {
    const requestedScopes = declaredScopes(connection);
    if (stored === undefined) {
      return {
        provider: connection.provider,
        displayName: connection.displayName,
        state: "not-connected",
        requestedScopes,
        grantedScopes: [],
        missingScopes: requestedScopes,
        reason: `${connection.displayName} is not connected`,
      };
    }
    let state = stored.state;
    let reason = stored.reason;
    // An access token that lapsed with nothing to renew it is expired now, before anything tries to use it.
    if ((state === "connected" || state === "partial") && stored.accessExpiresAt !== undefined && Date.parse(stored.accessExpiresAt) <= clock()) {
      if (packageConnectionTokens(db, stored.connectionRef).refreshToken === undefined) {
        state = "expired";
        reason = "the access token expired and the provider gave no way to renew it";
      }
    }
    const missingScopes = requestedScopes.filter((scope) => !stored.grantedScopes.includes(scope));
    if (state === "partial" && reason === undefined) reason = `the account did not grant ${missingScopes.join(", ")}`;
    return {
      provider: connection.provider,
      displayName: connection.displayName,
      state,
      connectionRef: stored.connectionRef,
      requestedScopes,
      grantedScopes: stored.grantedScopes,
      missingScopes,
      connectedAt: stored.connectedAt,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  function status(packageId: string, connection: ServiceConnectionRequirement): ConnectionStatus {
    return statusOf(getPackageConnection(db, principalId, packageId), connection);
  }

  function stateFor(connection: ServiceConnectionRequirement, granted: readonly string[]): "connected" | "partial" {
    return declaredScopes(connection).every((scope) => granted.includes(scope)) ? "connected" : "partial";
  }

  function end(stored: StoredConnection, packageId: string, state: "expired" | "revoked", reason: string): void {
    endPackageConnection(db, { connectionRef: stored.connectionRef, state, reason, at: iso(clock()) });
    audit({ packageId, provider: stored.provider, outcome: "done", summary: `the ${stored.provider} connection is ${state}: ${reason}` });
  }

  /** Whether a refresh failure means the grant is gone, rather than the provider being briefly unreachable. */
  function refusedByProvider(result: Extract<TokenExchangeResult, { ok: false }>): boolean {
    return result.code === "EXCHANGE_FAILED" && /answered 4\d\d/.test(result.message);
  }

  /**
   * Renew the access token. A provider that refuses the refresh token ends the connection as `ended`; one that cannot
   * be reached leaves it as it is, so a network blip does not cost a person their connection.
   */
  async function refresh(packageId: string, connection: ServiceConnectionRequirement, ended: "expired" | "revoked"): Promise<void> {
    const key = packageId;
    const running = refreshing.get(key);
    if (running !== undefined) return await running;
    const work = (async (): Promise<void> => {
      const stored = getPackageConnection(db, principalId, packageId);
      if (stored === undefined || (stored.state !== "connected" && stored.state !== "partial")) return;
      const tokens = packageConnectionTokens(db, stored.connectionRef);
      if (tokens.refreshToken === undefined) {
        end(stored, packageId, ended, ended === "revoked" ? "the provider no longer accepts the connection" : "the access token expired and the provider gave no way to renew it");
        return;
      }
      const problem = endpointProblem(connection.authorization.tokenEndpoint);
      if (problem !== undefined) return;
      const result = await refreshAccessToken({
        endpoint: connection.authorization.tokenEndpoint,
        allowedOrigins: [originOf(connection.authorization.tokenEndpoint)],
        clientId: connection.authorization.clientId,
        fetchImpl: doFetch,
        timeoutMs: PROVIDER_TIMEOUT_MS,
        refreshToken: tokens.refreshToken,
        descriptor: { requestedScopes: declaredScopes(connection), optionalScopes: [] },
      });
      if (!result.ok) {
        if (refusedByProvider(result)) {
          end(
            stored,
            packageId,
            ended,
            ended === "revoked" ? "the provider no longer accepts the connection" : "the access token expired and the provider would not renew it",
          );
        } else {
          audit({ packageId, provider: stored.provider, outcome: "failed", summary: `renewing the ${stored.provider} connection failed: ${result.code}` });
        }
        return;
      }
      const granted = result.grant.scopes.granted;
      refreshPackageConnectionTokens(db, {
        connectionRef: stored.connectionRef,
        accessToken: result.grant.accessToken,
        ...(result.grant.refreshToken === undefined ? {} : { refreshToken: result.grant.refreshToken }),
        ...(result.grant.expiresInSeconds === undefined ? {} : { accessExpiresAt: iso(clock() + result.grant.expiresInSeconds * 1000) }),
        grantedScopes: granted,
        state: stateFor(connection, granted),
        at: iso(clock()),
      });
      audit({ packageId, provider: stored.provider, outcome: "done", summary: `the ${stored.provider} connection was renewed` });
    })().finally(() => {
      refreshing.delete(key);
    });
    refreshing.set(key, work);
    return await work;
  }

  /** Call the provider's revocation endpoint with the token, when it has one. Best effort: the node forgets either way. */
  async function revokeAtProvider(connection: ServiceConnectionRequirement, stored: StoredConnection): Promise<boolean> {
    const endpoint = connection.authorization.revocationEndpoint;
    const tokens = packageConnectionTokens(db, stored.connectionRef);
    const token = tokens.refreshToken ?? tokens.accessToken;
    if (endpoint === undefined || token === undefined || endpointProblem(endpoint) !== undefined) return false;
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token,
          token_type_hint: tokens.refreshToken === undefined ? "access_token" : "refresh_token",
          client_id: connection.authorization.clientId,
        }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Renew a token that has lapsed or is about to, before anything is checked against it or sent with it. */
  async function prepare(packageId: string, connection: ServiceConnectionRequirement): Promise<void> {
    const stored = getPackageConnection(db, principalId, packageId);
    if (stored === undefined || (stored.state !== "connected" && stored.state !== "partial")) return;
    if (stored.accessExpiresAt === undefined || Date.parse(stored.accessExpiresAt) - EXPIRY_MARGIN_MS > clock()) return;
    await refresh(packageId, connection, "expired");
  }

  return {
    status,

    problem(packageId, connection, requiredScopes) {
      return connectionCapabilityProblem(status(packageId, connection), requiredScopes);
    },

    prepare,

    async credential(packageId, connection) {
      await prepare(packageId, connection);
      const now = status(packageId, connection);
      if (now.state !== "connected" && now.state !== "partial") {
        return { ok: false, reason: connectionCapabilityProblem(now, []) ?? `${connection.displayName} is not connected` };
      }
      const token = now.connectionRef === undefined ? undefined : packageConnectionTokens(db, now.connectionRef).accessToken;
      return token === undefined ? { ok: false, reason: `${connection.displayName} is not connected` } : { ok: true, token };
    },

    async rejected(packageId, connection) {
      await refresh(packageId, connection, "revoked");
    },

    start({ packageId, connection, redirectUri }) {
      for (const url of [connection.authorization.authorizationEndpoint, connection.authorization.tokenEndpoint]) {
        const problem = endpointProblem(url);
        if (problem !== undefined) return { ok: false, code: "ENDPOINT_REFUSED", message: problem };
      }
      const at = clock();
      for (const [key, entry] of pending) if (entry.expiresAt <= at) pending.delete(key);
      while (pending.size >= PENDING_LIMIT) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      const pkce = createPkcePair();
      const state = randomState();
      pending.set(state, { packageId, connection, verifier: pkce.verifier, redirectUri, expiresAt: at + PENDING_TTL_MS });
      const url = new URL(connection.authorization.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", connection.authorization.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", declaredScopes(connection).join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", pkce.method);
      audit({ packageId, provider: connection.provider, outcome: "done", summary: `connecting ${connection.provider} was started` });
      return { ok: true, authorizationUrl: url.toString() };
    },

    async complete(query) {
      const state = query["state"] ?? "";
      const waiting = pending.get(state);
      // Single use: whatever happens next, this state cannot complete a second authorization.
      pending.delete(state);
      if (waiting === undefined || waiting.expiresAt <= clock()) {
        return { ok: false, message: "This connection request is not one this node started, or it has expired. Start it again from Settings." };
      }
      const { packageId, connection } = waiting;
      if (query["error"] !== undefined || query["code"] === undefined) {
        audit({ packageId, provider: connection.provider, outcome: "refused", summary: `${connection.provider} answered ${oauthError(query["error"])} instead of a grant` });
        return { ok: false, packageId, message: `${connection.displayName} did not grant access (${oauthError(query["error"])}). Nothing was connected.` };
      }
      const exchanged = await exchangeAuthorizationCode({
        endpoint: connection.authorization.tokenEndpoint,
        allowedOrigins: [originOf(connection.authorization.tokenEndpoint)],
        clientId: connection.authorization.clientId,
        fetchImpl: doFetch,
        timeoutMs: PROVIDER_TIMEOUT_MS,
        redirectUri: waiting.redirectUri,
        code: query["code"],
        verifier: waiting.verifier,
        expectedState: state,
        receivedState: state,
        descriptor: { requestedScopes: declaredScopes(connection), optionalScopes: [] },
      });
      if (!exchanged.ok) {
        audit({ packageId, provider: connection.provider, outcome: "failed", summary: `exchanging the ${connection.provider} grant failed: ${exchanged.code}` });
        return { ok: false, packageId, message: `${connection.displayName} could not be connected: ${exchanged.message}.` };
      }
      const granted = exchanged.grant.scopes.granted.filter((scope) => declaredScopes(connection).includes(scope));
      if (granted.length === 0) {
        return { ok: false, packageId, message: `${connection.displayName} granted none of the access asked for. Nothing was connected.` };
      }
      // A token is not a connection until the account answers with it.
      const probeProblem = endpointProblem(connection.probe.url);
      let probe: Response | undefined;
      if (probeProblem === undefined) {
        try {
          probe = await doFetch(connection.probe.url, {
            headers: { authorization: `Bearer ${exchanged.grant.accessToken}`, accept: "application/json" },
            redirect: "manual",
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
          });
          await probe.body?.cancel().catch(() => undefined);
        } catch {
          probe = undefined;
        }
      }
      if (probe === undefined || !probe.ok) {
        const why = probeProblem ?? (probe === undefined ? "it could not be reached" : `it answered ${String(probe.status)}`);
        audit({ packageId, provider: connection.provider, outcome: "failed", summary: `the ${connection.provider} probe failed: ${why}` });
        return { ok: false, packageId, message: `${connection.displayName} granted access, but checking the account failed (${why}), so the connection was not kept.` };
      }
      const at = clock();
      savePackageConnection(db, {
        connectionRef: options.newId("conn"),
        principalId,
        packageId,
        provider: connection.provider,
        state: stateFor(connection, granted),
        grantedScopes: granted,
        ...(exchanged.grant.expiresInSeconds === undefined ? {} : { accessExpiresAt: iso(at + exchanged.grant.expiresInSeconds * 1000) }),
        connectedAt: iso(at),
        accessToken: exchanged.grant.accessToken,
        ...(exchanged.grant.refreshToken === undefined ? {} : { refreshToken: exchanged.grant.refreshToken }),
      });
      const now = status(packageId, connection);
      audit({
        packageId,
        provider: connection.provider,
        outcome: "done",
        summary: `${connection.provider} was connected (${now.state}; granted ${granted.join(", ")})`,
      });
      return { ok: true, packageId, status: now };
    },

    async revoke(packageId, connection) {
      const stored = getPackageConnection(db, principalId, packageId);
      if (stored !== undefined && (stored.state === "connected" || stored.state === "partial")) {
        const atProvider = await revokeAtProvider(connection, stored);
        end(stored, packageId, "revoked", atProvider ? "you revoked it in Settings" : "you revoked it in Settings; the provider could not be told");
      }
      return status(packageId, connection);
    },

    async forget(packageId, connection) {
      const stored = getPackageConnection(db, principalId, packageId);
      if (stored === undefined) return;
      if (connection !== undefined && (stored.state === "connected" || stored.state === "partial")) await revokeAtProvider(connection, stored);
      deletePackageConnection(db, principalId, packageId);
      audit({ packageId, provider: stored.provider, outcome: "done", summary: `the ${stored.provider} connection was removed with its package` });
    },
  };
}
