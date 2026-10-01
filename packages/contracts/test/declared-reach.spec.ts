import { describe, expect, it } from "vitest";

import {
  declaredReachIsEmpty,
  declaredReachMismatch,
  declaredReachOf,
  declaredReachSchema,
  directoryEntrySchema,
  type ReachFacet,
} from "../src/index.ts";

const service: ReachFacet = {
  kind: "tools",
  egress: {
    version: 1,
    secrets: [{ name: "LOOKUP_API_KEY", purpose: "Signs the lookups in." }],
    origins: [
      { origin: "https://b.example.com", purpose: "Looks words up.", credential: { secret: "LOOKUP_API_KEY", header: "authorization", scheme: "bearer" } },
      { origin: "https://a.example.com", purpose: "Reads public word lists." },
    ],
  },
};
const frame: ReachFacet = {
  kind: "ui",
  browserTokens: {
    version: 1,
    providers: [{ provider: "example.maps", scopes: ["tiles:read", "geocode:read"], purpose: "Draws the map." }],
  },
};

describe("the reach a manifest declares", () => {
  it("collects each origin with the key it is sent, each key with its purpose, and each token provider with its scopes", () => {
    expect(declaredReachOf({ facets: [frame, service, { kind: "theme" }] })).toEqual({
      origins: [
        { origin: "https://a.example.com", purpose: "Reads public word lists." },
        { origin: "https://b.example.com", purpose: "Looks words up.", secret: "LOOKUP_API_KEY" },
      ],
      secrets: [{ name: "LOOKUP_API_KEY", purpose: "Signs the lookups in." }],
      browserTokens: [{ provider: "example.maps", scopes: ["geocode:read", "tiles:read"], purpose: "Draws the map." }],
    });
  });

  it("names the header's secret only, never the header or the scheme the host sends it with", () => {
    const [origin] = declaredReachOf({ facets: [service] }).origins.filter((entry) => entry.secret !== undefined);
    expect(Object.keys(origin ?? {}).sort()).toEqual(["origin", "purpose", "secret"]);
  });

  it("lists an origin two facets reach once, and keeps both purposes when they differ", () => {
    const again: ReachFacet = {
      kind: "tools",
      egress: { version: 1, secrets: [], origins: [{ origin: "https://a.example.com", purpose: "Reads public word lists." }] },
    };
    const other: ReachFacet = {
      kind: "tools",
      egress: { version: 1, secrets: [], origins: [{ origin: "https://a.example.com", purpose: "Checks spelling." }] },
    };
    expect(declaredReachOf({ facets: [service, again, other] }).origins.map((entry) => entry.purpose)).toEqual([
      "Checks spelling.",
      "Reads public word lists.",
      "Looks words up.",
    ]);
  });

  it("is empty for a package that reaches nothing", () => {
    expect(declaredReachIsEmpty(declaredReachOf({ facets: [{ kind: "ui" }] }))).toBe(true);
    expect(declaredReachIsEmpty(declaredReachOf({ facets: [frame] }))).toBe(false);
  });
});

describe("whether a listing showed what the package declares", () => {
  const declared = declaredReachOf({ facets: [service, frame] });

  it("agrees with the same reach in another order", () => {
    const listed = {
      origins: [...declared.origins].reverse(),
      secrets: declared.secrets,
      browserTokens: declared.browserTokens.map((entry) => ({ ...entry, scopes: [...entry.scopes].reverse() })),
    };
    expect(declaredReachMismatch(listed, declared)).toBeUndefined();
    expect(declaredReachMismatch(undefined, declaredReachOf({ facets: [] }))).toBeUndefined();
  });

  it("names what differs: a listing that says nothing, a missing origin, another purpose, a missing scope", () => {
    expect(declaredReachMismatch(undefined, declared)).toBe(
      "the listing does not show the origins it reaches, the secrets it needs, the browser tokens it asks for as the package declares them",
    );
    expect(declaredReachMismatch({ ...declared, origins: declared.origins.slice(1) }, declared)).toContain("the origins it reaches");
    expect(
      declaredReachMismatch({ ...declared, secrets: [{ name: "LOOKUP_API_KEY", purpose: "Something else." }] }, declared),
    ).toBe("the listing does not show the secrets it needs as the package declares them");
    expect(
      declaredReachMismatch(
        { ...declared, browserTokens: [{ provider: "example.maps", scopes: ["tiles:read"], purpose: "Draws the map." }] },
        declared,
      ),
    ).toBe("the listing does not show the browser tokens it asks for as the package declares them");
    // An origin listed without the key the package sends it is a different reach.
    expect(
      declaredReachMismatch(
        { ...declared, origins: declared.origins.map(({ origin, purpose }) => ({ origin, purpose })) },
        declared,
      ),
    ).toContain("the origins it reaches");
  });
});

describe("the reach a directory entry carries", () => {
  const entry = {
    packageId: "com.example.lookup",
    version: "1.0.0",
    displayName: "Lookup",
    description: "Looks words up.",
    source: { kind: "local", path: "/packages/lookup" },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui", "tools"],
    isolations: [
      { facetKind: "ui", isolation: "isolated-ui" },
      { facetKind: "tools", isolation: "service" },
    ],
    platforms: ["web"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "service",
    sizeBytes: 1,
    digest: "sha256:lookup",
  };

  it("is optional, and accepted when it is a reach", () => {
    expect(directoryEntrySchema.safeParse(entry).success).toBe(true);
    expect(directoryEntrySchema.safeParse({ ...entry, declaredReach: declaredReachOf({ facets: [service, frame] }) }).success).toBe(true);
  });

  it("has no place for a key's value, and refuses a malformed origin or provider", () => {
    const withValue = { origins: [], browserTokens: [], secrets: [{ name: "LOOKUP_API_KEY", purpose: "Signs.", value: "fake" }] };
    expect(declaredReachSchema.safeParse(withValue).success).toBe(false);
    expect(directoryEntrySchema.safeParse({ ...entry, declaredReach: withValue }).success).toBe(false);
    expect(
      declaredReachSchema.safeParse({ origins: [{ origin: "https://a.example.com/path", purpose: "x" }], secrets: [], browserTokens: [] })
        .success,
    ).toBe(false);
    expect(
      declaredReachSchema.safeParse({ origins: [], secrets: [], browserTokens: [{ provider: "Not A Provider", scopes: ["a"], purpose: "x" }] })
        .success,
    ).toBe(false);
  });
});
