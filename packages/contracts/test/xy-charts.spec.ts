import { describe, expect, it } from "vitest";

import {
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
  SEMANTIC_LIMITS,
  normalizeSemanticDoc,
  readXyChart,
  readXyChartView,
  xyChartData,
  xyChartDataProblems,
  xyChartProblems,
  xyChartSemantic,
  xyChartText,
  xyChartViewProblems,
  xyPointText,
} from "../src/index.ts";

/**
 * Area and scatter charts: the fields are named, never guessed; rows that do not fit are refused with the reason; and
 * what a person changes on the chart is a view the node checks against the chart it is set on.
 */

const ROWS = [
  { week: "W36", runs: 128, failures: 6, minutes: 4.2 },
  { week: "W37", runs: 141, failures: 4, minutes: 3.9 },
  { week: "W38", runs: 137, failures: 9, minutes: 4.6 },
  { week: "W39", runs: 164, failures: 3, minutes: 3.4 },
  { week: "W40", runs: 158, failures: 5, minutes: 3.6 },
];

const AREA = { title: "Runs by week", datasetRef: "ds", x: "week", y: ["runs", "failures"], labels: { runs: "Runs", failures: "Failures" }, unit: "runs" };
const SCATTER = { datasetRef: "ds", x: "minutes", y: ["runs"], pointLabel: "week", labels: { minutes: "Minutes" }, xUnit: "min" };

function area(props: Record<string, unknown> = {}) {
  const chart = readXyChart("area", { ...AREA, ...props });
  if (chart === undefined) throw new Error("the area props do not describe a chart");
  return chart;
}

function scatter(props: Record<string, unknown> = {}) {
  const chart = readXyChart("scatter", { ...SCATTER, ...props });
  if (chart === undefined) throw new Error("the scatter props do not describe a chart");
  return chart;
}

describe("xy charts: props", () => {
  it("accepts named fields and reads labels and defaults", () => {
    expect(xyChartProblems("area", AREA, ROWS)).toEqual([]);
    expect(xyChartProblems("scatter", SCATTER, ROWS)).toEqual([]);
    expect(area()).toMatchObject({ kind: "area", x: "week", y: ["runs", "failures"], stacked: false, unit: "runs" });
    expect(scatter()).toMatchObject({ kind: "scatter", pointLabel: "week", xUnit: "min", stacked: false });
  });

  it("never infers a field: x and y are required", () => {
    expect(xyChartProblems("area", { datasetRef: "ds", y: ["runs"] }).join(" ")).toMatch(/"x"/u);
    expect(xyChartProblems("area", { datasetRef: "ds", x: "week" }).join(" ")).toMatch(/"y"/u);
    expect(xyChartProblems("area", { datasetRef: "ds", x: "week", y: [] }).join(" ")).toMatch(/names no series/u);
  });

  it("refuses a series named twice, x as a series, a label for nothing and too many series", () => {
    expect(xyChartProblems("area", { ...AREA, y: ["runs", "runs"], labels: {} })).toEqual(['"y" names "runs" twice; each series is named once']);
    expect(xyChartProblems("area", { ...AREA, y: ["runs", "week"], labels: {} })).toEqual(['"week" is both "x" and a series in "y"; a field is plotted on one axis']);
    expect(xyChartProblems("area", { ...AREA, labels: { cost: "Cost" } })).toEqual(['"labels" names "cost", which is not a field this chart plots']);
    const many = Array.from({ length: MAX_CHART_SERIES + 1 }, (_, index) => `s${String(index)}`);
    expect(xyChartProblems("area", { ...AREA, y: many, labels: {} }).join(" ")).toMatch(/more than 8 series/u);
    expect(readXyChart("area", { ...AREA, y: ["runs", "runs"] })).toBeUndefined();
  });

  it("keeps a field name exactly as written, and refuses a hidden character in it", () => {
    expect(readXyChart("area", { ...AREA, y: [" runs"], labels: {} })?.y).toEqual([" runs"]);
    expect(xyChartProblems("area", { ...AREA, x: `we${String.fromCodePoint(0x202e)}ek` }).join(" ")).toMatch(/U\+202E/u);
  });

  it("takes stacked only on an area and pointLabel only on a scatter", () => {
    expect(xyChartProblems("scatter", { ...SCATTER, stacked: true }).join(" ")).toMatch(/stacked/u);
    expect(xyChartProblems("area", { ...AREA, pointLabel: "week" }).join(" ")).toMatch(/pointLabel/u);
  });
});

