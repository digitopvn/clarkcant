import { describe, expect, it } from "vitest";

import {
  checkSurfaceCompositionSpec,
  countsByBucket,
  donutSlices,
  monthGrid,
  orderSections,
  periodRange,
  summariseSeries,
  surfaceCompositionSpecSchema,
  toCompositionSection,
} from "@clarkcant/contracts";

/**
 * Pure helpers behind a composed surface.
 *
 * Node environment, no DOM, no JSX: everything asserted here is arithmetic or validation, which is
 * the half of the UI that can be tested without a browser and therefore should be. The rendering
 * assertions live in `apps/web/e2e`, where a real layout exists to assert against.
 */

const TZ = "Asia/Saigon";

describe("period ranges", () => {
  it("starts a week on Monday in the caller's timezone", () => {
    // 2026-09-17 is a Thursday. The week runs Monday 14th to Sunday 20th.
    const range = periodRange("week", new Date("2026-09-17T05:00:00.000Z"), TZ);
    expect(range.startDate).toBe("2026-09-14");
    expect(range.endDate).toBe("2026-09-20");
    expect(range.buckets).toHaveLength(7);
    expect(range.buckets[0]?.label).toBe("14/09");
    // Midnight in Saigon is 17:00 UTC the day before.
    expect(range.from).toBe("2026-09-13T17:00:00.000Z");
    expect(range.to).toBe("2026-09-20T17:00:00.000Z");
  });

  it("treats Sunday as the end of the week, not the start", () => {
    const range = periodRange("week", new Date("2026-09-20T05:00:00.000Z"), TZ);
    expect(range.startDate).toBe("2026-09-14");
  });

  it("covers a whole month including the boundary days", () => {
    // 17:00 UTC is midnight on 1 October in Saigon. The month a reference instant belongs to is a
    // local question, so an instant that is still September in UTC is October here.
    const october = periodRange("month", new Date("2026-09-30T18:00:00.000Z"), TZ);
    expect(october.startDate).toBe("2026-10-01");
    expect(october.endDate).toBe("2026-10-31");
    expect(october.buckets).toHaveLength(31);
    expect(october.from).toBe("2026-09-30T17:00:00.000Z");

    const september = periodRange("month", new Date("2026-09-30T10:00:00.000Z"), TZ);
    expect(september.startDate).toBe("2026-09-01");
    expect(september.endDate).toBe("2026-09-30");
    expect(september.buckets).toHaveLength(30);
    // The exclusive end is the first instant of the next month, in UTC.
    expect(september.to).toBe("2026-09-30T17:00:00.000Z");
  });

  it("keeps 29 days in a leap February", () => {
    const range = periodRange("month", new Date("2028-02-15T05:00:00.000Z"), TZ);
    expect(range.endDate).toBe("2028-02-29");
    expect(range.buckets).toHaveLength(29);
    expect(range.buckets[28]?.key).toBe("2028-02-29");
  });

  it("does not lose or duplicate an hour on a daylight-saving day", () => {
    // 8 March 2026 is the US spring-forward: that local day is 23 hours long. Summing bucket
    // lengths is what catches a range built by adding 86 400 000 ms to an instant.
    const range = periodRange("week", new Date("2026-03-08T12:00:00.000Z"), "America/New_York");
    const totals = range.buckets.map((bucket) => new Date(bucket.to).getTime() - new Date(bucket.from).getTime());
    expect(totals.filter((ms) => ms === 23 * 3_600_000)).toHaveLength(1);
    expect(totals.every((ms) => ms === 23 * 3_600_000 || ms === 24 * 3_600_000)).toBe(true);
    expect(new Date(range.from).getTime()).toBeLessThan(new Date(range.to).getTime());
  });

  it("buckets an instant by local day, not by UTC day", () => {
    // 23:30 in Saigon on the 17th is 16:30 UTC on the same date; 00:30 on the 18th is 17:30 UTC on
    // the 17th. A UTC bucket would file both under the 17th.
    const range = periodRange("week", new Date("2026-09-17T05:00:00.000Z"), TZ);
    const counts = countsByBucket(range, ["2026-09-17T16:30:00.000Z", "2026-09-17T17:30:00.000Z"]);
    const byKey = Object.fromEntries(counts.map((entry) => [entry.key, entry.value]));
    expect(byKey["2026-09-17"]).toBe(1);
    expect(byKey["2026-09-18"]).toBe(1);
    // A day with nothing in it is present as zero rather than absent.
    expect(counts).toHaveLength(7);
  });
});

