import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DirectoryEntry } from "@clarkcant/contracts";

import { readDirectoryIndex, unreadFieldsOf } from "../src/directory-index.ts";
import {
  OFFICIAL_MARKETPLACE_LABEL,
  composeDirectory,
  customMarketplaceDirectory,
  directoryProblems,
  directoryProviders,
  localFileDirectory,
  officialMarketplaceDirectory,
  originOf,
  readDirectory,
  refreshDirectory,
  sourcesUnreadBefore,
} from "../src/directory-sources.ts";
import {
  DIRECTORY_FEED_FORMAT,
  feedLabel,
  feedUrlProblem,
  fetchDirectoryFeed,
  redactedAddress,
  type FeedFetch,
} from "../src/marketplace-directory.ts";

/**
 * The directory as composed sources: the index file read exactly as before, remote marketplaces read from the copy this
 * node fetched last, and every failure a named state rather than an empty list. Remote feeds here are served by a fake
 * `fetch`, so nothing reaches a network.
 */

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-directory-sources-"));
  temporary.push(dir);
  return dir;
}

function entry(overrides: Partial<DirectoryEntry> & { packageId: string }): DirectoryEntry {
  return {
    version: "1.0.0",
    displayName: overrides.packageId,
    description: "a package",
    source: { kind: "npm", name: overrides.packageId.split(".").at(-1) ?? "pkg", version: overrides.version ?? "1.0.0" },
    publisher: { id: "acme", sourceUrl: "https://example.com/acme", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    platforms: ["linux-x64"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 10,
    digest: "sha256:aaaa",
    ...overrides,
  };
}

function writeIndex(dir: string, entries: unknown): string {
  const path = join(dir, "index.json");
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

/** A fake `fetch` answering each URL from a table, and recording what it was asked. */
function fakeFetch(answers: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FeedFetch = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[url];
    if (answer === undefined) return new Response("not found", { status: 404 });
    return answer();
  };
  return { fetch, calls };
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

const FEED = "https://catalog.example.com/clark/directory";
const FEED_B = "https://other.example.com/feed";
const OFFICIAL = "https://marketplace.clarkcant.cc/api/v1/directory";

describe("which sources are configured", () => {
  it("reads the official Marketplace by default and leaves it out when it is turned off", () => {
    const dataDir = tempDir();
    expect(directoryProviders({ env: {}, dataDir }).map((provider) => provider.origin.kind)).toEqual(["official-marketplace"]);
    expect(directoryProviders({ env: { CC_OFFICIAL_MARKETPLACE: "off" }, dataDir })).toEqual([]);
  });

  it("orders the index file first, then the configured marketplaces, then the official one", () => {
    const dataDir = tempDir();
    const providers = directoryProviders({
      env: { CC_DIRECTORY_INDEX: "/tmp/index.json", CC_DIRECTORY_MARKETPLACES: `${FEED}, https://b.example.com/feed ${FEED}` },
      dataDir,
    });
    expect(providers.map((provider) => provider.origin.kind)).toEqual([
      "local-file",
      "custom-marketplace",
      "custom-marketplace",
      "official-marketplace",
    ]);
    expect(providers[1]?.origin.label).toBe("catalog.example.com/clark/directory");
  });

  it("uses no remote source without a data folder to keep its copy in", () => {
    expect(directoryProviders({ env: { CC_DIRECTORY_MARKETPLACES: FEED }, dataDir: undefined })).toEqual([]);
  });

  it("says nothing is configured as a state, naming how to configure one", () => {
    const state = readDirectory({ env: { CC_OFFICIAL_MARKETPLACE: "off" }, dataDir: tempDir() });
    expect(state.kind).toBe("not-configured");
    expect(state.kind === "not-configured" ? state.reason : "").toContain("CC_DIRECTORY_INDEX");
  });
});

describe("the index file alone", () => {
  it("is read exactly as readDirectoryIndex reads it", () => {
    const dir = tempDir();
    const path = writeIndex(dir, [entry({ packageId: "com.acme.a" }), { ...entry({ packageId: "com.acme.b" }), newer: 1 }]);
    const composed = composeDirectory([localFileDirectory(path)]);
    const direct = readDirectoryIndex(path);
    expect(composed.kind).toBe("configured");
    if (composed.kind !== "configured" || direct.kind !== "configured") return;
    expect(composed.entries).toEqual(direct.entries);
    expect(composed.directory).toBe(direct.directory);
    expect(composed.unreadFields).toEqual(direct.unreadFields);
    const second = composed.entries[1];
    expect(second === undefined ? undefined : unreadFieldsOf(composed, second)).toEqual({ count: 1, names: ["newer"] });
    expect(composed.sources?.[0]?.state).toBe("ready");
  });

  it("stays unreadable, with the same reason, when the file is broken", () => {
    const path = writeIndex(tempDir(), { not: "an array" });
    const composed = composeDirectory([localFileDirectory(path)]);
    expect(composed.kind).toBe("unreadable");
    expect(composed.kind === "unreadable" ? composed.reason : "").toBe(
      (readDirectoryIndex(path) as { reason: string }).reason,
    );
  });
});

describe("a remote marketplace feed", () => {
  it("reads as not listable, not as an empty list, before it was ever fetched", () => {
    const state = composeDirectory([customMarketplaceDirectory(FEED, tempDir())]);
    expect(state.kind).toBe("unreadable");
    if (state.kind !== "unreadable") return;
    expect(state.sources?.[0]?.state).toBe("not-fetched");
    // Says how to set a directory up, not only what failed.
    expect(state.reason).toContain("CC_DIRECTORY_INDEX");
    expect(state.reason).toContain("CC_DIRECTORY_MARKETPLACES");
  });

  it("fetches every page, keeps the copy, and lists it with its origin and fetch time", async () => {
    const cacheDir = tempDir();
    const { fetch, calls } = fakeFetch({
      [FEED]: () => json({ format: DIRECTORY_FEED_FORMAT, entries: [entry({ packageId: "com.acme.one" })], nextCursor: "o1" }),
      [`${FEED}?cursor=o1`]: () => json({ format: DIRECTORY_FEED_FORMAT, entries: [entry({ packageId: "com.acme.two" })], nextCursor: null }),
    });
    const provider = customMarketplaceDirectory(FEED, cacheDir);
    await provider.refresh({ fetch, now: () => new Date("2026-10-07T10:00:00.000Z") });
    const state = composeDirectory([provider]);
    expect(state.kind).toBe("configured");
    if (state.kind !== "configured") return;
    expect(state.entries.map((listed) => listed.packageId)).toEqual(["com.acme.one", "com.acme.two"]);
    const first = state.entries[0];
    expect(first === undefined ? undefined : originOf(state, first)).toMatchObject({ kind: "custom-marketplace" });
    expect(state.sources?.[0]).toMatchObject({ state: "ready", entryCount: 2, fetchedAt: "2026-10-07T10:00:00.000Z" });
    // Nothing identifying or secret is sent, and a redirect is not followed somewhere the person did not name.
    for (const call of calls) {
      expect(call.init.credentials).toBe("omit");
      expect(call.init.redirect).toBe("error");
      expect(Object.keys(call.init.headers as Record<string, string>)).toEqual(["accept"]);
    }
  });

  it("accepts a bare JSON array, as a catalog hosted as a static file serves it", async () => {
    const cacheDir = tempDir();
    const { fetch } = fakeFetch({ [FEED]: () => json([entry({ packageId: "com.acme.static" })]) });
    const provider = customMarketplaceDirectory(FEED, cacheDir);
    await provider.refresh({ fetch });
    const state = composeDirectory([provider]);
    expect(state.kind === "configured" ? state.entries.map((listed) => listed.packageId) : []).toEqual(["com.acme.static"]);
  });

  it("does not fetch again while its copy is fresh, and never makes first contact from a background check", async () => {
    const cacheDir = tempDir();
    const { fetch, calls } = fakeFetch({ [FEED]: () => json([entry({ packageId: "com.acme.one" })]) });
    const provider = customMarketplaceDirectory(FEED, cacheDir);
    await provider.refresh({ fetch, onlyIfCached: true });
    expect(calls).toHaveLength(0);
    const now = new Date("2026-10-07T10:00:00.000Z");
    await provider.refresh({ fetch, now: () => now });
    await provider.refresh({ fetch, now: () => new Date(now.getTime() + 60_000) });
    expect(calls).toHaveLength(1);
    await provider.refresh({ fetch, now: () => new Date(now.getTime() + 16 * 60_000) });
    expect(calls).toHaveLength(2);
  });

  it("is unreachable, not empty, when it cannot be reached and has no copy", async () => {
    const provider = customMarketplaceDirectory(FEED, tempDir());
    await provider.refresh({
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    const state = composeDirectory([provider]);
    expect(state.kind).toBe("unreadable");
    expect(state.kind === "unreadable" ? state.sources?.[0]?.state : undefined).toBe("unreachable");
    expect(state.kind === "unreadable" ? state.reason : "").toContain("could not reach catalog.example.com");
  });

  it("keeps listing its last copy as stale, saying when it was fetched and why it was not refreshed", async () => {
    const cacheDir = tempDir();
    const provider = customMarketplaceDirectory(FEED, cacheDir);
    const first = new Date("2026-10-07T10:00:00.000Z");
    await provider.refresh({ fetch: fakeFetch({ [FEED]: () => json([entry({ packageId: "com.acme.one" })]) }).fetch, now: () => first });
    await provider.refresh({
      fetch: () => Promise.resolve(new Response("down", { status: 503 })),
      now: () => new Date(first.getTime() + 20 * 60_000),
    });
    const state = composeDirectory([provider]);
    expect(state.kind).toBe("configured");
    if (state.kind !== "configured") return;
    expect(state.entries.map((listed) => listed.packageId)).toEqual(["com.acme.one"]);
    expect(state.sources?.[0]).toMatchObject({ state: "stale", fetchedAt: "2026-10-07T10:00:00.000Z" });
    expect(state.sources?.[0]?.reason).toContain("HTTP 503");
    expect(directoryProblems(state.sources)).toContain("2026-10-07T10:00:00.000Z");
  });

  it("is unsupported when the address serves no directory feed", async () => {
    const provider = customMarketplaceDirectory(FEED, tempDir());
    await provider.refresh({ fetch: fakeFetch({}).fetch });
    expect(composeDirectory([provider]).kind).toBe("unreadable");
    expect(provider.read().status.state).toBe("unsupported");
  });

  it("is unreadable when the feed is not JSON, has an invalid entry, or is in another format", async () => {
    for (const body of [
      () => new Response("<html>", { status: 200 }),
      () => json([{ ...entry({ packageId: "com.acme.bad" }), version: "not a version" }]),
      () => json({ format: "someone-else@9", entries: [] }),
    ]) {
      const provider = customMarketplaceDirectory(FEED, tempDir());
      await provider.refresh({ fetch: fakeFetch({ [FEED]: body }).fetch });
      expect(provider.read().status.state).toBe("unreadable");
    }
  });

  it("refuses a remote listing that points at a path on this machine", async () => {
    const provider = customMarketplaceDirectory(FEED, tempDir());
    const local = entry({ packageId: "com.acme.sneaky", source: { kind: "local", path: "/Users/someone/.ssh" } });
    await provider.refresh({ fetch: fakeFetch({ [FEED]: () => json([local]) }).fetch });
    expect(provider.read().status).toMatchObject({ state: "unreadable" });
    expect(provider.read().status.reason).toContain("path on this machine");
  });

  it("lets a configured catalog list git sources, while the official Marketplace lists npm packages only", async () => {
    const git = entry({ packageId: "com.acme.git", source: { kind: "git", url: "https://git.example.com/a.git", ref: "a".repeat(40) } });
    const custom = customMarketplaceDirectory(FEED, tempDir());
    await custom.refresh({ fetch: fakeFetch({ [FEED]: () => json([git]) }).fetch });
    expect(custom.read().status.state).toBe("ready");
    const official = officialMarketplaceDirectory(tempDir());
    await official.refresh({ fetch: fakeFetch({ [OFFICIAL]: () => json([git]) }).fetch });
    expect(official.read().status.state).toBe("unreadable");
    expect(official.origin.label).toBe(OFFICIAL_MARKETPLACE_LABEL);
  });

  it("never passes on what a listing says beyond the directory schema, so metadata cannot grant anything", async () => {
    const provider = customMarketplaceDirectory(FEED, tempDir());
    const claiming = {
      ...entry({ packageId: "com.acme.claims" }),
      grantedCapabilities: ["host.shell.run@1"],
      approved: true,
      publisher: { id: "acme", sourceUrl: "https://example.com", license: "MIT", verified: true },
    };
    await provider.refresh({ fetch: fakeFetch({ [FEED]: () => json([claiming]) }).fetch });
    const state = composeDirectory([provider]);
    expect(state.kind).toBe("configured");
    if (state.kind !== "configured") return;
    const listed = state.entries[0];
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("grantedCapabilities");
    expect(listed).not.toHaveProperty("approved");
    expect(listed?.publisher).not.toHaveProperty("verified");
    expect(listed === undefined ? undefined : unreadFieldsOf(state, listed)).toEqual({
      count: 3,
      names: ["publisher.verified", "grantedCapabilities", "approved"],
    });
  });
});

describe("the bounds of one fetch", () => {
  it("refuses a page past the byte cap, a feed past the page cap, and one that does not answer in time", async () => {
    const big = await fetchDirectoryFeed(FEED, {
      fetch: fakeFetch({ [FEED]: () => json([entry({ packageId: "com.acme.big" })]) }).fetch,
      limits: { maxPageBytes: 50 },
    });
    expect(big).toMatchObject({ ok: false, failure: "unreadable" });

    const endless = await fetchDirectoryFeed(FEED, {
      fetch: (url) => Promise.resolve(json({ entries: [], nextCursor: `o${String(url.length)}` })),
      limits: { maxPages: 3 },
    });
    expect(endless).toMatchObject({ ok: false, failure: "unreadable" });
    expect(endless.ok ? "" : endless.reason).toContain("more than 3 pages");

    const silent = await fetchDirectoryFeed(FEED, {
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      limits: { timeoutMs: 20 },
    });
    expect(silent).toMatchObject({ ok: false, failure: "unreachable" });
    expect(silent.ok ? "" : silent.reason).toContain("did not answer");
  });

  it("refuses an address that would send credentials or is not https", () => {
    expect(feedUrlProblem("https://user:secret@catalog.example.com/feed")).toContain("username or password");
    expect(feedUrlProblem("http://catalog.example.com/feed")).toContain("https");
    expect(feedUrlProblem("http://127.0.0.1:8080/feed")).toBeUndefined();
    expect(feedUrlProblem("not a url")).toContain("not a URL");
    const state = composeDirectory([customMarketplaceDirectory("ftp://catalog.example.com/feed", tempDir())]);
    expect(state.kind).toBe("unreadable");
    // A misconfigured address is named by its host and path, never with a query that may carry a token.
    const tokened = composeDirectory([customMarketplaceDirectory("http://catalog.example.com/feed?token=s3cret", tempDir())]);
    expect(tokened.kind === "unreadable" ? tokened.reason : "").toContain("catalog.example.com/feed");
    expect(JSON.stringify(tokened)).not.toContain("s3cret");
  });

  it("never echoes a query, fragment or userinfo of an address that does not parse as a URL", () => {
    // The second parses, as a `me:` scheme with no host, and is named the same way.
    const unparseable = ["catalog.acme.example/feed?token=SECRET123", "me:SECRET123@catalog.acme.example/feed#SECRET123"];
    for (const raw of unparseable) {
      expect(redactedAddress(raw)).toBe("catalog.acme.example/feed");
      expect(feedLabel(raw)).toBe("catalog.acme.example/feed");
      const state = composeDirectory([customMarketplaceDirectory(raw, tempDir())]);
      expect(state.kind).toBe("unreadable");
      expect(JSON.stringify(state)).not.toContain("SECRET123");
    }
    expect(feedUrlProblem("catalog.acme.example/feed?token=SECRET123")).toBe("catalog.acme.example/feed is not a URL");
    expect(redactedAddress("?token=SECRET123")).toBe("an address with no host");
  });
});

describe("several sources at once", () => {
  it("lists every usable source, and gives a package id to the first source that lists it", async () => {
    const dataDir = tempDir();
    const indexPath = writeIndex(dataDir, [entry({ packageId: "com.acme.mine", source: { kind: "local", path: "/tmp/mine" } })]);
    const env = { CC_DIRECTORY_INDEX: indexPath, CC_DIRECTORY_MARKETPLACES: FEED, CC_OFFICIAL_MARKETPLACE: "off" };
    const { fetch } = fakeFetch({
      [FEED]: () =>
        json([
          entry({ packageId: "com.acme.mine", version: "9.0.0", digest: "sha256:evil" }),
          entry({ packageId: "com.acme.theirs" }),
        ]),
    });
    await refreshDirectory({ env, dataDir }, { fetch });
    const state = readDirectory({ env, dataDir });
    expect(state.kind).toBe("configured");
    if (state.kind !== "configured") return;
    expect(state.entries.map((listed) => `${listed.packageId}@${listed.version}`)).toEqual(["com.acme.mine@1.0.0", "com.acme.theirs@1.0.0"]);
    expect(state.sources?.map((status) => [status.origin.kind, status.state, status.entryCount, status.shadowed])).toEqual([
      ["local-file", "ready", 1, undefined],
      ["custom-marketplace", "ready", 1, 1],
    ]);
    const theirs = state.entries[1];
    expect(theirs === undefined ? undefined : originOf(state, theirs)?.kind).toBe("custom-marketplace");
  });

  it("still lists the sources that answer when another could not be reached, and names the one that did not", async () => {
    const dataDir = tempDir();
    const indexPath = writeIndex(dataDir, [entry({ packageId: "com.acme.mine" })]);
    const env = { CC_DIRECTORY_INDEX: indexPath, CC_DIRECTORY_MARKETPLACES: FEED, CC_OFFICIAL_MARKETPLACE: "off" };
    await refreshDirectory({ env, dataDir }, { fetch: () => Promise.reject(new TypeError("fetch failed")) });
    const state = readDirectory({ env, dataDir });
    expect(state.kind).toBe("configured");
    if (state.kind !== "configured") return;
    expect(state.entries.map((listed) => listed.packageId)).toEqual(["com.acme.mine"]);
    expect(directoryProblems(state.sources)).toContain("catalog.example.com/clark/directory: could not reach");
  });

  it("keeps a broken index file fatal rather than filling its package ids from a marketplace", async () => {
    const dataDir = tempDir();
    const indexPath = writeIndex(dataDir, [entry({ packageId: "com.acme.mine" })]);
    const env = { CC_DIRECTORY_INDEX: indexPath, CC_DIRECTORY_MARKETPLACES: FEED, CC_OFFICIAL_MARKETPLACE: "off" };
    const { fetch } = fakeFetch({ [FEED]: () => json([entry({ packageId: "com.acme.mine", version: "9.0.0", digest: "sha256:evil" })]) });
    await refreshDirectory({ env, dataDir }, { fetch });
    expect(readDirectory({ env, dataDir }).kind).toBe("configured");

    // Half-saved while the person edits it.
    writeFileSync(indexPath, "[ {broken");
    const state = readDirectory({ env, dataDir });
    expect(state.kind).toBe("unreadable");
    if (state.kind !== "unreadable") return;
    expect(state.reason).toContain("could not read the directory index");
    expect(state.sources?.map((status) => [status.origin.kind, status.state])).toEqual([
      ["local-file", "unreadable"],
      ["custom-marketplace", "ready"],
    ]);
  });

  it("names an earlier catalog that was never read as the reason a later source's listing is not precedence's pick", async () => {
    const dataDir = tempDir();
    const env = { CC_DIRECTORY_MARKETPLACES: `${FEED} ${FEED_B}`, CC_OFFICIAL_MARKETPLACE: "off" };
    const { fetch } = fakeFetch({
      [FEED]: () => Promise.reject(new TypeError("fetch failed")),
      [FEED_B]: () => json([entry({ packageId: "com.acme.internal", digest: "sha256:other" })]),
    });
    await refreshDirectory({ env, dataDir }, { fetch });
    const state = readDirectory({ env, dataDir });
    expect(state.kind).toBe("configured");
    if (state.kind !== "configured") return;
    const listed = state.entries[0];
    const origin = listed === undefined ? undefined : originOf(state, listed);
    expect(origin?.label).toBe("other.example.com/feed");
    const unread = origin === undefined ? [] : sourcesUnreadBefore(state, origin);
    expect(unread.map((status) => [status.origin.label, status.state])).toEqual([
      ["catalog.example.com/clark/directory", "unreachable"],
    ]);
    // The first source has nothing earlier than it.
    expect(sourcesUnreadBefore(state, { id: "nope", kind: "custom-marketplace", label: "x" })).toEqual([]);
  });

  it("reads a broken index plus a never-fetched marketplace as unreadable, not as ready with nothing", () => {
    const dataDir = tempDir();
    const indexPath = writeIndex(dataDir, { not: "an array" });
    const state = readDirectory({ env: { CC_DIRECTORY_INDEX: indexPath, CC_DIRECTORY_MARKETPLACES: FEED }, dataDir });
    expect(state.kind).toBe("unreadable");
  });
});
