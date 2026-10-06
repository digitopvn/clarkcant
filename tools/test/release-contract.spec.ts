import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { releaseHistorySchema } from "../../packages/contracts/src/release-notes.ts";
import { RELEASE_NOTES_PATH, clarkVersionDrift, clarkVersionManifests, readClarkVersion, stampVersion } from "../release/clark-version.mjs";
import { BASELINE_VERSION, BOUNDS, releaseEntries, releaseHistory, releaseRecord } from "../release/notes-data.mjs";
import { stampPlan } from "../release/stamp.mjs";

/**
 * The release contract that does not need git or semantic-release: one Clark version everywhere a build carries it, the
 * release-note record and its bounds, the record the runtime embeds, and a release workflow that can publish nothing.
 * The planning itself, against real repositories, is tested by `tools/release/test/` (`pnpm --dir tools/release test`).
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const RANGE = { from: "806c39686b2b531a4671f519e7d8072041b2a494", to: "a448d3e4a448d3e4a448d3e4a448d3e4a448d3e4" };

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A checkout with a root manifest, two applications and the embedded record, all at one version. */
function checkout(version = "0.2.1"): string {
  const dir = mkdtempSync(join(tmpdir(), "clark-version-"));
  roots.push(dir);
  writeJson(join(dir, "package.json"), { name: "clarkcant", version, private: true });
  for (const app of ["desktop", "runtime"]) {
    mkdirSync(join(dir, "apps", app), { recursive: true });
    writeJson(join(dir, "apps", app, "package.json"), { name: `@clarkcant/${app}`, version, private: true, type: "module" });
  }
  mkdirSync(join(dir, "apps", "notes-only"), { recursive: true });
  writeJson(join(dir, RELEASE_NOTES_PATH), releaseHistory({ version, channel: "source", releases: [] }));
  return dir;
}

function commit(hash: string, type: string, subject: string, extra: Record<string, unknown> = {}) {
  return { hash: hash.padEnd(40, "0"), type, scope: null, subject, header: `${type}: ${subject}`, breaking: false, ...extra };
}

