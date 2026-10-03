import { describe, expect, it } from "vitest";

import {
  compareReach,
  declaredResourcesMismatch,
  directoryEntrySchema,
  reachChangeSchema,
  reachSnapshotOfListing,
  reachSnapshotOfManifest,
  type DeclaredReach,
  type ReachSnapshot,
} from "../src/index.ts";

const NONE: DeclaredReach = { origins: [], secrets: [], browserTokens: [] };

function snapshot(reach: Partial<DeclaredReach>, profile: ReachSnapshot["profile"] = "interactive-light"): ReachSnapshot {
  return { reach: { ...NONE, ...reach }, profile };
}

const lookup = { origin: "https://lookup.example.com", purpose: "Looks words up.", secret: "LOOKUP_API_KEY" };
const lists = { origin: "https://lists.example.com", purpose: "Reads public word lists." };
const key = { name: "LOOKUP_API_KEY", purpose: "Signs the lookups in." };
const maps = (scopes: string[]) => ({ provider: "example.maps", scopes, purpose: "Draws the map." });
const crm = (scopes: string[], endpoints: string[]) => ({
  provider: "example.crm",
  displayName: "Example CRM",
  scopes: scopes.map((scope) => ({ scope, purpose: "Reads the contacts." })),
  endpoints,
});

describe("what an update changes in what a package reaches", () => {
  it("is unchanged for the same reach and profile, whatever order the declarations are in", () => {
    const change = compareReach(
      snapshot({ origins: [lookup, lists], secrets: [key], browserTokens: [maps(["tiles:read", "geocode:read"])] }),
      snapshot({ origins: [lists, lookup], secrets: [key], browserTokens: [maps(["geocode:read", "tiles:read"])] }),
    );
    expect(change).toEqual({
      verdict: "unchanged",
      origins: { added: [], removed: [] },
      secrets: { added: [], removed: [] },
      browserTokens: { added: [], removed: [] },
      connectionScopes: { added: [], removed: [] },
      connectionEndpoints: { added: [], removed: [] },
    });
    expect(reachChangeSchema.safeParse(change).success).toBe(true);
  });

  it("is unchanged when only the words of a purpose change", () => {
    const change = compareReach(snapshot({ origins: [lists] }), snapshot({ origins: [{ ...lists, purpose: "Reads the lists." }] }));
    expect(change.verdict).toBe("unchanged");
  });

  it("is wider when an origin, a key, a token scope or an account scope is added, and names exactly what was added", () => {
    const change = compareReach(
      snapshot({ origins: [lists], browserTokens: [maps(["tiles:read"])], connections: [crm(["contacts.read"], ["https://api.crm.example.com"])] }),
      snapshot({
        origins: [lists, lookup],
        secrets: [key],
        browserTokens: [maps(["tiles:read", "geocode:read"])],
        connections: [crm(["contacts.read", "contacts.write"], ["https://api.crm.example.com"])],
      }),
    );
    expect(change.verdict).toBe("wider");
    expect(change.origins).toEqual({ added: [{ origin: lookup.origin, purpose: lookup.purpose }], removed: [] });
    expect(change.secrets).toEqual({ added: [key], removed: [] });
    expect(change.browserTokens).toEqual({ added: [{ provider: "example.maps", scope: "geocode:read" }], removed: [] });
    expect(change.connectionScopes).toEqual({ added: [{ provider: "example.crm", scope: "contacts.write" }], removed: [] });
    expect(change.connectionEndpoints).toEqual({ added: [], removed: [] });
    expect(change.profile).toBeUndefined();
  });

  it("is wider when a profile raises any limit, and lists each limit that changed with both values", () => {
    const change = compareReach(snapshot({}), snapshot({}, "media-workstation"));
    expect(change.verdict).toBe("wider");
    expect(change.profile?.from).toBe("interactive-light");
    expect(change.profile?.to).toBe("media-workstation");
    expect(change.profile?.limits).toContainEqual({ limit: "memoryMib", from: 256, to: 4096 });
    expect(change.profile?.limits).toContainEqual({ limit: "cpus", from: 1, to: 4 });
    expect(change.profile?.limits).toContainEqual({ limit: "maxActiveJobs", from: 4, to: 1 });
    expect(change.profile?.offscreen).toEqual({ from: "suspend", to: "authorized-playback" });
    // A limit both profiles share is not listed.
    expect(change.profile?.limits.map((entry) => entry.limit)).not.toContain("artifactMaxBytes");
  });

  it("does not rank profiles: either way between media-workstation and background-compute is wider", () => {
    const toBackground = compareReach(snapshot({}, "media-workstation"), snapshot({}, "background-compute"));
    const toMedia = compareReach(snapshot({}, "background-compute"), snapshot({}, "media-workstation"));
    expect(toBackground.verdict).toBe("wider");
    expect(toBackground.profile?.limits).toContainEqual({ limit: "jobDeadlineMs", from: 2 * 60 * 60_000, to: 4 * 60 * 60_000 });
    expect(toBackground.profile?.limits).toContainEqual({ limit: "memoryMib", from: 4096, to: 2048 });
    expect(toMedia.verdict).toBe("wider");
    expect(toMedia.profile?.limits).toContainEqual({ limit: "memoryMib", from: 2048, to: 4096 });
  });

  it("is narrower when something is only removed or lowered", () => {
    const change = compareReach(
      snapshot({ origins: [lists, lookup], secrets: [key], browserTokens: [maps(["tiles:read", "geocode:read"])] }),
      snapshot({ origins: [lists], browserTokens: [maps(["tiles:read"])] }),
    );
    expect(change.verdict).toBe("narrower");
    expect(change.origins.removed).toEqual([{ origin: lookup.origin, purpose: lookup.purpose }]);
    expect(change.secrets.removed).toEqual([key]);
    expect(change.browserTokens.removed).toEqual([{ provider: "example.maps", scope: "geocode:read" }]);
    expect(change.origins.added).toEqual([]);
  });

  it("counts every limit on its own: a smaller profile that runs more jobs at once is still wider", () => {
    const change = compareReach(snapshot({}, "interactive-heavy"), snapshot({}, "interactive-light"));
    expect(change.verdict).toBe("wider");
    expect(change.profile?.limits).toContainEqual({ limit: "maxActiveJobs", from: 2, to: 4 });
    expect(change.profile?.limits).toContainEqual({ limit: "memoryMib", from: 1024, to: 256 });
  });

  it("is narrower when an origin is removed and nothing else changes", () => {
    const change = compareReach(snapshot({ origins: [lists, lookup] }), snapshot({ origins: [lists] }));
    expect(change.verdict).toBe("narrower");
  });

  it("is wider when a change adds one thing and removes another, and lists both", () => {
    const change = compareReach(
      snapshot({ origins: [lists], connections: [crm(["contacts.read"], ["https://api.crm.example.com"])] }),
      snapshot({ origins: [lookup], connections: [crm(["contacts.read"], ["https://eu.crm.example.com"])] }),
    );
    expect(change.verdict).toBe("wider");
    expect(change.origins).toEqual({
      added: [{ origin: lookup.origin, purpose: lookup.purpose }],
      removed: [{ origin: lists.origin, purpose: lists.purpose }],
    });
    expect(change.connectionEndpoints).toEqual({
      added: [{ provider: "example.crm", endpoint: "https://eu.crm.example.com" }],
      removed: [{ provider: "example.crm", endpoint: "https://api.crm.example.com" }],
    });
  });
});