describe("xy charts: rows", () => {
  it("refuses a named field the rows do not have, and says which fields they have", () => {
    expect(xyChartProblems("area", { ...AREA, y: ["runs", "cost"], labels: {} }, ROWS)).toEqual([
      'the dataset has no field "cost"; its fields are "week", "runs", "failures", "minutes"',
    ]);
  });

  it("checks an empty dataset against its declared columns, and accepts it when they have the fields", () => {
    expect(xyChartProblems("area", AREA, [], ["week", "runs"])).toEqual([
      'the dataset has no field "failures"; its fields are "week", "runs"',
    ]);
    expect(xyChartProblems("area", AREA, [], ["week", "runs", "failures"])).toEqual([]);
    expect(xyChartProblems("area", AREA, [])).toEqual([]);
  });

  it("refuses a value that is not a number, with the row and the value", () => {
    const rows = ROWS.map((row, index) => (index === 2 ? { ...row, runs: "n/a" } : row));
    expect(xyChartProblems("area", AREA, rows)).toEqual(['row 3\'s "runs" is "n/a", not a number']);
    // A numeric string is still text: a chart does not decide what a string means.
    expect(xyChartProblems("area", AREA, [{ ...ROWS[0], runs: "12" }])).toEqual(['row 1\'s "runs" is "12", not a number']);
  });

  it("refuses a row missing a series value or its x", () => {
    const { failures: _gone, ...noFailures } = ROWS[1] as Record<string, unknown>;
    expect(xyChartProblems("area", AREA, [ROWS[0], noFailures])).toEqual(['row 2 has no "failures"']);
    expect(xyChartProblems("area", AREA, [{ ...ROWS[0], week: null }])).toEqual(['row 1 has no "week"']);
  });

  it("needs a scatter's x to be a number", () => {
    expect(xyChartProblems("scatter", { ...SCATTER, x: "week", labels: {} }, ROWS)[0]).toBe('row 1\'s "week" is "W36", not a number');
  });

  it("needs an area's numeric x to rise row by row, and not to mix numbers and text", () => {
    const years = [{ year: 2021, v: 1 }, { year: 2019, v: 2 }];
    expect(xyChartProblems("area", { datasetRef: "ds", x: "year", y: ["v"] }, years)).toEqual([
      'row 2\'s "year" (2019) is not after row 1\'s (2021); numbers on the x axis must rise row by row',
    ]);
    const mixed = [{ year: 2021, v: 1 }, { year: "later", v: 2 }];
    expect(xyChartProblems("area", { datasetRef: "ds", x: "year", y: ["v"] }, mixed)[0]).toMatch(/all numbers or all text/u);
  });

  it("refuses a negative value on a stacked area only", () => {
    const rows = [{ week: "W1", runs: 3, failures: -1 }];
    expect(xyChartProblems("area", AREA, rows)).toEqual([]);
    expect(xyChartProblems("area", { ...AREA, stacked: true }, rows)).toEqual([
      'row 1\'s "failures" is -1; a stacked area adds its series, so none of them can be negative',
    ]);
  });

  it("says at most five row problems and counts the rest", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({ week: `W${String(index)}`, runs: "x", failures: 1 }));
    const problems = xyChartProblems("area", AREA, rows);
    expect(problems).toHaveLength(6);
    expect(problems.at(-1)).toBe("and 4 more problem(s) in the same rows");
  });

  it("reads only the rows it draws, and bounds the points with the count left out", () => {
    const rows = Array.from({ length: MAX_CHART_POINTS + 20 }, (_, index) => ({ minutes: index, runs: index * 2, week: `P${String(index)}` }));
    // A bad row past the limit is never drawn, so it cannot refuse the chart.
    rows.push({ minutes: Number.NaN, runs: 0, week: "late" });
    expect(xyChartDataProblems(scatter(), rows)).toEqual([]);
    const data = xyChartData(scatter(), rows);
    expect(data.shown).toBe(MAX_CHART_POINTS);
    expect(data.total).toBe(MAX_CHART_POINTS + 21);
    expect(xyChartText(scatter(), data)).toContain(`the first ${String(MAX_CHART_POINTS)} of ${String(MAX_CHART_POINTS + 21)} rows`);
  });
});

