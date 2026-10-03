import { describe, expect, it } from "vitest";

import {
  REACH_CHANGE_LIST_MAX,
  compareReach,
  declaredResourcesMismatch,
  directoryEntrySchema,
  inboxResponseSchema,
  reachChangeSchema,
  reachChangeViewSchema,
  reachSnapshotOfListing,
  reachSnapshotOfManifest,
  type DeclaredReach,
  type ReachSnapshot,
} from "../src/index.ts";

const NONE: DeclaredReach = { origins: [], secrets: [], browserTokens: [] };

function snapshot(reach: Partial<DeclaredReach>, profile: ReachSnapshot["profile"] = "interactive-light", gpu = false): ReachSnapshot {
  return { reach: { ...NONE, ...reach }, profile, gpu };
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
      keyDestinations: { added: [], removed: [] },
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

describe("where an update sends a key", () => {
  const a = { origin: "https://a.example.com", purpose: "Reads A." };
  const b = { origin: "https://b.example.com", purpose: "Reads B." };
  const x = { name: "X_KEY", purpose: "Signs requests in." };

  it("is wider when a key moves to another origin, even though the origins and the keys are the same sets", () => {
    const change = compareReach(
      snapshot({ origins: [{ ...a, secret: "X_KEY" }, b], secrets: [x] }),
      snapshot({ origins: [a, { ...b, secret: "X_KEY" }], secrets: [x] }),
    );
    expect(change.verdict).toBe("wider");
    expect(change.origins).toEqual({ added: [], removed: [] });
    expect(change.secrets).toEqual({ added: [], removed: [] });
    expect(change.keyDestinations).toEqual({
      added: [{ name: "X_KEY", origin: b.origin }],
      removed: [{ name: "X_KEY", origin: a.origin }],
    });
  });

  it("is wider when a key is also sent to one more origin, and says it is sent there as well", () => {
    const change = compareReach(
      snapshot({ origins: [{ ...a, secret: "X_KEY" }, b], secrets: [x] }),
      snapshot({ origins: [{ ...a, secret: "X_KEY" }, { ...b, secret: "X_KEY" }], secrets: [x] }),
    );
    expect(change.verdict).toBe("wider");
    expect(change.keyDestinations).toEqual({ added: [{ name: "X_KEY", origin: b.origin, also: true }], removed: [] });
  });

  it("is narrower when a key stops going to an origin it went to", () => {
    const change = compareReach(snapshot({ origins: [{ ...a, secret: "X_KEY" }], secrets: [x] }), snapshot({ origins: [a], secrets: [x] }));
    expect(change.verdict).toBe("narrower");
    expect(change.keyDestinations).toEqual({ added: [], removed: [{ name: "X_KEY", origin: a.origin }] });
  });
});

describe("a GPU request", () => {
  it("is wider when an update starts asking for a GPU, with the same profile", () => {
    const change = compareReach(snapshot({}, "media-workstation"), snapshot({}, "media-workstation", true));
    expect(change.verdict).toBe("wider");
    expect(change.gpu).toEqual({ from: false, to: true });
    expect(change.profile).toBeUndefined();
  });

  it("is narrower when it stops asking for one, and absent when neither asks", () => {
    expect(compareReach(snapshot({}, "media-workstation", true), snapshot({}, "media-workstation")).verdict).toBe("narrower");
    expect(compareReach(snapshot({}), snapshot({}))).not.toHaveProperty("gpu");
  });

  it("is read from a listing and from a manifest", () => {
    expect(reachSnapshotOfListing({ resources: { version: 1, profile: "media-workstation", gpu: true } }).gpu).toBe(true);
    expect(reachSnapshotOfManifest({ facets: [], resources: { version: 1, profile: "media-workstation" } }).gpu).toBe(false);
  });
});

describe("a change larger than one list holds", () => {
  // As many browser-token pairs as one UI facet may declare: 8 providers with 16 scopes each.
  const providers = Array.from({ length: 8 }, (_, p) => ({
    provider: `example.p${String(p)}`,
    scopes: Array.from({ length: 16 }, (_, s) => `scope${String(s).padStart(2, "0")}:read`),
    purpose: "Draws something.",
  }));

  it("lists at most the cap, counts the rest, still says wider, and parses through the inbox contract", () => {
    const change = compareReach(snapshot({}), snapshot({ browserTokens: providers }));
    expect(change.verdict).toBe("wider");
    expect(change.browserTokens.added).toHaveLength(REACH_CHANGE_LIST_MAX);
    expect(change.browserTokens.addedMore).toBe(128 - REACH_CHANGE_LIST_MAX);
    expect(change.browserTokens).not.toHaveProperty("removedMore");
    expect(reachChangeSchema.safeParse(change).success).toBe(true);

    const removed = compareReach(snapshot({ browserTokens: providers }), snapshot({}));
    expect(removed.verdict).toBe("narrower");
    expect(removed.browserTokens.removedMore).toBe(128 - REACH_CHANGE_LIST_MAX);

    const notice = {
      noticeId: "n1",
      sourceKind: "system",
      category: "update",
      severity: "info",
      title: "An update is available",
      createdAt: "2026-10-03T00:00:00.000Z",
      reachChange: change,
    };
    const inbox = inboxResponseSchema.safeParse({ waiting: [], notices: [notice], unread: 1, readAt: "2026-10-03T00:00:00.000Z" });
    expect(inbox.error?.issues).toBeUndefined();
  });

  it("carries the could-not-compare state in the same field", () => {
    expect(reachChangeViewSchema.safeParse({ verdict: "unknown" }).success).toBe(true);
    expect(reachChangeViewSchema.safeParse({ verdict: "unknown", origins: { added: [], removed: [] } }).success).toBe(false);
  });
});

describe("the reach of a listing and of a manifest", () => {
  it("reads an absent listing reach and profile as none and the default profile", () => {
    expect(reachSnapshotOfListing({})).toEqual({ reach: NONE, profile: "interactive-light", gpu: false });
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
