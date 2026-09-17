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

/* ------------------------------------------------------------------ *
 * Composite surface
 * ------------------------------------------------------------------ */

/**
 * The host container.
 *
 * One logical instance holding several leaf sections. It owns no data and no actions of its own:
 * its props name the composition document the host compiled, and the document names the leaves.
 * That indirection is what keeps the container a layout rather than a widget that happens to be
 * large.
 */
export const OVERVIEW: WidgetDefinition = {
  id: "canvas.overview@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      compositionId: { type: "string", maxLength: 128 },
      templateId: { type: "string", maxLength: 120 },
      period: { type: "string", maxLength: 20 },
      title: { type: "string", maxLength: 200 },
    },
    required: ["compositionId"],
  },
  eventSchemas: {
    "period.change": { type: "object" },
    "date.select": { type: "object" },
    "view.save": { type: "object" },
  },
  stateSchema: {
    type: "object",
    properties: { period: { type: "string" }, selectedDate: { type: "string" } },
  },
  stateVersion: 1,
  semanticDescription:
    "Composed overview of local data: summary metrics, a period selector, a trend chart, a calendar, an image and a save action",
  requestedCapabilities: [],
  sizing: { compact: true, expanded: true, minHeight: 320 },
  textFallback:
    "An overview of local work data is shown as text when it cannot be rendered: see the summary below each region.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** Summary figures. Values are computed by the host from local records, never invented. */
export const METRICS: WidgetDefinition = {
  id: "canvas.metrics@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      datasetRef: datasetProp,
      title: { type: "string", maxLength: 200 },
      unit: { type: "string", maxLength: 40 },
    },
    required: ["datasetRef"],
  },
  eventSchemas: {},
  sizing: { compact: true, expanded: true, minHeight: 96 },
  semanticDescription: "A row of summary figures over a dataset reference, each with its label and unit",
  requestedCapabilities: [],
  textFallback: "Summary figures are listed as text when the tiles cannot be rendered.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** Period selector. Changing it re-queries the host; it never calls a model. */
export const FILTER: WidgetDefinition = {
  id: "canvas.filter@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      period: { type: "string", maxLength: 20 },
      timezone: { type: "string", maxLength: 60 },
      title: { type: "string", maxLength: 200 },
    },
    required: ["period", "timezone"],
  },
  eventSchemas: { "period.change": { type: "object" } },
  stateSchema: { type: "object", properties: { period: { type: "string" } } },
  stateVersion: 1,
  sizing: { compact: true, expanded: false, minHeight: 48 },
  semanticDescription: "A week/month period selector that re-queries local data",
  requestedCapabilities: [],
  textFallback: "A period selector appears as text: the current period is named in the caption.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/**
 * Local calendar.
 *
 * Local events only. Nothing here reads a provider calendar, and the renderer says so rather than
 * letting a user assume a sync that does not exist.
 */
export const CALENDAR: WidgetDefinition = {
  id: "canvas.calendar@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      datasetRef: datasetProp,
      month: { type: "string", maxLength: 10 },
      timezone: { type: "string", maxLength: 60 },
      title: { type: "string", maxLength: 200 },
    },
    required: ["datasetRef", "month"],
  },
  eventSchemas: { "date.select": { type: "object" } },
  stateSchema: { type: "object", properties: { selectedDate: { type: "string" } } },
  stateVersion: 1,
  sizing: { compact: true, expanded: true, minHeight: 260 },
  semanticDescription: "A month view of local calendar events, with event details for the selected day",
  requestedCapabilities: [],
  textFallback: "Calendar events are listed as text when the month view cannot be rendered.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** An imported image, served by the host under an opaque reference. */
export const IMAGE: WidgetDefinition = {
  id: "canvas.image@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      imageRef: datasetProp,
      alt: { type: "string", maxLength: 300 },
      title: { type: "string", maxLength: 200 },
    },
    required: ["imageRef", "alt"],
  },
  eventSchemas: {},
  sizing: { compact: true, expanded: true, minHeight: 160 },
  semanticDescription: "A locally imported image, described by its required alt text",
  requestedCapabilities: [],
  textFallback: "An imported image is described in text when it cannot be displayed.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** The one action in the M1 vocabulary: save the current view and pin it. */
export const CTA: WidgetDefinition = {
  id: "canvas.cta@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      label: { type: "string", maxLength: 120 },
      actionId: { type: "string", maxLength: 128 },
      description: { type: "string", maxLength: 300 },
    },
    required: ["label", "actionId"],
  },
  eventSchemas: { "view.save": { type: "object" } },
  sizing: { compact: true, expanded: true, minHeight: 56 },
  semanticDescription: "A single call to action that saves the current view; it starts no task",
  requestedCapabilities: [],
  textFallback: "An action was offered here. It is available again when the surface can be rendered.",
  effectCategories: ["local-write"],
  datasetRefs: [],
};

export const WIDGETS = [
  LINE_CHART,
  BAR_CHART,
  DONUT_CHART,
  TABLE,
  OVERVIEW,
  METRICS,
  FILTER,
  CALENDAR,
  IMAGE,
  CTA,
];

/**
 * Catalog family per definition.
 *
 * The family is what a candidate set filters on and what the release gate requires a fixture for
 * (docs/widgets-and-extensions.md §4). It lives beside the descriptors rather than inside the
 * contract because it is a property of this catalog, not of the widget format.
 */
export const FAMILY_BY_DEFINITION: Record<string, string> = {
  "canvas.overview@1": "layout",
  "canvas.metrics@1": "metrics",
  "canvas.filter@1": "filter",
  "canvas.line@1": "trend",
  "canvas.bar@1": "trend",
  "canvas.donut@1": "trend",
  "canvas.table@1": "tables",
  "canvas.calendar@1": "calendar",
  "canvas.image@1": "media",
  "canvas.cta@1": "cta",
};

export function familyOf(definitionId: string): string {
  return FAMILY_BY_DEFINITION[definitionId] ?? "unknown";
}

/**
 * The descriptors, their prop schemas, sizing constraints and text alternatives are what the
 * catalog registry, the props validator and the sandbox policy consume. The React components that
 * draw each family live in `@clarkcant/conversation-client`, and the two are kept apart because a
 * pack describes a widget while the client is what draws one.
 */
export const RENDERER_STATUS = "descriptors-real-renderers-in-conversation-client";
