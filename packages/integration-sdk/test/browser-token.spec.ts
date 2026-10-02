import { describe, expect, it } from "vitest";

import { type BrowserTokenSupport, checkBrowserTokenRequest } from "../src/index.ts";

const SCOPED: BrowserTokenSupport = {
  provider: "example.maps",
  scoped: true,
  maxTtlSeconds: 600,
  scopes: ["tiles:read", "geocode:read"],
  revocation: "revocable",
};
const DECLARED = [{ provider: "example.maps", scopes: ["tiles:read"], purpose: "Draw the map" }];

describe("checkBrowserTokenRequest", () => {
  it("issues a declared, supported scope with the default lifetime capped by the provider", () => {
    expect(
      checkBrowserTokenRequest({ support: SCOPED, declared: DECLARED, request: { provider: "example.maps", scopes: ["tiles:read"] } }),
    ).toEqual({ ok: true, scopes: ["tiles:read"], ttlSeconds: 600 });
    expect(
      checkBrowserTokenRequest({
        support: { ...SCOPED, maxTtlSeconds: 3_000 },
        declared: DECLARED,
        request: { provider: "example.maps", scopes: ["tiles:read"], ttlSeconds: 120 },
      }),
    ).toEqual({ ok: true, scopes: ["tiles:read"], ttlSeconds: 120 });
  });

  it("refuses a provider or a scope the package never declared, before asking the provider anything", () => {
    expect(
      checkBrowserTokenRequest({ support: SCOPED, declared: [], request: { provider: "example.maps", scopes: ["tiles:read"] } }),
    ).toMatchObject({ ok: false, code: "TOKEN_PROVIDER_NOT_DECLARED" });
    // Supported by the provider, but not something the person was shown.
    expect(
      checkBrowserTokenRequest({ support: SCOPED, declared: DECLARED, request: { provider: "example.maps", scopes: ["geocode:read"] } }),
    ).toMatchObject({ ok: false, code: "TOKEN_SCOPE_NOT_DECLARED", message: expect.stringContaining("geocode:read") });
  });

  it("refuses an unscoped provider outright rather than handing out the account's credential", () => {
    expect(
      checkBrowserTokenRequest({
        support: { ...SCOPED, scoped: false },
        declared: DECLARED,
        request: { provider: "example.maps", scopes: ["tiles:read"] },
      }),
    ).toMatchObject({ ok: false, code: "TOKEN_PROVIDER_UNSCOPED" });
  });

  it("refuses a request broader than the provider can mint, rather than narrowing it", () => {
    const declared = [{ provider: "example.maps", scopes: ["tiles:read", "tiles:write"], purpose: "Edit the map" }];
    expect(
      checkBrowserTokenRequest({ support: SCOPED, declared, request: { provider: "example.maps", scopes: ["tiles:read", "tiles:write"] } }),
    ).toMatchObject({ ok: false, code: "TOKEN_SCOPE_NOT_SUPPORTED", message: expect.stringContaining("tiles:write") });
    expect(
      checkBrowserTokenRequest({ support: SCOPED, declared: DECLARED, request: { provider: "example.maps", scopes: ["tiles:read"], ttlSeconds: 601 } }),
    ).toMatchObject({ ok: false, code: "TOKEN_TTL_TOO_LONG" });
    // The node's own ceiling holds even when a provider claims more.
    expect(
      checkBrowserTokenRequest({
        support: { ...SCOPED, maxTtlSeconds: 86_400 },
        declared: DECLARED,
        request: { provider: "example.maps", scopes: ["tiles:read"], ttlSeconds: 3_601 },
      }),
    ).toMatchObject({ ok: false, code: "TOKEN_TTL_TOO_LONG" });
  });

  it("says when this node has no adapter for the provider", () => {
    expect(
      checkBrowserTokenRequest({ support: undefined, declared: DECLARED, request: { provider: "example.maps", scopes: ["tiles:read"] } }),
    ).toMatchObject({ ok: false, code: "TOKEN_PROVIDER_UNAVAILABLE" });
    expect(
      checkBrowserTokenRequest({
        support: { ...SCOPED, provider: "other.maps" },
        declared: DECLARED,
        request: { provider: "example.maps", scopes: ["tiles:read"] },
      }),
    ).toMatchObject({ ok: false, code: "TOKEN_PROVIDER_UNAVAILABLE" });
  });
});
