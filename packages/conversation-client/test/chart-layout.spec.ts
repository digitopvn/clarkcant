import { describe, expect, it } from "vitest";

import { formatTick, labelStride, MIN_LABEL_SLOT, niceTicks } from "../src/chart-layout.ts";

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
