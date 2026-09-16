import type { WidgetDefinition } from "@clarkcant/contracts";

import { TABLE, WIDGETS } from "./index.ts";
import type { SampleRecipe } from "@clarkcant/core";

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

/** A note widget, declared here so J1 has a local editable surface with no network. */
export const NOTE_DEFINITION: WidgetDefinition = {
  id: "canvas.note@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", maxLength: 120 },
      body: { type: "string", maxLength: 4000 },
    },
    required: ["title"],
  },
  eventSchemas: {
    "draft.changed": { type: "object" },
    "save.requested": { type: "object" },
  },
  stateSchema: {
    type: "object",
    properties: { body: { type: "string" }, revision: { type: "number" } },
  },
  stateVersion: 1,
  semanticDescription: "A personal note stored locally, with a preserved draft",
  requestedCapabilities: [],
  sizing: { compact: true, expanded: true, minHeight: 160 },
  textFallback: "Personal note. The text is shown as plain text when the editor cannot be mounted.",
  effectCategories: ["read"],
  datasetRefs: [],
};

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
  text: string;
  /** Forwarded to the recipe. Dropping it here silently disabled the catch-all marker. */
  catchAll?: boolean;
}): SampleRecipe {
  return {
    id: input.id,
    matches: (text) => input.matches.test(text),
    ...(input.catchAll === undefined ? {} : { catchAll: input.catchAll }),
    build: () => ({
      definition: chartDefinition(input.definitionId),
      packageDigest: "sha256:data-canvas-sample-v1",
      props: { title: "Số lần chạy theo tuần — dữ liệu mẫu", datasetRef: SAMPLE_DATASET.datasetId, unit: "lần" },
      text: input.text,
      actions: Object.entries(chartActions).map(([label, proposal]) => ({ label, proposal })),
    }),
  };
}

const noteRecipe: SampleRecipe = {
  id: "quick-play.note",
  matches: (text) => /(note|ghi chú|checklist|note nhanh)/i.test(text),
  build: () => ({
    definition: NOTE_DEFINITION,
    packageDigest: "sha256:data-canvas-sample-v1",
    props: { title: "Ghi chú của tui", body: "" },
    text: "Đây là một ghi chú chạy hoàn toàn trên máy bạn. Không có mạng, không có model. Bạn có thể ghim nó lại bằng cách nói \"ghim cái này\".",
    actions: [
      { label: "draft.changed", proposal: { kind: "view", operation: "update-draft", args: {} } },
      { label: "save.requested", proposal: { kind: "view", operation: "save-note", args: {} } },
    ],
  }),
};

const tableRecipe: SampleRecipe = {
  id: "quick-play.table",
  matches: (text) => /(bảng|table|dữ liệu|dataset|thống kê)/i.test(text),
  build: () => ({
    definition: TABLE,
    packageDigest: "sha256:data-canvas-sample-v1",
    props: { title: "Bảng dữ liệu mẫu", datasetRef: SAMPLE_DATASET.datasetId, pageSize: 5 },
    text: "Bảng dưới đây là **dữ liệu mẫu**, không phải số liệu thật của bạn. Bấm vào một dòng để chọn, hoặc nói cho tui biết bạn muốn xem gì.",
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
    text: "Biểu đồ đường trên **dữ liệu mẫu**. Nói \"ghim lại\" nếu bạn muốn giữ nó trong khung chat.",
  }),
  chartRecipe({
    id: "quick-play.chart.bar",
    definitionId: "canvas.bar@1",
    matches: /(cột|bar|so sánh)/i,
    text: "Biểu đồ cột trên **dữ liệu mẫu**.",
  }),
  chartRecipe({
    id: "quick-play.chart.default",
    definitionId: "canvas.line@1",
    // Matches everything, deliberately, and is dropped on a node that has a model: see
    // `SampleRecipe.catchAll`. Without the marker this recipe answered every message the user
    // could possibly send, because it ran before the model was ever consulted.
    catchAll: true,
    matches: /.*/s,
    text: "Đây là thứ tui có thể làm ngay mà không cần bạn kết nối gì cả: một biểu đồ trên **dữ liệu mẫu**. Muốn làm việc thật thì mình cần cài thêm capability — cứ nói việc bạn muốn làm.",
  }),
];

export { NOTE_DEFINITION as NOTE_WIDGET };
