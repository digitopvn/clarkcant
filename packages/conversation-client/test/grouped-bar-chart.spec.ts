import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CATALOG, type RendererProps } from "../src/renderers.tsx";

const ROWS = [
  { name: "MMLU", a: 88.1, b: 86.4 },
  { name: "GPQA", a: 59.4, b: 53.6 },
];

function render(state?: Record<string, unknown>): string {
  const renderer = CATALOG["canvas.bar@1"];
  if (renderer === undefined) throw new Error("the bar chart has no renderer");
  const input: RendererProps = {
    definitionId: "canvas.bar@1",
    props: { series: ["a", "b"] },
    dataset: { rows: ROWS, freshness: "cached", updatedAt: "2026-10-08T00:00:00.000Z" },
    state,
  };
  return renderToStaticMarkup(createElement(renderer, input));
}

describe("a bar chart of several series", () => {
  it("draws them side by side with a legend", () => {
    const html = render();
    expect(html).toContain('data-bar-legend="true"');
    expect(html).not.toContain("data-chart-series");
  });

  it("still says so when the surface chose a series the rows do not have", () => {
    const html = render({ filters: { series: "c" } });
    expect(html).toContain('data-chart-series=""');
  });
});
