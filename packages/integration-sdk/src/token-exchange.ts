import { validateEndpoint, verifyScopes, verifyState } from "./index.ts";
import type { ConnectionDescriptor, ScopeVerification } from "./index.ts";

/**
 * The authorization-code exchange and the refresh loop.
 *
 * PKCE generation, the S256 challenge, state comparison, scope verification and endpoint validation were already
 * real here; what was missing was the step that turns a code into a token. It is built against an injected `fetch`
 * so a test can drive it end to end against a local endpoint — and so the honest boundary stays visible: this is
 * the machinery of a token exchange, exercised against an endpoint this repository runs, not a token from any
 * provider's account.
 *
 * Two orderings in here are the whole point, and both are about what must not happen:
 *
 * 1. **The state is compared before the code is sent.** A code that arrived with the wrong state may belong to
 *    somebody else's authorization request. Sending it anyway to find out would hand a stranger's code to the
 *    provider under this client's identity.
 * 2. **The endpoint is validated before anything is sent.** A token request carries the code, the verifier and the
 *    client id; a request built first and checked afterwards has already leaked them.
 */

export const TOKEN_EXCHANGE_STATUS = "implemented-against-injected-endpoint";

export interface TokenGrant {
  accessToken: string;
  /** Absent when the provider did not issue one; the connection then cannot be refreshed silently. */
  refreshToken: string | undefined;
  expiresInSeconds: number | undefined;
  /** What the provider actually granted, compared against what was asked for. */
  scopes: ScopeVerification;
}

export type TokenExchangeResult =
  | { ok: true; grant: TokenGrant; endpointOrigin: string }
  | {
      ok: false;
      code: "STATE_MISMATCH" | "ENDPOINT_REFUSED" | "EXCHANGE_FAILED" | "TIMED_OUT" | "INVALID_RESPONSE";
      message: string;
    };

interface TokenEndpointCall {
  endpoint: string;
  allowedOrigins: readonly string[];
  clientId: string;
  /** Injected so a test can drive a local endpoint and nothing here opens a socket of its own. */
  fetchImpl: typeof fetch;
  /** Bounded, because a token endpoint that never answers must not hold a connection open forever. */
  timeoutMs?: number;
}

export interface TokenExchangeInput extends TokenEndpointCall {
  redirectUri: string;
  code: string;
  /** The PKCE verifier whose S256 challenge travelled with the authorization request. */
  verifier: string;
  /** The state this node issued, and the state that came back. */
  expectedState: string;
  receivedState: string;
  descriptor: Pick<ConnectionDescriptor, "requestedScopes" | "optionalScopes">;
}

export interface RefreshInput extends TokenEndpointCall {
  refreshToken: string;
  descriptor: Pick<ConnectionDescriptor, "requestedScopes" | "optionalScopes">;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Send a form-encoded token request and read the grant out of it.
 *
 * Form-encoded rather than JSON because that is what RFC 6749 specifies, and in the body rather than in the query
 * string because a URL is logged by everything it passes through while a body is not.
 */
async function requestGrant(
  shape: TokenEndpointCall,
  form: Record<string, string>,
  descriptor: Pick<ConnectionDescriptor, "requestedScopes" | "optionalScopes">,
): Promise<TokenExchangeResult> {
  const endpoint = validateEndpoint({ url: shape.endpoint, allowedOrigins: shape.allowedOrigins });
  if (!endpoint.ok) {
    return { ok: false, code: "ENDPOINT_REFUSED", message: endpoint.reason };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, shape.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await shape.fetchImpl(shape.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
      // A redirect would carry the code and the verifier to whatever the Location header names, so none is followed.
      redirect: "error",
    });
  } catch (cause) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      return { ok: false, code: "TIMED_OUT", message: "the token endpoint did not answer in time" };
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, code: "EXCHANGE_FAILED", message: `the token endpoint could not be reached: ${detail}` };
  }
  clearTimeout(timer);

  if (!response.ok) {
    // The status is reported and the body is not: a failed token response can echo the code back, and an error
    // message is exactly the kind of string that ends up in a log.
    return {
      ok: false,
      code: "EXCHANGE_FAILED",
      message: `the token endpoint answered ${String(response.status)}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, code: "INVALID_RESPONSE", message: "the token endpoint did not answer with JSON" };
  }

  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const accessToken = typeof record.access_token === "string" ? record.access_token : "";
  if (accessToken === "") {
    // A 200 with no token is not a connection. Reporting success here is how "authorization succeeded" comes to be
    // presented as "integration works".
    return { ok: false, code: "INVALID_RESPONSE", message: "the token endpoint answered without an access token" };
  }

  /*
   * The provider returns what it decided, not what was asked for. When it says nothing about scopes, the request is
   * treated as fully granted rather than as denied: silence is not a refusal, and inventing a denial would make
   * every provider that omits the field look like it refused.
   */
  const grantedScopes = typeof record.scope === "string" ? record.scope.split(" ").filter((scope) => scope !== "") : null;

  return {
    ok: true,
    endpointOrigin: endpoint.origin,
    grant: {
      accessToken,
      refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : undefined,
      expiresInSeconds: typeof record.expires_in === "number" ? record.expires_in : undefined,
      scopes:
        grantedScopes === null
          ? { granted: [...descriptor.requestedScopes], missingRequired: [], missingOptional: [], status: "full" }
          : verifyScopes(descriptor, grantedScopes),
    },
  };
}

/**
 * Exchange an authorization code for a token.
 *
 * The state is compared first, and a mismatch returns before the endpoint is even validated — the code must not
 * travel, and neither must the request that would carry it.
 */
export async function exchangeAuthorizationCode(input: TokenExchangeInput): Promise<TokenExchangeResult> {
  if (!verifyState(input.expectedState, input.receivedState)) {
    return {
      ok: false,
      code: "STATE_MISMATCH",
      message: "the authorization response carried a state this node did not issue, so the code was not sent",
    };
  }

  return await requestGrant(
    input,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
    },
    input.descriptor,
  );
}

/**
 * Exchange a refresh token for a new access token.
 *
 * No state comparison here: there is no authorization response, and the refresh token is the whole proof. What
 * carries over is that the endpoint is validated before anything is sent.
 */
export async function refreshAccessToken(input: RefreshInput): Promise<TokenExchangeResult> {
  return await requestGrant(
    input,
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    },
    input.descriptor,
  );
}
