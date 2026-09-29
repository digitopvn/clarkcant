import { describe, expect, it } from "vitest";

import { XY_CHART_KIND, readXyChart, validateProps, xyChartData, xyChartProblems, xyChartViewProblems } from "@clarkcant/contracts";
import { AREA_CHART, SCATTER_CHART } from "@clarkcant/data-canvas";

import { fixturesFor } from "../src/fixtures.ts";

/**
 * The area and scatter charts' JSON Schema, which the model reads, and the charts' own rules, which the node places by,
 * accept and refuse the same props; and every library fixture is one the node would place, over its own rows, with a
 * view the node would keep.
 */

const BAD: Record<string, Record<string, unknown>[]> = {
  [AREA_CHART.id]: [
    { datasetRef: "ds", y: ["runs"] },
    { datasetRef: "ds", x: "week" },
    { datasetRef: "ds", x: "week", y: [] },
    { datasetRef: "ds", x: "", y: ["runs"] },
    { datasetRef: "ds", x: "   ", y: ["runs"] },
    { datasetRef: "ds", x: "w‮eek", y: ["runs"] },
    { datasetRef: "ds", x: "x".repeat(65), y: ["runs"] },
    { datasetRef: "ds", x: "week", y: Array.from({ length: 9 }, (_, index) => `s${String(index)}`) },
    { datasetRef: "ds", x: "week", y: ["runs"], stacked: "yes" },
    { datasetRef: "ds", x: "week", y: ["runs"], pointLabel: "week" },
    { datasetRef: "ds", x: "week", y: ["runs"], labels: { runs: "" } },
    { datasetRef: "ds", x: "week", y: ["runs"], labels: { runs: "Up\nDown" } },
    { datasetRef: "ds", x: "week", y: ["runs"], live: true },
    { x: "week", y: ["runs"] },
  ],
  [SCATTER_CHART.id]: [
    { datasetRef: "ds", x: "load", y: ["latency"], stacked: true },
    { datasetRef: "ds", x: "load", y: ["latency"], pointLabel: "" },
    { datasetRef: "ds", x: "load", y: ["latency"], xUnit: "m\ts" },
  ],
};

const GOOD: Record<string, Record<string, unknown>[]> = {
  [AREA_CHART.id]: [{ datasetRef: "ds", x: " week", y: ["runs"], title: " ", stacked: false }],
  [SCATTER_CHART.id]: [{ datasetRef: "ds", x: "load", y: ["latency", "p95"], pointLabel: "host", xUnit: "%" }],
};

describe("area and scatter chart schemas", () => {
  for (const definition of [AREA_CHART, SCATTER_CHART]) {
    const kind = XY_CHART_KIND[definition.id];
    if (kind === undefined) throw new Error(`${definition.id} is not an area or scatter chart`);

    it(`${definition.id}: the JSON Schema and the chart's own schema accept and refuse the same props`, () => {
      const cases = [
        ...fixturesFor(definition.id).map((fixture) => fixture.props as Record<string, unknown>),
        ...(GOOD[definition.id] ?? []),
        ...(BAD[definition.id] ?? []),
      ];
      for (const props of cases) {
        const json = validateProps(definition, props).ok;
        const own = xyChartProblems(kind, props).length === 0;
        expect({ props, json }).toEqual({ props, json: own });
      }
      for (const props of BAD[definition.id] ?? []) expect(validateProps(definition, props).ok, JSON.stringify(props)).toBe(false);
    });

    it(`${definition.id}: every library fixture is one the node would place over its own rows, with a view it would keep`, () => {
      const fixtures = fixturesFor(definition.id);
      expect(fixtures.some((fixture) => fixture.id.endsWith(".normal"))).toBe(true);
      for (const fixture of fixtures) {
        const rows = fixture.dataset?.rows ?? [];
        expect(xyChartProblems(kind, fixture.props, rows, fixture.dataset?.columns), fixture.id).toEqual([]);
        const chart = readXyChart(kind, fixture.props);
        if (chart === undefined) throw new Error(`${fixture.id} does not describe a chart`);
        if (fixture.state !== undefined) {
          expect(xyChartViewProblems(chart, fixture.state, xyChartData(chart, rows).shown), fixture.id).toEqual([]);
        }
      }
    });
  }

  it("shows a truncated chart in the library, so the label that says so is seen", () => {
    const truncated = fixturesFor(SCATTER_CHART.id).find((fixture) => fixture.id === "scatter.truncated");
    const chart = truncated === undefined ? undefined : readXyChart("scatter", truncated.props);
    if (truncated === undefined || chart === undefined) throw new Error("no truncated scatter fixture");
    const data = xyChartData(chart, truncated.dataset?.rows ?? []);
    expect(data.total).toBeGreaterThan(data.shown);
  });
});