describe("the reach of a listing and of a manifest", () => {
  it("reads an absent listing reach and profile as none and the default profile", () => {
    expect(reachSnapshotOfListing({})).toEqual({ reach: NONE, profile: "interactive-light" });
    expect(reachSnapshotOfListing({ resources: { version: 1, profile: "background-compute" } }).profile).toBe("background-compute");
    expect(reachSnapshotOfManifest({ facets: [], resources: { version: 1, profile: "media-workstation" } }).profile).toBe("media-workstation");
  });

  it("lets a listing state the profile it requests, and only as a host profile name", () => {
    const entry = {
      packageId: "com.example.render",
      version: "1.0.0",
      displayName: "Render",
      description: "Renders.",
      source: { kind: "local", path: "/tmp/render" },
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
      preview: {},
      facets: ["tools"],
      isolations: [{ facetKind: "tools", isolation: "service" }],
      platforms: ["web"],
      hostApi: { min: 1, max: 1 },
      permissionsSummary: [],
      riskTier: "service",
      sizeBytes: 1,
      digest: "sha256:x",
    };
    expect(directoryEntrySchema.safeParse({ ...entry, resources: { version: 1, profile: "background-compute" } }).success).toBe(true);
    expect(directoryEntrySchema.safeParse({ ...entry, resources: { version: 1, profile: "background-compute", memoryMib: 1 } }).success).toBe(false);
  });

  it("finds a listing's profile that is not the one the package requests, absent meaning the default", () => {
    expect(declaredResourcesMismatch(undefined, undefined)).toBeUndefined();
    expect(declaredResourcesMismatch(undefined, { version: 1, profile: "interactive-light" })).toBeUndefined();
    expect(declaredResourcesMismatch({ version: 1, profile: "media-workstation" }, { version: 1, profile: "media-workstation" })).toBeUndefined();
    expect(declaredResourcesMismatch(undefined, { version: 1, profile: "media-workstation" })).toMatch(/interactive-light.*media-workstation/);
    expect(declaredResourcesMismatch({ version: 1, profile: "media-workstation" }, { version: 1, profile: "media-workstation", gpu: true })).toMatch(/GPU/);
  });
});