describe("xy charts: view", () => {
  it("accepts hiding some series and selecting a point of a shown one", () => {
    expect(xyChartViewProblems(area(), { hiddenSeries: ["failures"], selected: { series: "runs", index: 4 } }, 5)).toEqual([]);
    expect(xyChartViewProblems(area(), { hiddenSeries: [], selected: null }, 5)).toEqual([]);
    expect(xyChartViewProblems(area(), {}, 5)).toEqual([]);
  });

  it("keeps at least one series shown", () => {
    expect(xyChartViewProblems(area(), { hiddenSeries: ["runs", "failures"] }, 5)).toEqual(["at least one series stays shown"]);
  });

  it("refuses a series the chart does not have, twice hidden, or an extra key", () => {
    expect(xyChartViewProblems(area(), { hiddenSeries: ["cost"] }, 5)).toEqual(['"cost" is not a series of this chart']);
    expect(xyChartViewProblems(area(), { hiddenSeries: ["runs", "runs"] }, 5)).toEqual(['"runs" is hidden twice']);
    expect(xyChartViewProblems(area(), { hiddenSeries: [], zoom: 2 }, 5)).toEqual(["a chart view carries hiddenSeries and selected, not zoom"]);
  });

  it("refuses a point off the chart, on a hidden series, or not a whole number", () => {
    expect(xyChartViewProblems(area(), { selected: { series: "runs", index: 5 } }, 5)).toEqual([
      "point 5 is not on this chart, which draws 5 point(s)",
    ]);
    expect(xyChartViewProblems(area(), { hiddenSeries: ["runs"], selected: { series: "runs", index: 0 } }, 5)).toEqual([
      '"runs" is hidden, so none of its points can be selected',
    ]);
    expect(xyChartViewProblems(area(), { selected: { series: "runs", index: 1.5 } }, 5)).toEqual(["a selected point's index is a whole number"]);
    expect(xyChartViewProblems(area(), { selected: { series: "cost", index: 0 } }, 5)).toEqual(["the selected point is not on a series of this chart"]);
  });

  it("reads a stored view leniently: what no longer fits is dropped", () => {
    expect(readXyChartView(area(), { hiddenSeries: ["runs", "cost", "runs"], selected: { series: "failures", index: 9 } }, 5)).toEqual({
      hiddenSeries: ["runs"],
    });
    expect(readXyChartView(area(), { hiddenSeries: ["runs", "failures"] })).toEqual({ hiddenSeries: [] });
    expect(readXyChartView(area(), undefined)).toEqual({ hiddenSeries: [] });
  });
});

describe("xy charts: text and semantic state", () => {
  it("says what the chart shows as text, from the rows it drew", () => {
    const chart = area();
    expect(xyChartText(chart, xyChartData(chart, ROWS))).toBe(
      "Runs by week: Area chart of Runs, Failures by week, 5 point(s); W36 to W40. Runs: 128 to 164 runs; Failures: 3 to 9 runs.",
    );
    expect(xyChartText(area({ stacked: true }), xyChartData(chart, []))).toBe("Runs by week: Stacked area chart of Runs, Failures by week. No data yet.");
  });

  it("describes a point in words", () => {
    const chart = scatter();
    const data = xyChartData(chart, ROWS);
    expect(xyPointText(chart, data, "runs", 1)).toBe("runs at Minutes 3.9 min: 141 (W37)");
    expect(xyPointText(area(), xyChartData(area(), ROWS), "failures", 2)).toBe("Failures at W38: 9 runs");
  });

  it("names the shown and hidden series, their ranges and the selected point", () => {
    const chart = area();
    const meaning = xyChartSemantic(chart, xyChartData(chart, ROWS), { hiddenSeries: ["failures"], selected: { series: "runs", index: 2 } });
    expect(meaning.summary).toBe("Area chart of Runs by week: 5 point(s); hidden: Failures");
    expect(meaning.values).toMatchObject({
      chart: "area",
      series: ["Runs"],
      hiddenSeries: ["Failures"],
      points: 5,
      ranges: ["Runs: 128 to 164 runs"],
      xRange: "W36 to W40",
      selectedPoint: "Runs at W38: 137 runs",
    });
    expect(meaning.selectedIds).toEqual(["runs#2"]);
    const doc = normalizeSemanticDoc({ instanceId: "wi_1", definitionId: "canvas.area@1", ...meaning });
    expect(new TextEncoder().encode(JSON.stringify(doc)).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.bytes);
  });

  it("says a selected point is gone when the rows no longer have it, and a dataset that is gone", () => {
    const chart = area();
    const shrunk = xyChartSemantic(chart, xyChartData(chart, ROWS.slice(0, 2)), { hiddenSeries: [], selected: { series: "runs", index: 4 } });
    expect(shrunk.values.selectedPoint).toBe("Runs point 5, which is no longer in the data");
    expect(shrunk.selectedIds).toEqual([]);
    const gone = xyChartSemantic(chart, undefined, { hiddenSeries: [] });
    expect(gone.summary).toBe("Area chart of Runs, Failures by week; its dataset is not available on this node");
  });

  it("says when only the first rows are drawn", () => {
    const chart = scatter();
    const rows = Array.from({ length: MAX_CHART_POINTS + 1 }, (_, index) => ({ minutes: index, runs: 1, week: "W" }));
    const meaning = xyChartSemantic(chart, xyChartData(chart, rows), { hiddenSeries: [] });
    expect(meaning.values.truncated).toBe(`the first ${String(MAX_CHART_POINTS)} of ${String(MAX_CHART_POINTS + 1)} rows`);
    expect(meaning.values.xRange).toBe(`Minutes: 0 to ${String(MAX_CHART_POINTS - 1)} min`);
  });
});
