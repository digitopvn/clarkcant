import { describe, expect, it } from "vitest";

import {
  CHART_HEIGHT,
  CHART_PAD,
  chartGeometry,
  chartPoints,
  formatTick,
  formatTicks,
  labelStride,
  MIN_LABEL_SLOT,
  niceRange,
  niceTicks,
  valueLabelShown,
} from "../src/chart-layout.ts";

describe("category label thinning", () => {
  it("draws every label when each one has room", () => {
    expect(labelStride(5, 5 * MIN_LABEL_SLOT)).toBe(1);
  });

  it("skips labels rather than overlapping them when the chart is narrow", () => {
    // Twelve months in a phone-width plot: every label would sit on its neighbour.
    const stride = labelStride(12, 260);
    expect(stride).toBeGreaterThan(1);
    expect(260 / Math.ceil(12 / stride)).toBeGreaterThanOrEqual(MIN_LABEL_SLOT);
  });

  it("never returns a stride below one, whatever it is given", () => {
    expect(labelStride(0, 300)).toBe(1);
    expect(labelStride(1, 10)).toBe(1);
    expect(labelStride(4, 0)).toBe(1);
  });
});

describe("gridline ticks", () => {
  it("starts at zero and ends at or above the largest value", () => {
    const ticks = niceTicks(164);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(164);
  });

  it("uses round steps", () => {
    const ticks = niceTicks(164);
    const step = (ticks[1] ?? 0) - (ticks[0] ?? 0);
    expect([1, 2, 5].some((base) => Number.isInteger(Math.log10(step / base)))).toBe(true);
  });

  it("handles small and degenerate maxima", () => {
    expect(niceTicks(4.6).at(-1)).toBeGreaterThanOrEqual(4.6);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN)).toEqual([0, 1]);
  });
});

describe("tick labels", () => {
  it("prints short values without float noise", () => {
    expect(formatTick(0.30000000000000004)).toBe("0.3");
    expect(formatTick(40)).toBe("40");
    expect(formatTick(25_000)).toBe("25k");
    expect(formatTick(3_400_000)).toBe("3.4M");
  });
});

describe("tick labels for an axis", () => {
  it("keeps enough decimals for a small step", () => {
    const labels = formatTicks(niceTicks(0.004));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.at(-1)).toBe("0.004");
  });

  it("uses one unit across the axis", () => {
    expect(formatTicks([0, 5_000, 10_000])).toEqual(["0", "5k", "10k"]);
    expect(formatTicks([0, 40, 80, 120, 160])).toEqual(["0", "40", "80", "120", "160"]);
  });
});

describe("a range that crosses zero", () => {
  it("keeps zero on a gridline and covers both ends", () => {
    const ticks = niceRange(-5, 10);
    expect(ticks).toContain(0);
    expect(ticks[0]).toBeLessThanOrEqual(-5);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(10);
  });

  it("covers an all-negative series down to its minimum and up to zero", () => {
    const ticks = niceRange(-3, -1);
    expect(ticks[0]).toBeLessThanOrEqual(-3);
    expect(ticks.at(-1)).toBe(0);
  });
});

describe("chart geometry", () => {
  const plotBottom = CHART_HEIGHT - CHART_PAD.bottom;

  it("puts zero at the bottom of the plot when nothing is negative", () => {
    expect(chartGeometry(400, [3, 7]).zero).toBeCloseTo(plotBottom);
  });

  it("lifts the zero line off the bottom when a value is negative", () => {
    const geometry = chartGeometry(400, [-5, 10]);
    expect(geometry.zero).toBeLessThan(plotBottom);
    expect(geometry.scaleY(-5)).toBeGreaterThan(geometry.zero);
    expect(geometry.scaleY(10)).toBeLessThan(geometry.zero);
  });

  it("stays inside the plot for empty, single and all-zero series", () => {
    for (const values of [[], [5], [0, 0, 0]]) {
      const geometry = chartGeometry(400, values);
      for (const value of values) {
        expect(geometry.scaleY(value)).toBeGreaterThanOrEqual(CHART_PAD.top);
        expect(geometry.scaleY(value)).toBeLessThanOrEqual(plotBottom);
      }
      expect(Number.isFinite(geometry.zero)).toBe(true);
    }
  });
});

describe("plotted points", () => {
  const byWeek = (row: Record<string, unknown>): string => String(row.week);

  it("keeps each value with its own label when a row has no value", () => {
    const points = chartPoints([{ week: "W1", v: 1 }, { week: "W2" }, { week: "W3", v: 3 }], "v", byWeek);
    expect(points).toEqual([
      { label: "W1", value: 1 },
      { label: "W3", value: 3 },
    ]);
  });

  it("treats null, blank and non-numeric values as missing rather than zero", () => {
    const points = chartPoints(
      [{ week: "W1", v: null }, { week: "W2", v: "" }, { week: "W3", v: "n/a" }, { week: "W4", v: Number.NaN }, { week: "W5", v: "4" }],
      "v",
      byWeek,
    );
    expect(points).toEqual([{ label: "W5", value: 4 }]);
  });
});

describe("value labels", () => {
  it("always shows the last value without crowding the one before it", () => {
    const shown = [0, 1, 2, 3, 4, 5].filter((index) => valueLabelShown(index, 6, 2));
    expect(shown).toContain(5);
    for (let i = 1; i < shown.length; i += 1) expect((shown[i] ?? 0) - (shown[i - 1] ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it("shows every label when there is room", () => {
    expect([0, 1, 2, 3].every((index) => valueLabelShown(index, 4, 1))).toBe(true);
  });
});