describe("series", () => {
  it("distinguishes an empty series from a series of zeros", () => {
    expect(summariseSeries([]).allZero).toBe(true);
    expect(summariseSeries([]).count).toBe(0);
    expect(summariseSeries([0, 0, 0]).allZero).toBe(true);
    expect(summariseSeries([0, 0, 3]).allZero).toBe(false);
  });

  it("ignores non-finite values rather than producing NaN totals", () => {
    const summary = summariseSeries([1, Number.NaN, 3]);
    expect(summary.total).toBe(4);
    expect(summary.average).toBe(2);
    expect(summary.max).toBe(3);
  });

  it("refuses a negative slice and reports a zero total", () => {
    const negative = donutSlices([
      { label: "done", value: 3 },
      { label: "reverted", value: -1 },
    ]);
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.reason).toContain("negative");

    const zero = donutSlices([
      { label: "done", value: 0 },
      { label: "failed", value: 0 },
    ]);
    expect(zero.ok).toBe(true);
    if (zero.ok) {
      expect(zero.totalZero).toBe(true);
      expect(zero.slices.every((slice) => slice.share === 0)).toBe(true);
    }

    const normal = donutSlices([
      { label: "done", value: 3 },
      { label: "failed", value: 1 },
    ]);
    expect(normal.ok).toBe(true);
    if (normal.ok) {
      expect(normal.total).toBe(4);
      expect(normal.slices[0]?.share).toBeCloseTo(0.75);
    }
  });
});

describe("layout", () => {
  it("orders regions by the container's slot order, not by arrival", () => {
    const ordered = orderSections([
      { slot: "cta" as const, id: "c" },
      { slot: "metrics" as const, id: "m" },
      { slot: "calendar" as const, id: "k" },
      { slot: "trend" as const, id: "t" },
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["m", "t", "k", "c"]);
  });

  it("draws six weeks starting on Monday and flags the days outside the month", () => {
    const cells = monthGrid("2026-09", TZ);
    expect(cells).toHaveLength(42);
    expect(cells[0]?.date).toBe("2026-08-31");
    expect(cells[0]?.inMonth).toBe(false);
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(30);
    expect(cells.find((cell) => cell.date === "2026-09-01")?.inMonth).toBe(true);
  });

  it("draws February correctly in a leap year and in a common year", () => {
    expect(monthGrid("2028-02", TZ).filter((cell) => cell.inMonth)).toHaveLength(29);
    expect(monthGrid("2027-02", TZ).filter((cell) => cell.inMonth)).toHaveLength(28);
    expect(monthGrid("not-a-month", TZ)).toEqual([]);
  });
});

describe("composition spec checks that need no catalog", () => {
  it("accepts a spec whose sections are unique and refuses one that is not", () => {
    const base = {
      schemaVersion: 1 as const,
      compositionId: "comp_1",
      instanceId: "winst_1",
      templateId: "overview",
      templateVersion: "1",
      catalogDigest: "sha256:catalog",
      initialState: { period: "week" as const, timezone: TZ },
      actions: [],
      provenance: {
        createdAt: "2026-09-17T05:00:00.000Z",
        templateId: "overview",
        templateVersion: "1",
        selector: { mode: "explicit" as const, policyVersion: "1" },
        sourceRevisions: [],
      },
    };
    const section = toCompositionSection({
      sectionId: "metrics",
      slot: "metrics",
      definitionRef: { id: "canvas.metrics@1", version: "1.0.0", digest: "sha256:whatever" },
      props: { datasetRef: "ds_tasks" },
      dataRefs: ["ds_tasks"],
      textAlternative: "Bốn task hoàn thành.",
    });

    const good = surfaceCompositionSpecSchema.parse({ ...base, sections: [section] });
    expect(checkSurfaceCompositionSpec(good).ok).toBe(true);

    const duplicated = surfaceCompositionSpecSchema.parse({ ...base, sections: [section, section] });
    const refused = checkSurfaceCompositionSpec(duplicated);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problems.join(" ")).toContain("duplicate section id");

    // A digest the catalog does not hold is refused even when the id matches: the spec pins the
    // schema, and a definition that changed shape cannot be rendered under an old spec.
    const pinnedElsewhere = checkSurfaceCompositionSpec(good, {
      knownDefinitions: new Map([["canvas.metrics@1@1.0.0", "sha256:something-else"]]),
    });
    expect(pinnedElsewhere.ok).toBe(false);
    if (!pinnedElsewhere.ok) expect(pinnedElsewhere.problems.join(" ")).toContain("pins digest");
  });
});
