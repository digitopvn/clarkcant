import {
  BROWSER_TOKEN_LIMITS,
  type BrowserTokenDeclaration,
  type BrowserTokenRefusal,
  type BrowserTokenRequest,
} from "@clarkcant/contracts";

/**
 * What a provider can do for a browser-scoped token, and the one check that decides whether a request fits it.
 *
 * An adapter states its provider's support rather than the node assuming it, because the dangerous answer is the
 * default one: a provider whose only credential is the account's own key cannot issue a browser token at all, and an
 * adapter that handed that key to a frame "for now" would be the leak the exception was built to avoid. So an
 * unscoped provider is refused outright, and a scoped one is held to the scopes and lifetime it says it can mint.
 *
 * The request is also held to the package's declaration: a frame may ask for less than its package declared, never
 * for a provider or a scope the person was not shown.
 */

export interface BrowserTokenSupport {
  provider: string;
  /** True only when the provider mints a token narrower than the account: limited scopes, its own expiry. */
  scoped: boolean;
  /** The longest lifetime the provider will mint. The node also caps it at `BROWSER_TOKEN_LIMITS.maxTtlSeconds`. */
  maxTtlSeconds: number;
  /** The scopes the provider can put in a browser token. */
  scopes: readonly string[];
  /** `revocable` when a token can be withdrawn before it expires; `expiry-only` when it simply runs out. */
  revocation: "revocable" | "expiry-only";
}

/** What an adapter mints. `tokenId` is the provider's handle for revoking it, and the only part the node keeps. */
export interface IssuedBrowserToken {
  token: string;
  tokenId: string;
  /** The lifetime the provider actually gave, which the node checks against what it asked for. */
  expiresInSeconds: number;
}

/**
 * One provider's browser-token adapter.
 *
 * `issue` is called only after `checkBrowserTokenRequest` accepted the request. `bindTo` names who the token is for,
 * so a provider that can bind a token to an audience does; one that cannot still gets a token the node binds itself.
 */
export interface BrowserTokenAdapter {
  support: BrowserTokenSupport;
  issue(input: {
    scopes: readonly string[];
    ttlSeconds: number;
    bindTo: { packageId: string; instanceId: string };
    signal: AbortSignal;
  }): Promise<IssuedBrowserToken>;
  /** Present when `support.revocation` is `revocable`. */
  revoke?(tokenId: string, signal: AbortSignal): Promise<void>;
}

export type BrowserTokenCheck =
  | { ok: true; scopes: string[]; ttlSeconds: number }
  | { ok: false; code: BrowserTokenRefusal; message: string };

/**
 * Whether a frame's request may be issued, and with what lifetime.
 *
 * In order of what the person would want to hear first: the package never declared this provider or scope; the
 * provider cannot mint a narrow token; the provider cannot mint this scope; the lifetime asked is longer than allowed.
 * A request is refused rather than narrowed: a widget that asked for a scope and silently got less would fail later,
 * somewhere less clear.
 */
export function checkBrowserTokenRequest(input: {
  support: BrowserTokenSupport | undefined;
  declared: readonly BrowserTokenDeclaration[];
  request: BrowserTokenRequest;
}): BrowserTokenCheck {
  const { request } = input;
  const declaration = input.declared.find((entry) => entry.provider === request.provider);
  if (declaration === undefined) {
    return {
      ok: false,
      code: "TOKEN_PROVIDER_NOT_DECLARED",
      message: `this widget's package did not declare browser tokens from ${request.provider}`,
    };
  }
  const undeclared = request.scopes.filter((scope) => !declaration.scopes.includes(scope));
  if (undeclared.length > 0) {
    return {
      ok: false,
      code: "TOKEN_SCOPE_NOT_DECLARED",
      message: `this widget's package did not declare ${undeclared.join(", ")} for ${request.provider}`,
    };
  }
  const support = input.support;
  if (support === undefined || support.provider !== request.provider) {
    return {
      ok: false,
      code: "TOKEN_PROVIDER_UNAVAILABLE",
      message: `this node has no browser-token adapter for ${request.provider}`,
    };
  }
  if (!support.scoped) {
    return {
      ok: false,
      code: "TOKEN_PROVIDER_UNSCOPED",
      message: `${request.provider} cannot issue a token narrower than the account, so none is given to a widget`,
    };
  }
  const unsupported = request.scopes.filter((scope) => !support.scopes.includes(scope));
  if (unsupported.length > 0) {
    return {
      ok: false,
      code: "TOKEN_SCOPE_NOT_SUPPORTED",
      message: `${request.provider} cannot put ${unsupported.join(", ")} in a browser token`,
    };
  }
  const ceiling = Math.min(support.maxTtlSeconds, BROWSER_TOKEN_LIMITS.maxTtlSeconds);
  if (request.ttlSeconds !== undefined && request.ttlSeconds > ceiling) {
    return {
      ok: false,
      code: "TOKEN_TTL_TOO_LONG",
      message: `a ${request.provider} browser token lives at most ${String(ceiling)} seconds`,
    };
  }
  if (ceiling < BROWSER_TOKEN_LIMITS.minTtlSeconds) {
    return {
      ok: false,
      code: "TOKEN_PROVIDER_UNAVAILABLE",
      message: `${request.provider} reports a maximum token lifetime too short to use`,
    };
  }
  return {
    ok: true,
    scopes: [...new Set(request.scopes)],
    ttlSeconds: request.ttlSeconds ?? Math.min(BROWSER_TOKEN_LIMITS.defaultTtlSeconds, ceiling),
  };
}
