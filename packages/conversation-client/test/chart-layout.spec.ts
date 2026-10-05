import { describe, expect, it } from "vitest";

import {
  CHART_HEIGHT,
  CHART_PAD,
  chartGeometry,
  chartPoints,
  defaultLineSeries,
  formatTick,
  formatTicks,
  labelStride,
  linearScale,
  markerPath,
  markerShape,
  MARKER_SHAPES,
  MAX_TICKS,
  MIN_LABEL_SLOT,
  movePointCursor,
  niceRange,
  niceSpan,
  niceTicks,
  plotLeft,
  pointOrder,
  seriesDash,
  stackBands,
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

  it("prints billions and trillions with a suffix, and anything larger with an exponent", () => {
    expect(formatTicks(niceTicks(5e9))).toEqual(["0", "2B", "4B", "6B"]);
    expect(formatTicks([0, 2.5e12, 5e12])).toEqual(["0", "2.5T", "5T"]);
    const huge = formatTicks(niceTicks(1e15));
    expect(huge.at(-1)).toBe("1e15");
    expect(new Set(huge).size).toBe(huge.length);
  });

  it("keeps a narrow span at a large value apart instead of printing one unit on every tick", () => {
    const labels = formatTicks([1e12, 1e12 + 2, 1e12 + 4]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.at(-1)).toBe("1.000000000004e12");
  });
});

