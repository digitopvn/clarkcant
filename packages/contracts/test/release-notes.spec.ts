import { describe, expect, it } from "vitest";

import {
  HOST_OWNED_BLOCK_TYPES,
  changelogCardSchema,
  compareReleaseVersions,
  messageBlockSchema,
  normalizeReleaseVersion,
  releaseHistorySchema,
} from "../src/index.ts";

const RANGE = { from: "806c39686b2b531a4671f519e7d8072041b2a494", to: "a448d3e4a448d3e4a448d3e4a448d3e4a448d3e4" };

function release(version: string, extra: Record<string, unknown> = {}) {
  return {
    version,
    kind: "release",
    channel: version.includes("-") ? "beta" : "stable",
    date: "2026-10-06",
    previousVersion: "0.2.1",
    commitRange: RANGE,
    notes: `## ${version}`,
    entries: [{ kind: "fix", summary: "keep the queued message", scope: "runtime", commit: "a448d3e4a448" }],
    omittedEntries: 0,
    artifacts: [],
    ...extra,
  };
}

const BASELINE = {
  version: "0.2.1",
  kind: "baseline",
  date: "2026-10-06",
  previousVersion: null,
  commitRange: { from: null, to: RANGE.from },
  notes: "history",
  entries: [],
  omittedEntries: 0,
  artifacts: [],
};

function history(releases: unknown[]) {
  return {
    schemaVersion: 1,
    build: { version: "0.3.0", channel: "stable" },
    source: "https://github.com/digitopvn/clarkcant/releases",
    releases,
  };
}

describe("compareReleaseVersions", () => {
  it("orders by SemVer precedence, prereleases before their release", () => {
    const sorted = ["1.0.0", "0.10.0", "1.0.0-beta.2", "0.2.1", "1.0.0-beta.10", "1.0.0-alpha"].sort(compareReleaseVersions);
    expect(sorted).toEqual(["0.2.1", "0.10.0", "1.0.0-alpha", "1.0.0-beta.2", "1.0.0-beta.10", "1.0.0"]);
  });

  it("never takes a malformed value for the newest", () => {
    expect(compareReleaseVersions("latest", "0.0.1")).toBeLessThan(0);
    expect(compareReleaseVersions("0.0.1", "latest")).toBeGreaterThan(0);
  });
});

describe("normalizeReleaseVersion", () => {
  it("reads versions as people write them", () => {
    expect(normalizeReleaseVersion("1.4")).toBe("1.4.0");
    expect(normalizeReleaseVersion(" v1.4 ")).toBe("1.4.0");
    expect(normalizeReleaseVersion("2")).toBe("2.0.0");
    expect(normalizeReleaseVersion("1.5.0-beta.2")).toBe("1.5.0-beta.2");
  });

  it("refuses what is not a version", () => {
    expect(normalizeReleaseVersion("latest")).toBeUndefined();
    expect(normalizeReleaseVersion("1.4-beta")).toBeUndefined();
    expect(normalizeReleaseVersion("")).toBeUndefined();
  });
});

describe("releaseHistorySchema", () => {
  it("accepts releases newest first, ending at the baseline", () => {
    expect(releaseHistorySchema.safeParse(history([release("0.3.0"), release("0.3.0-beta.1"), BASELINE])).success).toBe(true);
  });

  it("refuses releases out of order or repeated", () => {
    expect(releaseHistorySchema.safeParse(history([BASELINE, release("0.3.0")])).success).toBe(false);
    expect(releaseHistorySchema.safeParse(history([release("0.3.0"), release("0.3.0")])).success).toBe(false);
  });

  it("requires a channel on a release and none on the baseline", () => {
    const { channel: _dropped, ...unchanneled } = release("0.3.0");
    expect(releaseHistorySchema.safeParse(history([unchanneled])).success).toBe(false);
    expect(releaseHistorySchema.safeParse(history([{ ...BASELINE, channel: "stable" }])).success).toBe(false);
  });

  it("keeps the record bounded", () => {
    const many = Array.from({ length: 21 }, (_, index) => release(`0.${String(100 - index)}.0`));
    expect(releaseHistorySchema.safeParse(history(many)).success).toBe(false);
    const long = release("0.3.0", { entries: [{ kind: "fix", summary: "x".repeat(301), commit: "a448d3e4a448" }] });
    expect(releaseHistorySchema.safeParse(history([long])).success).toBe(false);
  });
});

describe("the changelog card", () => {
  const card = {
    type: "changelog-card",
    owner: "host",
    cardId: "card_1",
    installed: { version: "0.3.0", channel: "source" },
    releases: [
      {
        version: "0.3.0",
        kind: "release",
        channel: "stable",
        date: "2026-10-06",
        previousVersion: "0.2.1",
        commitRange: RANGE,
        entries: [{ kind: "feature", summary: "a changelog card", commit: "a448d3e4a448" }],
        omittedEntries: 0,
      },
    ],
    source: "https://github.com/digitopvn/clarkcant/releases",
    updatedAt: "2026-10-06T06:00:00.000Z",
  };

  it("is a host-owned message block", () => {
    expect(HOST_OWNED_BLOCK_TYPES).toContain("changelog-card");
    expect(messageBlockSchema.safeParse(card).success).toBe(true);
  });

  it("carries no update action or status", () => {
    expect(changelogCardSchema.safeParse({ ...card, update: { available: "0.4.0" } }).success).toBe(false);
  });
});
