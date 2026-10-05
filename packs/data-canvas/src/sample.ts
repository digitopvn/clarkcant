import type { WidgetDefinition } from "@clarkcant/contracts";

import { NOTE, TABLE, WIDGETS } from "./index.ts";
import type { SampleRecipe } from "@clarkcant/core";
import { type SampleText, sampleText } from "./sample-text.ts";

/**
 * Scripted sample content for journey J1.
 *
 * The blueprint requires the first journey to work with **no provider credentials**: a
 * visitor should be able to interact with a chart, a note and a pin before deciding
 * whether to connect anything. It also requires that such content is labelled as sample
 * data and never presented as inference over the user's own data.
 *
 * These recipes are selected only when no installed capability can answer the request, so
 * a real integration is never shadowed by a demo. The label itself is emitted as a
 * host-owned card by the conductor, not by the recipe, which means a recipe cannot claim
 * to be live even if it wanted to.
 */

/** Sample rows. Small enough to read, shaped like something a person would recognise. */
export const SAMPLE_DATASET = {
  datasetId: "dataset_fixture_usage",
  source: "sample" as const,
  columns: ["week", "runs", "failures", "medianMinutes"],
  rows: [
    { week: "W36", runs: 128, failures: 6, medianMinutes: 4.2 },
    { week: "W37", runs: 141, failures: 4, medianMinutes: 3.9 },
    { week: "W38", runs: 137, failures: 9, medianMinutes: 4.6 },
    { week: "W39", runs: 164, failures: 3, medianMinutes: 3.4 },
    { week: "W40", runs: 158, failures: 5, medianMinutes: 3.6 },
  ],
} as const;

/**
 * The note widget's definition lives in `./index.ts`, outside `WIDGETS`.
 *
 * Kept as a local alias so the J1 recipe and the `NOTE_WIDGET` export below do not have to change.
 */
const NOTE_DEFINITION: WidgetDefinition = NOTE;

/** View-only actions. They need no capability, which is why J1 works offline. */
const tableActions = {
  "row.select": { kind: "view", operation: "select-row", args: {} },
  "export.requested": { kind: "view", operation: "export-csv", args: {} },
} as const;

const chartActions = {
  "series.toggle": { kind: "view", operation: "toggle-series", args: {} },
} as const;

function chartDefinition(id: string): WidgetDefinition {
  const base = WIDGETS.find((widget) => widget.id === id);
  if (!base) throw new Error(`the data-canvas pack does not define ${id}`);
  return base;
}

function chartRecipe(input: {
  id: string;
  definitionId: string;
  matches: RegExp;
  /** Which of the samples' sentences answers this recipe, in the person's language. */
  text: keyof Pick<SampleText, "lineChart" | "barChart" | "defaultChart">;
  /** Forwarded to the recipe. Dropping it here silently disabled the catch-all marker. */
  catchAll?: boolean;
}): SampleRecipe {
  return {
    id: input.id,
    matches: (text) => input.matches.test(text),
    ...(input.catchAll === undefined ? {} : { catchAll: input.catchAll }),
    build: ({ locale }) => {
      const say = sampleText(locale);
      return {
        definition: chartDefinition(input.definitionId),
        packageDigest: "sha256:data-canvas-sample-v1",
        props: { title: say.chartTitle, datasetRef: SAMPLE_DATASET.datasetId, unit: say.chartUnit },
        text: say[input.text],
        actions: Object.entries(chartActions).map(([label, proposal]) => ({ label, proposal })),
      };
    },
  };
}

const noteRecipe: SampleRecipe = {
  id: "quick-play.note",
  matches: (text) => /(note|ghi chú|checklist|note nhanh)/i.test(text),
  build: ({ locale }) => ({
    definition: NOTE_DEFINITION,
    packageDigest: "sha256:data-canvas-sample-v1",
    props: { title: sampleText(locale).noteTitle, body: "" },
    text: sampleText(locale).note,
    actions: [
      { label: "draft.changed", proposal: { kind: "view", operation: "update-draft", args: {} } },
      { label: "save.requested", proposal: { kind: "view", operation: "save-note", args: {} } },
    ],
  }),
};

const tableRecipe: SampleRecipe = {
  id: "quick-play.table",
  matches: (text) => /(bảng|table|dữ liệu|dataset|thống kê)/i.test(text),
  build: ({ locale }) => ({
    definition: TABLE,
    packageDigest: "sha256:data-canvas-sample-v1",
    props: { title: sampleText(locale).tableTitle, datasetRef: SAMPLE_DATASET.datasetId, pageSize: 5 },
    text: sampleText(locale).table,
    actions: Object.entries(tableActions).map(([label, proposal]) => ({ label, proposal })),
  }),
};

/**
 * The J1 recipe set, most specific first.
 *
 * A generic "show me something" falls through to the chart, so the empty state has a
 * useful default without the user having to guess a keyword.
 */
export const QUICK_PLAY_RECIPES: readonly SampleRecipe[] = [
  noteRecipe,
  tableRecipe,
  chartRecipe({
    id: "quick-play.chart.line",
    definitionId: "canvas.line@1",
    matches: /(chart|biểu đồ|đồ thị|xu hướng|trend)/i,
    text: "lineChart",
  }),
  chartRecipe({
    id: "quick-play.chart.bar",
    definitionId: "canvas.bar@1",
    matches: /(cột|bar|so sánh)/i,
    text: "barChart",
  }),
  chartRecipe({
    id: "quick-play.chart.default",
    definitionId: "canvas.line@1",
    // Matches everything, deliberately, and is dropped on a node that has a model: see
    // `SampleRecipe.catchAll`. Without the marker this recipe answered every message the user
    // could possibly send, because it ran before the model was ever consulted.
    catchAll: true,
    matches: /.*/s,
    text: "defaultChart",
  }),
];

export { NOTE_DEFINITION as NOTE_WIDGET };
