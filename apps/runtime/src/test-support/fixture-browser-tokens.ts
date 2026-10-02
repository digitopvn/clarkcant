import { randomBytes } from "node:crypto";

import type { BrowserTokenAdapter } from "@clarkcant/integration-sdk";

/**
 * Browser-token providers that live inside this process, for journeys that need a token without a provider account.
 *
 * Two providers, one for each answer that matters:
 *
 * - `fixture.maps` mints scoped, revocable tokens for `tiles:read` and `geocode:read`, at most ten minutes long.
 * - `fixture.unscoped` stands for a provider whose only credential is the account's key: it says so, and the broker
 *   refuses it without ever calling `issue`.
 *
 * The values are random and generated here, never a real credential. `issued()` hands them back — only to the fixture
 * route, only on a node started with `CC_BROWSER_TOKEN_FIXTURE=1` — so a journey can search the page, the stored
 * state and the node's records for a value it knows, and prove it is not there. It says "fixture" in every token so a
 * screenshot cannot pass one off as a provider's.
 */

export interface FixtureIssuedToken {
  provider: string;
  tokenId: string;
  token: string;
  scopes: readonly string[];
  instanceId: string;
  revoked: boolean;
}

export interface BrowserTokenFixture {
  adapters: readonly BrowserTokenAdapter[];
  issued(): readonly FixtureIssuedToken[];
}

/** The fixture keeps the latest tokens it minted; a journey only ever needs a handful. */
const MAX_REMEMBERED = 64;

export function createBrowserTokenFixture(): BrowserTokenFixture {
  const issued: FixtureIssuedToken[] = [];
  const maps: BrowserTokenAdapter = {
    support: { provider: "fixture.maps", scoped: true, maxTtlSeconds: 600, scopes: ["tiles:read", "geocode:read"], revocation: "revocable" },
    issue: async ({ scopes, ttlSeconds, bindTo }) => {
      const tokenId = `fxt_${randomBytes(6).toString("hex")}`;
      const token = `fixture-browser-token-${randomBytes(18).toString("hex")}`;
      issued.push({ provider: "fixture.maps", tokenId, token, scopes: [...scopes], instanceId: bindTo.instanceId, revoked: false });
      if (issued.length > MAX_REMEMBERED) issued.splice(0, issued.length - MAX_REMEMBERED);
      return { token, tokenId, expiresInSeconds: ttlSeconds };
    },
    revoke: async (tokenId) => {
      const entry = issued.find((candidate) => candidate.tokenId === tokenId);
      if (entry !== undefined) entry.revoked = true;
    },
  };
  const unscoped: BrowserTokenAdapter = {
    support: { provider: "fixture.unscoped", scoped: false, maxTtlSeconds: 600, scopes: ["everything"], revocation: "expiry-only" },
    issue: () => Promise.reject(new Error("an unscoped provider is never asked for a browser token")),
  };
  return { adapters: [maps, unscoped], issued: () => issued.map((entry) => ({ ...entry })) };
}
