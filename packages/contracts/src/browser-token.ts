import { z } from "zod";

/**
 * Browser-scoped provider tokens: the one exception to "a widget never holds a provider credential".
 *
 * Some providers are only usable from the browser itself (a map's tile layer, a player SDK) and accept a short-lived
 * token that is narrower than the account it comes from. A UI facet may declare that it needs such a token, from a
 * named provider, for named scopes and a stated purpose. The node issues one only when the provider's adapter says it
 * can mint a token that narrow; an unscoped provider is refused, never handed the account's own key.
 *
 * A token issued under this declaration is bound to one widget instance and one frame session, lives at most
 * `BROWSER_TOKEN_LIMITS.maxTtlSeconds`, and is revoked where the provider supports it when the frame goes away or the
 * package is uninstalled. The node keeps the provider's id for the token, never its value, and the host refuses to let
 * the value leave the frame again: not into widget state, a semantic publish, or an action's input.
 */

export const BROWSER_TOKEN_VERSION = 1;

export const BROWSER_TOKEN_LIMITS = Object.freeze({
  /** Providers one UI facet may declare. */
  providers: 8,
  /** Scopes one declaration, or one request, may name. */
  scopes: 16,
  /** The longest a browser token may live, whatever a provider supports. */
  maxTtlSeconds: 3_600,
  /** What a request that names no lifetime is given, capped by the provider's own maximum. */
  defaultTtlSeconds: 900,
  /** The shortest lifetime a request may ask for. */
  minTtlSeconds: 30,
});

/** A provider id as an adapter registers it: lowercase, dot-separated, such as `fixture.maps`. */
export const browserTokenProviderSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/, { error: "must be a lowercase provider id such as example.maps" });

/** One provider scope, as the provider spells it. */
export const browserTokenScopeSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/, { error: "must be a scope of letters, digits and : . _ / -" });

/** One provider a UI facet needs a browser token from, and why. */
export const browserTokenDeclarationSchema = z.strictObject({
  provider: browserTokenProviderSchema,
  scopes: z.array(browserTokenScopeSchema).min(1).max(BROWSER_TOKEN_LIMITS.scopes),
  /** Shown to the person with the package's other permissions. */
  purpose: z.string().min(1).max(300),
});
export type BrowserTokenDeclaration = z.infer<typeof browserTokenDeclarationSchema>;

/** The `browserTokens` field of a UI facet. */
export const browserTokensSchema = z.strictObject({
  version: z.literal(BROWSER_TOKEN_VERSION),
  providers: z.array(browserTokenDeclarationSchema).min(1).max(BROWSER_TOKEN_LIMITS.providers),
});
export type BrowserTokens = z.infer<typeof browserTokensSchema>;

/** What is wrong with a declaration beyond its shape: a provider or a scope named twice. */
export function browserTokensProblems(declaration: BrowserTokens): string[] {
  const problems: string[] = [];
  const providers = new Set<string>();
  for (const entry of declaration.providers) {
    if (providers.has(entry.provider)) problems.push(`provider ${entry.provider} is declared twice`);
    providers.add(entry.provider);
    const scopes = new Set<string>();
    for (const scope of entry.scopes) {
      if (scopes.has(scope)) problems.push(`provider ${entry.provider} names the scope ${scope} twice`);
      scopes.add(scope);
    }
  }
  return problems;
}

/** What a frame asks for. Every field is checked again against the declaration and the provider's support. */
export const browserTokenRequestSchema = z.strictObject({
  provider: browserTokenProviderSchema,
  scopes: z.array(browserTokenScopeSchema).min(1).max(BROWSER_TOKEN_LIMITS.scopes),
  ttlSeconds: z.int().min(BROWSER_TOKEN_LIMITS.minTtlSeconds).max(BROWSER_TOKEN_LIMITS.maxTtlSeconds).optional(),
});
export type BrowserTokenRequest = z.infer<typeof browserTokenRequestSchema>;

/** A frame session id: random, chosen by the host chrome that mounted the frame, never by the widget. */
export const browserTokenSessionSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

/** The route's body: which frame session the token is for, and what it asks. */
export const browserTokenIssueBodySchema = z.strictObject({
  session: browserTokenSessionSchema,
  request: browserTokenRequestSchema,
});

/** What a frame is given. `token` is the value; it is shown to the frame and nowhere else. */
export interface BrowserTokenGrant {
  provider: string;
  token: string;
  scopes: string[];
  expiresAt: string;
}

/** Why a token was not issued. Stable codes, so a widget can tell "not declared" from "provider unavailable". */
export const BROWSER_TOKEN_REFUSALS = [
  "TOKEN_PROVIDER_NOT_DECLARED",
  "TOKEN_SCOPE_NOT_DECLARED",
  "TOKEN_PROVIDER_UNAVAILABLE",
  "TOKEN_PROVIDER_UNSCOPED",
  "TOKEN_SCOPE_NOT_SUPPORTED",
  "TOKEN_TTL_TOO_LONG",
  "TOKEN_SESSION_ENDED",
  "TOKEN_ISSUE_FAILED",
] as const;
export type BrowserTokenRefusal = (typeof BROWSER_TOKEN_REFUSALS)[number];
