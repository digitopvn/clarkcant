import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeSearch, machineRoots, searchFileSystem, type FileSearchOptions } from "../src/fs-search.ts";

/** The path the walk will report for a fixture file, in this platform's spelling. */
function pathOf(...parts: string[]): string {
  return join(...parts);
}

/**
 * Searching the machine.
 *
 * Most of this runs against an injected tree rather than a real disk, because what needs asserting is
 * the behaviour at the edges — the ceilings, the directories that are not descended into, the file that
 * cannot be read — and those are the cases a real filesystem makes hard to construct on purpose. One
 * test walks a temporary directory for real, so the injected walk is not the only thing ever exercised.
 */

/**
 * A tree as list and readText see it: paths with their contents, directories implied by the paths.
 *
 * Paths are normalised on the way in and out, because the walk joins with the platform's separator: on
 * Windows it asks about `\\root\\notes`, and a fixture keyed on `/root/notes` would answer nothing —
 * which looks exactly like a search that found nothing.
 */
function fakeTree(
  files: Record<string, string>,
  unreadable: readonly string[] = [],
): Pick<FileSearchOptions, "list" | "readText" | "stat"> {
  const normalize = (value: string): string => value.replaceAll("\\", "/").replace(/\/$/, "");
  const paths = Object.keys(files).map(normalize);
  const denied = unreadable.map(normalize);
  const childrenOf = (directory: string): { name: string; directory: boolean }[] => {
    const prefix = `${normalize(directory)}/`;
    const seen = new Map<string, boolean>();
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const [head, ...tail] = rest.split("/");
      if (head === undefined || head === "") continue;
      seen.set(head, tail.length > 0);
    }
    return [...seen].map(([name, directory]) => ({ name, directory }));
  };

  return {
    list: async (directory) => childrenOf(directory),
    readText: async (path) => {
      const key = normalize(path);
      if (denied.includes(key)) throw new Error("EACCES");
      const content = files[key];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    stat: async (path) => ({ size: files[normalize(path)]?.length ?? 0, modifiedAt: "2026-09-18T00:00:00.000Z" }),
  };
}

describe("a whole-machine search", () => {
  it("finds a file by name, without regard to case", async () => {
    const tree = fakeTree({
      "/root/notes/KeHoach.md": "# kế hoạch",
      "/root/other/readme.txt": "nothing here",
    });
    const outcome = await searchFileSystem({ query: "kehoach" }, { roots: ["/root"], ...tree });

    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0]).toMatchObject({ path: pathOf("/root/notes/KeHoach.md"), match: "name" });
    expect(outcome.scanned.files).toBe(2);
  });

  it("finds a phrase inside a file and reports the line it is on", async () => {
    const tree = fakeTree({
      "/root/a.txt": "first line\nsecond line\nĐOẠN CẦN TÌM đây\nfourth",
      "/root/b.txt": "nothing",
    });
    const outcome = await searchFileSystem({ query: "đoạn cần tìm" }, { roots: ["/root"], ...tree });

    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0]).toMatchObject({ match: "content", lineNumber: 3 });
    expect(outcome.hits[0]?.snippet).toContain("ĐOẠN CẦN TÌM");
  });

  it("does not descend into the directories nobody's file is in", async () => {
    const tree = fakeTree({
      "/root/node_modules/pkg/index.js": "needle",
      "/root/.git/config": "needle",
      "/root/.cache/thing": "needle",
      "/root/src/real.ts": "needle",
    });
    const outcome = await searchFileSystem({ query: "needle" }, { roots: ["/root"], ...tree });

    expect(outcome.hits.map((hit) => hit.path)).toEqual([pathOf("/root/src/real.ts")]);
    // And it says which names were skipped, so a missing result is attributable.
    expect(outcome.skipped).toContain("node_modules");
  });

  it("skips a file it cannot read rather than failing the search", async () => {
    const tree = fakeTree({ "/root/ok.txt": "needle", "/root/locked.txt": "needle" }, ["/root/locked.txt"]);
    const outcome = await searchFileSystem({ query: "needle" }, { roots: ["/root"], ...tree });

    expect(outcome.hits.map((hit) => hit.path)).toEqual([pathOf("/root/ok.txt")]);
  });

  it("stops at the result ceiling and says that it did", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) files[`/root/file-${index}.txt`] = "needle";
    const outcome = await searchFileSystem({ query: "needle", limit: 3 }, { roots: ["/root"], ...fakeTree(files) });

    expect(outcome.hits).toHaveLength(3);
    expect(outcome.truncated).toBe(true);
    expect(outcome.stoppedBecause).toBe("results");
    // A partial answer says so in words as well as in a flag: the sentence is what reaches the reader.
    expect(describeSearch(outcome, "needle")).toContain("còn nữa");
  });

  it("stops at the file ceiling", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) files[`/root/file-${index}.txt`] = "needle";
    const outcome = await searchFileSystem({ query: "needle", maxFiles: 4 }, { roots: ["/root"], ...fakeTree(files) });

    expect(outcome.stoppedBecause).toBe("files");
    expect(outcome.truncated).toBe(true);
  });

  it("stops when its time is up", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) files[`/root/file-${index}.txt`] = "needle";
    // The clock is injected, so the budget is tested without waiting for it.
    let clock = 0;
    const outcome = await searchFileSystem(
      { query: "needle", budgetMs: 100 },
      { roots: ["/root"], ...fakeTree(files), now: () => (clock += 60) },
    );

    expect(outcome.stoppedBecause).toBe("budget");
    expect(outcome.hits.length).toBeLessThan(10);
  });

  it("does not read the contents of a file it can tell is not text", async () => {
    // A binary is skipped for content and only ever matched by name, so a query that appears inside a
    // PNG is not a match: reading a megabyte of pixels to search it is work nobody asked for.
    const tree = fakeTree({ "/root/image.png": "needle", "/root/code.ts": "needle" });
    const outcome = await searchFileSystem({ query: "needle" }, { roots: ["/root"], ...tree });

    expect(outcome.hits.map((hit) => hit.name)).toEqual(["code.ts"]);
    expect(outcome.hits[0]?.match).toBe("content");
  });

  it("returns nothing, and says what it scanned, when the query is not there", async () => {
    const outcome = await searchFileSystem({ query: "không có gì" }, { roots: ["/root"], ...fakeTree({ "/root/a.txt": "abc" }) });
    expect(outcome.hits).toEqual([]);
    const text = describeSearch(outcome, "không có gì");
    expect(text).toContain("Không tìm thấy");
    expect(text).toContain("/root");
  });

  it("ignores an empty query rather than matching everything", async () => {
    const outcome = await searchFileSystem({ query: "   " }, { roots: ["/root"], ...fakeTree({ "/root/a.txt": "abc" }) });
    expect(outcome.hits).toEqual([]);
    expect(outcome.scanned.files).toBe(0);
  });
});

describe("walking a real directory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-search-"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "src", "needle.ts"), "export const needle = 1;\n");
    writeFileSync(join(dir, "node_modules", "pkg", "needle.js"), "needle\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a file through the real filesystem and skips dependencies", async () => {
    const outcome = await searchFileSystem({ query: "needle" }, { roots: [dir] });
    const names = outcome.hits.map((hit) => hit.name);
    expect(names).toContain("needle.ts");
    expect(names).not.toContain("needle.js");
    expect(outcome.scanned.files).toBeGreaterThan(0);
  });

  it("starts from every drive it can see, or from the filesystem root", () => {
    const roots = machineRoots();
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) expect(root).not.toBe("");
  });
});
