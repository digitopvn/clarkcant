import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DirectoryEntry } from "@clarkcant/contracts";

import { directoryIndexPath, readDirectoryIndex, searchDirectory } from "../src/directory-index.ts";

function entry(overrides: Partial<DirectoryEntry> & { packageId: string }): DirectoryEntry {
  return {
    version: "1.0.0",
    displayName: overrides.packageId,
    description: "a package",
    source: { kind: "local", path: "/tmp/pkg" },
    publisher: { id: "acme", sourceUrl: "https://example.com/acme", license: "MIT" },
    preview: {},
    facets: ["ui"],
    platforms: ["linux-x64"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 10,
    digest: "sha256:aaaa",
    ...overrides,
  };
}

describe("searchDirectory", () => {
  const entries = [
    entry({ packageId: "com.acme.dashboard", displayName: "Dashboard", description: "charts" }),
    entry({ packageId: "com.acme.charts", displayName: "Charts", description: "a dashboard widget" }),
    entry({ packageId: "org.other.timer", displayName: "Timer", description: "counts down" }),
  ];

  it("ranks an exact id above a prefix, a name and a description", () => {
    // One query, four ways to answer it, in the order a person means them.
    expect(searchDirectory({ entries, query: "com.acme.dashboard" })[0]?.packageId).toBe("com.acme.dashboard");
    expect(searchDirectory({ entries, query: "com.acme" }).map((e) => e.packageId)).toEqual([
      "com.acme.charts",
      "com.acme.dashboard",
    ]);
    expect(searchDirectory({ entries, query: "charts" }).map((e) => e.packageId)).toEqual([
      "com.acme.charts",
      "com.acme.dashboard",
    ]);
    expect(searchDirectory({ entries, query: "counts" }).map((e) => e.packageId)).toEqual(["org.other.timer"]);
  });

  it("drops an entry with no digest, because it could not be installed anyway", () => {
    // The resolver refuses it, so listing it would offer an install that cannot happen.
    const withUnverifiable = [...entries, entry({ packageId: "com.acme.ghost", digest: "" })];
    expect(searchDirectory({ entries: withUnverifiable, query: "ghost" })).toEqual([]);
  });

  it("browses on an empty query instead of going blank", () => {
    // Clearing the search box should show the directory, not hide it.
    expect(searchDirectory({ entries, query: "" }).map((e) => e.packageId)).toEqual([
      "com.acme.charts",
      "com.acme.dashboard",
      "org.other.timer",
    ]);
  });

  it("gives the same order twice and respects the limit", () => {
    const first = searchDirectory({ entries, query: "" }).map((e) => e.packageId);
    expect(searchDirectory({ entries, query: "" }).map((e) => e.packageId)).toEqual(first);
    expect(searchDirectory({ entries, query: "", limit: 2 })).toHaveLength(2);
    // Clamped rather than trusted: a caller asking for 1000 rows gets the ceiling, not 1000 rows.
    expect(searchDirectory({ entries, query: "", limit: 1000 })).toHaveLength(3);
  });

  it("does not match an entry the query does not describe", () => {
    expect(searchDirectory({ entries, query: "kubernetes" })).toEqual([]);
  });
});

describe("readDirectoryIndex", () => {
  function writeIndex(contents: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "cc-dir-")), "index.json");
    writeFileSync(path, contents);
    return path;
  }

  it("says no directory is configured rather than reporting no results", () => {
    // "Nothing configured" and "nothing found" are different truths, and only one of them is the user's to fix.
    const state = readDirectoryIndex(undefined);
    expect(state.kind).toBe("not-configured");
    expect(state.kind === "not-configured" ? state.reason : "").toContain("CC_DIRECTORY_INDEX");
  });

  it("reads a valid index", () => {
    const path = writeIndex(JSON.stringify([entry({ packageId: "com.acme.dashboard" })]));
    const state = readDirectoryIndex(path);
    expect(state.kind).toBe("configured");
    expect(state.kind === "configured" ? state.entries : []).toHaveLength(1);
    expect(state.kind === "configured" ? state.directory : "").toBe(path);
  });

  it("refuses the whole file when one entry is invalid", () => {
    // Half-loading would show a subset of what the directory holds and call it the answer.
    const path = writeIndex(JSON.stringify([entry({ packageId: "com.acme.ok" }), { packageId: "broken" }]));
    const state = readDirectoryIndex(path);
    expect(state.kind).toBe("unreadable");
    expect(state.kind === "unreadable" ? state.reason : "").toContain("does not match the directory schema");
    expect(state.kind === "unreadable" ? state.directory : "").toBe(path);
  });

  it("names an unreadable file instead of throwing", () => {
    const state = readDirectoryIndex(join(tmpdir(), "cc-does-not-exist", "index.json"));
    expect(state.kind).toBe("unreadable");
    expect(readDirectoryIndex(writeIndex("not json")).kind).toBe("unreadable");
    expect(readDirectoryIndex(writeIndex("{}")).kind).toBe("unreadable");
  });

  it("ignores a blank env var, which is not a configuration", () => {
    expect(directoryIndexPath({})).toBeUndefined();
    expect(directoryIndexPath({ CC_DIRECTORY_INDEX: "   " })).toBeUndefined();
    expect(directoryIndexPath({ CC_DIRECTORY_INDEX: "/tmp/index.json" })).toBe("/tmp/index.json");
  });
});