describe("one Clark version", () => {
  it("is carried by the root manifest and every application, and by the embedded record", () => {
    const dir = checkout();
    expect(clarkVersionManifests(dir)).toEqual(["package.json", "apps/desktop/package.json", "apps/runtime/package.json"]);
    expect(clarkVersionDrift(dir)).toEqual([]);
  });

  it("names each place that drifts", () => {
    const dir = checkout();
    writeJson(join(dir, "apps", "desktop", "package.json"), { name: "@clarkcant/desktop", version: "0.2.0" });
    writeJson(join(dir, RELEASE_NOTES_PATH), releaseHistory({ version: "0.1.0", channel: "source", releases: [] }));
    const drift = clarkVersionDrift(dir);
    expect(drift).toHaveLength(2);
    expect(drift[0]).toContain("apps/desktop/package.json");
    expect(drift[1]).toContain(RELEASE_NOTES_PATH);
  });

  it("holds in this repository", () => {
    expect(clarkVersionDrift(root)).toEqual([]);
    expect(readClarkVersion(root)).toBe(JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")).version);
  });

  it("is stamped everywhere at once, keeping each manifest's other fields", () => {
    const dir = checkout();
    stampVersion(dir, { version: "0.3.0-beta.1", channel: "beta" });
    expect(clarkVersionDrift(dir)).toEqual([]);
    const desktop = JSON.parse(readFileSync(join(dir, "apps", "desktop", "package.json"), "utf8"));
    expect(desktop).toEqual({ name: "@clarkcant/desktop", version: "0.3.0-beta.1", private: true, type: "module" });
    expect(JSON.parse(readFileSync(join(dir, RELEASE_NOTES_PATH), "utf8")).build).toEqual({ version: "0.3.0-beta.1", channel: "beta" });
    expect(() => stampVersion(dir, { version: "next", channel: "beta" })).toThrow(/not a version/);
  });

  it("is stamped from a plan only when the plan releases something", () => {
    const dir = checkout();
    const record = releaseRecord({
      version: "0.2.2",
      date: "2026-10-06T08:00:00Z",
      previousVersion: "0.2.1",
      commitRange: RANGE,
      notes: "## 0.2.2",
      commits: [commit("a1", "fix", "keep the queued message")],
    });
    const history = releaseHistory({ version: "0.2.2", channel: "stable", releases: [record] });
    expect(stampPlan(dir, { release: true, version: "0.2.2", history })).toBe("0.2.2");
    expect(JSON.parse(readFileSync(join(dir, RELEASE_NOTES_PATH), "utf8")).releases[0].version).toBe("0.2.2");
    expect(() => stampPlan(dir, { release: false })).toThrow(/releases nothing/);
    expect(() => stampPlan(dir, { release: true, version: "0.2.3", history })).toThrow(/matching release history/);
  });
});

describe("release-note records", () => {
  it("group commits by kind and keep their order", () => {
    const { entries, omittedEntries } = releaseEntries([
      commit("a1", "feat", "drop the v1 route", { breaking: true, scope: "runtime" }),
      commit("a2", "feat", "a changelog card"),
      commit("a3", "perf", "faster timeline"),
      commit("a4", "refactor", "split the gateway"),
    ]);
    expect(entries.map((entry: { kind: string }) => entry.kind)).toEqual(["breaking", "feature", "fix", "other"]);
    expect(entries[0]).toEqual({ kind: "breaking", summary: "drop the v1 route", scope: "runtime", commit: "a10000000000" });
    expect(omittedEntries).toBe(0);
  });

  it("stay within the contract's bounds, counting what they leave out", () => {
    const many = Array.from({ length: BOUNDS.entries + 5 }, (_, index) => commit(`b${String(index)}`, "fix", `fix ${String(index)}`));
    const record = releaseRecord({
      version: "0.3.0-beta.1",
      date: "2026-10-06",
      previousVersion: "0.2.1",
      commitRange: RANGE,
      notes: "x\n".repeat(BOUNDS.notes),
      commits: many,
    });
    expect(record.entries).toHaveLength(BOUNDS.entries);
    expect(record.omittedEntries).toBe(5);
    expect(record.channel).toBe("beta");
    expect(record.notes.length).toBeLessThanOrEqual(BOUNDS.notes);
    expect(releaseHistorySchema.safeParse(releaseHistory({ version: "0.3.0-beta.1", channel: "beta", releases: [record] })).success).toBe(true);
  });

  it("mark the baseline as history, with no channel and no artifacts", () => {
    const baseline = releaseRecord({
      version: BASELINE_VERSION,
      baseline: true,
      date: "2026-10-06",
      previousVersion: null,
      commitRange: { from: null, to: RANGE.from },
      notes: "history",
      commits: [],
    });
    expect(baseline).toMatchObject({ kind: "baseline", artifacts: [] });
    expect(baseline).not.toHaveProperty("channel");
  });
});

describe("the record the runtime embeds", () => {
  it("matches its contract, carries the Clark version, and ends at the baseline built from real history", () => {
    const embedded = releaseHistorySchema.parse(JSON.parse(readFileSync(join(root, RELEASE_NOTES_PATH), "utf8")));
    expect(embedded.build.version).toBe(readClarkVersion(root));
    const baseline = embedded.releases.at(-1);
    expect(baseline?.kind).toBe("baseline");
    expect(baseline?.version).toBe(BASELINE_VERSION);
    expect(baseline?.commitRange.to).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline?.entries.length).toBeGreaterThan(0);
  });
});

describe("the release workflow", () => {
  const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  const active = workflow
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  it("plans on pushes to the release branches and never runs on pull requests", () => {
    expect(active).toMatch(/branches: \[main, dev\]/);
    expect(active).not.toMatch(/pull_request/);
  });

  it("can tag, sign or publish nothing", () => {
    expect(active).toMatch(/permissions:\n {2}contents: read\n/);
    expect(active).not.toMatch(/contents: write|id-token|packages: write|secrets\.|environment:/);
    expect(active).not.toMatch(/git (tag|push)|gh release|npm publish|semantic-release(?! in)/);
    // The plan is the only semantic-release call, and it is the dry-run script.
    expect(active).toContain("node tools/release/plan.mjs --out release-plan");
  });

  it("pins every action to a commit", () => {
    const uses = [...active.matchAll(/uses: (\S+)/g)].map((match) => match[1] ?? "");
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action, action).toMatch(/@[0-9a-f]{40}$/);
  });
});
