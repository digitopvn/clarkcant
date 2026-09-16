import type { WidgetDefinition } from "@clarkcant/contracts";

/**
 * Data canvas pack: the catalog widget descriptors used for charts, tables, maps and
 * timelines over dataset references.
 *
 * Widgets take opaque dataset references rather than inline rows, so a large result
 * set never enters the conversation transcript and freshness can be reported next to
 * the view that depends on it.
 */

const datasetProp = {
  type: "string",
  description: "Opaque dataset reference resolved by the host, never an inline row set",
};

function chart(id: string, summary: string): WidgetDefinition {
  return {
    id,
    version: "1.0.0",
    renderer: "catalog",
    propsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", maxLength: 200 },
        datasetRef: datasetProp,
        series: { type: "array", items: { type: "string" }, maxItems: 8 },
        unit: { type: "string", maxLength: 40 },
        timezone: { type: "string", maxLength: 60 },
      },
      required: ["datasetRef"],
    },
    eventSchemas: { "series.toggle": { type: "object" } },
    stateSchema: { type: "object", properties: { hiddenSeries: { type: "array" } } },
    stateVersion: 1,
    semanticDescription: summary,
    requestedCapabilities: [],
    sizing: { compact: true, expanded: true, minHeight: 180 },
    textFallback: `${summary} (the dataset is displayed as text when the chart cannot be rendered)`,
    effectCategories: ["read"],
    datasetRefs: [],
  };
}

export const LINE_CHART = chart("canvas.line@1", "Line chart over a dataset reference");
export const BAR_CHART = chart("canvas.bar@1", "Bar chart over a dataset reference");
export const DONUT_CHART = chart("canvas.donut@1", "Donut chart over a dataset reference");

/**
 * A table.
 *
 * Sorting and filtering happen against the dataset view, and exports are requested
 * as a host action so formula injection is handled by the host rather than by an
 * arbitrary in-widget implementation.
 */
export const TABLE: WidgetDefinition = {
  id: "canvas.table@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", maxLength: 200 },
      datasetRef: datasetProp,
      pageSize: { type: "number" },
      columns: { type: "array", items: { type: "string" }, maxItems: 40 },
    },
    required: ["datasetRef"],
  },
  eventSchemas: {
    "row.select": { type: "object" },
    "export.requested": { type: "object" },
  },
  stateSchema: { type: "object", properties: { sort: { type: "object" }, page: { type: "number" } } },
  stateVersion: 1,
  semanticDescription:
    "Sortable, filterable and paged table over a dataset reference, with CSV export requested through the host",
  requestedCapabilities: [],
  sizing: { compact: false, expanded: true, minHeight: 240 },
  textFallback: "A table is displayed as text when it cannot be rendered.",
  effectCategories: ["read"],
  datasetRefs: [],
};

export const WIDGETS = [LINE_CHART, BAR_CHART, DONUT_CHART, TABLE];

/**
 * @implementation-status stub
 * TODO(P6): the renderer components and the dataset view layer. The descriptors,
 * their prop schemas, sizing constraints and text alternatives are real and are what
 * the catalog registry, the props validator and the sandbox policy consume; the React
 * components that draw them are not implemented.
 */
export const RENDERER_STATUS = "descriptors-real-renderers-pending";