describe("room for the value labels", () => {
  /** How wide a label is drawn at most: 11px tabular digits, never wider than 7px each. */
  const drawnWidth = (label: string): number => label.length * 7;

  it("starts the plot far enough right that the widest label is drawn whole", () => {
    for (const values of [[0, 5e9], [0, 1e15], [-250_500_000, 0], [1e-12, 5e-12], [1e12, 1e12 + 16]]) {
      const low = Math.min(...values);
      const high = Math.max(...values);
      const geometry = chartGeometry(640, values, low < 0 ? niceRange(low, high) : niceSpan(low, high));
      const widest = Math.max(...geometry.labels.map(drawnWidth));
      // Labels end 6px left of the plot and start after the left edge.
      expect(geometry.left - 6 - widest, String(values)).toBeGreaterThanOrEqual(0);
      expect(geometry.plotWidth).toBe(640 - geometry.left - CHART_PAD.right);
    }
  });

  it("keeps the usual pad for short labels and never gives the labels more than two fifths of the chart", () => {
    expect(chartGeometry(640, [0, 100], niceTicks(100)).left).toBe(CHART_PAD.left);
    expect(plotLeft(["-1.234567890123e-300"], 200)).toBe(80);
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

describe("a number line that is not measured from zero", () => {
  it("covers the values with round ticks and does not stretch down to zero", () => {
    const ticks = niceSpan(3.4, 4.6);
    expect(ticks[0]).toBeLessThanOrEqual(3.4);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(4.6);
    expect(ticks[0]).toBeGreaterThan(0);
    expect(ticks).toEqual([3, 3.5, 4, 4.5, 5]);
  });

  it("puts a single value inside the plot rather than on its edge", () => {
    const ticks = niceSpan(7, 7);
    expect(ticks[0]).toBeLessThan(7);
    expect(ticks.at(-1)).toBeGreaterThan(7);
    expect(niceSpan(0, 0)[0]).toBeLessThan(0);
  });

  it("draws the axis of a scale that does not reach zero along its lowest line", () => {
    const geometry = chartGeometry(300, [3.4, 4.6], niceSpan(3.4, 4.6));
    expect(geometry.zero).toBe(geometry.scaleY(3));
    expect(geometry.zero).toBe(CHART_HEIGHT - CHART_PAD.bottom);
  });

  it("maps a domain onto a range, and a domain of one value onto the middle", () => {
    expect(linearScale([0, 10], [100, 200])(5)).toBe(150);
    expect(linearScale([3, 3], [100, 200])(3)).toBe(150);
  });
});

describe("stacked areas", () => {
  it("puts each series on top of the ones before it", () => {
    expect(stackBands([[1, 2], [3, 4], [5, 6]])).toEqual([
      { lower: [0, 0], upper: [1, 2] },
      { lower: [1, 2], upper: [4, 6] },
      { lower: [4, 6], upper: [9, 12] },
    ]);
  });

  it("lets a gap add nothing instead of pulling the bands above it to zero", () => {
    expect(stackBands([[1, Number.NaN], [2, 2]])[1]).toEqual({ lower: [1, 0], upper: [3, 2] });
  });
});

describe("telling series apart without colour", () => {
  it("gives each of the most series a chart holds its own shape and line pattern", () => {
    const shapes = Array.from({ length: 8 }, (_, index) => markerShape(index));
    const dashes = Array.from({ length: 8 }, (_, index) => seriesDash(index));
    expect(new Set(shapes).size).toBe(8);
    expect(new Set(dashes).size).toBe(8);
  });

  it("draws every shape as a closed path around its centre", () => {
    for (const shape of MARKER_SHAPES) {
      const d = markerPath(shape, 50, 40, 4);
      expect(d.startsWith("M ")).toBe(true);
      expect(d.trimEnd().endsWith("Z")).toBe(true);
      const numbers = (d.match(/-?\d+(\.\d+)?/gu) ?? []).map(Number);
      expect(numbers.every((value) => Number.isFinite(value))).toBe(true);
    }
  });
});

describe("walking a chart's points with the keyboard", () => {
  it("walks a scatter's points by x, not by row", () => {
    expect(pointOrder([3, 1, 2, 1])).toEqual([1, 3, 2, 0]);
    expect(pointOrder(["W1", "W2"])).toEqual([0, 1]);
    const order = pointOrder([3, 1, 2]);
    expect(movePointCursor("ArrowRight", { series: 0, index: 1 }, [0], order)).toEqual({ series: 0, index: 2 });
    expect(movePointCursor("ArrowRight", { series: 0, index: 2 }, [0], order)).toEqual({ series: 0, index: 0 });
  });

  it("stays on the chart at its ends, and Home and End jump to them", () => {
    const order = [0, 1, 2];
    expect(movePointCursor("ArrowLeft", { series: 0, index: 0 }, [0], order)).toEqual({ series: 0, index: 0 });
    expect(movePointCursor("ArrowRight", { series: 0, index: 2 }, [0], order)).toEqual({ series: 0, index: 2 });
    expect(movePointCursor("End", { series: 0, index: 0 }, [0], order)).toEqual({ series: 0, index: 2 });
    expect(movePointCursor("Home", { series: 0, index: 2 }, [0], order)).toEqual({ series: 0, index: 0 });
  });

  it("moves between shown series on the same row and skips a hidden one", () => {
    const order = [0, 1, 2];
    // Series 1 is hidden, so down from series 0 lands on series 2.
    expect(movePointCursor("ArrowDown", { series: 0, index: 1 }, [0, 2], order)).toEqual({ series: 2, index: 1 });
    expect(movePointCursor("ArrowUp", { series: 2, index: 1 }, [0, 2], order)).toEqual({ series: 0, index: 1 });
    expect(movePointCursor("ArrowUp", { series: 0, index: 1 }, [0, 2], order)).toEqual({ series: 0, index: 1 });
  });

  it("leaves other keys to the page", () => {
    expect(movePointCursor("Tab", { series: 0, index: 0 }, [0], [0])).toBeUndefined();
    expect(movePointCursor("ArrowRight", { series: 0, index: 0 }, [0], [])).toBeUndefined();
  });
});

describe("axes over values a round step cannot divide", () => {
  /** Ticks an axis can draw: a bounded number of finite values, each above the one before. */
  function expectDrawable(ticks: number[], covers: readonly number[]): void {
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS + 1);
    for (const tick of ticks) expect(Number.isFinite(tick)).toBe(true);
    for (let index = 1; index < ticks.length; index += 1) expect(ticks[index]).toBeGreaterThan(ticks[index - 1] ?? 0);
    for (const value of covers) {
      expect(ticks[0]).toBeLessThanOrEqual(value);
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(value);
    }
  }

  it("treats values one float apart as one value instead of stepping between them forever", () => {
    // 0.1 + 0.2 is 0.30000000000000004: a step of 2e-17 added to 0.3 leaves it at 0.3.
    const ticks = niceSpan(0.3, 0.1 + 0.2);
    expectDrawable(ticks, [0.3, 0.1 + 0.2]);
    expect(ticks.length).toBeLessThan(10);
    expect(ticks[0]).toBeLessThan(0.3);
    expect(ticks.at(-1)).toBeGreaterThan(0.1 + 0.2);
  });

  it("does the same at a magnitude where a whole number is below the gap between doubles", () => {
    const ticks = niceSpan(1e17, 1e17 + 16);
    expectDrawable(ticks, [1e17, 1e17 + 16]);
    expect(ticks.length).toBeLessThan(10);
    const labels = formatTicks(ticks);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(8);
  });

  it("puts a single point and all-equal values inside a padded axis", () => {
    for (const value of [42, -3.5, 0, 1e-12, 1e300]) {
      const ticks = niceSpan(value, value);
      expectDrawable(ticks, [value]);
      expect(ticks[0]).toBeLessThan(value);
      expect(ticks.at(-1)).toBeGreaterThan(value);
    }
    expectDrawable(niceRange(4, 4), [0, 4]);
    expectDrawable(niceRange(-4, -4), [-4, 0]);
    expectDrawable(niceTicks(4), [0, 4]);
  });

  it("keeps a 1e-12 scale apart, on the plot and in its labels", () => {
    const ticks = niceSpan(1e-12, 5e-12);
    expectDrawable(ticks, [1e-12, 5e-12]);
    const labels = formatTicks(ticks);
    expect(labels.some((label) => label !== "0")).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    const geometry = chartGeometry(300, [1e-12, 5e-12], ticks);
    expect(geometry.scaleY(5e-12)).toBeLessThan(geometry.scaleY(1e-12) - 50);
    expectDrawable(niceTicks(3e-12), [0, 3e-12]);
    expect(formatTicks(niceTicks(3e-12)).filter((label) => label === "0")).toHaveLength(1);
  });

  it("stays bounded at the edges of what a double holds", () => {
    expectDrawable(niceSpan(0, 5e-324), [0, 5e-324]);
    expectDrawable(niceSpan(-Number.MAX_VALUE, Number.MAX_VALUE), [-Number.MAX_VALUE, Number.MAX_VALUE]);
    expectDrawable(niceRange(-Number.MAX_VALUE, Number.MAX_VALUE), [-Number.MAX_VALUE, Number.MAX_VALUE]);
    expectDrawable(niceTicks(Number.MAX_VALUE), [0, Number.MAX_VALUE]);
    expectDrawable(niceTicks(5e-324), [0, 5e-324]);
    // Asked for more gridlines than an axis draws, it draws the ends instead of thousands of ticks.
    expectDrawable(niceSpan(0, 1, 10_000), [0, 1]);
    expectDrawable(niceRange(-1, 1, 10_000), [-1, 1]);
  });

  it("stays bounded for values near each other anywhere on the number line", () => {
    for (let exponent = -300; exponent <= 300; exponent += 7) {
      const base = 1.234 * 10 ** exponent;
      for (const ulps of [1, 2, 16, 1000]) {
        const next = base + Math.abs(base) * Number.EPSILON * ulps;
        expectDrawable(niceSpan(base, next), [base, next]);
        expectDrawable(niceSpan(-next, -base), [-next, -base]);
      }
    }
  });
});
describe("the series a line chart draws when nothing chose one", () => {
  const sampleRows = [{ week: "W36", runs: 128, failures: 6 }];

  it("draws the sample's runs whichever language its unit is written in", () => {
    expect(defaultLineSeries({ unit: "lần" }, sampleRows)).toBe("runs");
    expect(defaultLineSeries({ unit: "runs" }, sampleRows)).toBe("runs");
  });

  it("draws the first numeric column when the unit mentions runs but the rows have no such column", () => {
    expect(defaultLineSeries({ unit: "test runs" }, [{ day: "Mon", count: 4 }])).toBe("count");
    expect(defaultLineSeries({ unit: "lần chạy" }, [{ day: "T2", count: 4 }])).toBe("count");
  });

  it("prefers the series the props name", () => {
    expect(defaultLineSeries({ series: ["failures"], unit: "runs" }, sampleRows)).toBe("failures");
  });
});
