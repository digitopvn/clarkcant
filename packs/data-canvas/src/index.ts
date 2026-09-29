import {
  AS_OF_PATTERN,
  CHOICE_KINDS,
  INPUT_KINDS,
  LIST_PAGE_SIZES,
  MAX_DETAIL_ITEMS,
  MAX_FIELD_OPTIONS,
  MAX_FORM_FIELDS,
  MAX_LIST_ITEMS,
  MAX_PROGRESS_STEPS,
  MAX_TEXT_LENGTH,
  ONE_LINE_PATTERN,
  ONE_LINE_REQUIRED_PATTERN,
  STATUS_TONES,
  STEP_STATUSES,
  type StatusCardKind,
  type WidgetDefinition,
  checkField,
  checkFieldValue,
  checkFields,
  checkListItems,
  fieldFromProps,
  parseFields,
  parseListItems,
  statusCardProblems,
} from "@clarkcant/contracts";

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

const tableColumnKey = { type: "string", minLength: 1, maxLength: 200 };

const tableSortSchema = {
  type: "object",
  additionalProperties: false,
  properties: { column: tableColumnKey, direction: { type: "string", enum: ["asc", "desc"] } },
  required: ["column", "direction"],
};

const tableFiltersSchema = {
  type: "object",
  description: "Exact-match filters by field; values are strings, numbers, booleans or null (empty)",
  additionalProperties: { type: ["string", "number", "boolean", "null"] },
  maxProperties: 20,
};

/**
 * A table.
 *
 * Every property after `datasetRef` is optional and was added without changing the id, so a
 * `canvas.table@1` written before them still renders as it did. The view (sort, search,
 * filters, page, totals) is computed by `tableView` in `@clarkcant/contracts`, which the node
 * runs too: an export is a host route that re-reads the instance's own dataset and writes
 * the rows the person was looking at, with formula injection defused by the host rather
 * than by an in-widget implementation.
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
      pageSize: { type: "number", minimum: 5, maximum: 200, multipleOf: 1, default: 25 },
      columns: {
        type: "array",
        description: "Columns in display order; when absent, the first row's fields are shown",
        maxItems: 40,
        items: {
          oneOf: [
            tableColumnKey,
            {
              type: "object",
              additionalProperties: false,
              properties: {
                key: tableColumnKey,
                label: { type: "string", maxLength: 120 },
                type: { type: "string", enum: ["text", "number", "date", "datetime", "boolean"] },
                format: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    decimals: { type: "number", minimum: 0, maximum: 6, multipleOf: 1 },
                    unit: { type: "string", maxLength: 16 },
                    style: { type: "string", enum: ["percent"] },
                  },
                },
                align: { type: "string", enum: ["start", "center", "end"] },
              },
              required: ["key"],
            },
          ],
        },
      },
      rowIdField: {
        type: "string",
        maxLength: 200,
        description: "Field holding a stable row id; defaults to `id`, else rows are identified by position",
      },
      selection: { type: "string", enum: ["none", "single", "multi"], default: "single" },
      totals: {
        type: "array",
        maxItems: 40,
        items: {
          type: "object",
          additionalProperties: false,
          properties: { column: tableColumnKey, fn: { type: "string", enum: ["sum", "avg", "min", "max", "count"] } },
          required: ["column", "fn"],
        },
      },
      searchable: { type: "boolean" },
    },
    required: ["datasetRef"],
  },
  eventSchemas: {
    "row.select": {
      type: "object",
      description: "The selected rows by id; row contents never travel in the event",
      additionalProperties: false,
      properties: { rowIds: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 64 } },
      required: ["rowIds"],
    },
    "export.requested": {
      type: "object",
      description: "Asks the host for a CSV of the current view; the host reads the dataset itself",
      additionalProperties: false,
      properties: {
        sort: tableSortSchema,
        query: { type: "string", maxLength: 200 },
        filters: tableFiltersSchema,
        columns: { type: "array", items: tableColumnKey, maxItems: 40 },
      },
    },
  },
  stateSchema: {
    type: "object",
    properties: {
      sort: tableSortSchema,
      page: { type: "number", minimum: 1, multipleOf: 1 },
      query: { type: "string", maxLength: 200 },
      filters: tableFiltersSchema,
      selectedIds: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 64 },
    },
  },
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

/**
 * Several imported images, seen one at a time.
 *
 * The alternative texts are required and paired with the pictures by position, because an image without one is
 * an image some people cannot use at all: the catalog's single-image widget already refuses to be drawn without
 * alt text, and a carousel that did not would be the same failure with more pictures.
 */
export const CAROUSEL: WidgetDefinition = {
  id: "canvas.carousel@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      imageRefs: { type: "array", items: datasetProp, minItems: 1, maxItems: 24 },
      alts: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 24 },
      title: { type: "string", maxLength: 200 },
    },
    required: ["imageRefs", "alts"],
  },
  eventSchemas: {},
  sizing: { compact: true, expanded: true, minHeight: 200 },
  semanticDescription: "A set of imported images shown one at a time, each with its own description",
  requestedCapabilities: [],
  textFallback: "The pictures in this set are listed in text when they cannot be displayed.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** The same pictures as a grid, for when seeing them together is the point. */
export const GALLERY: WidgetDefinition = {
  id: "canvas.gallery@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      imageRefs: { type: "array", items: datasetProp, minItems: 1, maxItems: 48 },
      alts: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 48 },
      title: { type: "string", maxLength: 200 },
    },
    required: ["imageRefs", "alts"],
  },
  eventSchemas: {},
  sizing: { compact: true, expanded: true, minHeight: 200 },
  semanticDescription: "A grid of imported images, each with its own description",
  requestedCapabilities: [],
  textFallback: "The pictures in this gallery are listed in text when they cannot be displayed.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/**
 * A video on YouTube, named by its identifier rather than by a URL.
 *
 * The model supplies the identifier and never the address, so the surface cannot be pointed at an arbitrary
 * page: an embed is a request the reader's browser makes to somebody else's server, and the vocabulary for
 * where it may point is the host's, not the model's.
 */
export const YOUTUBE: WidgetDefinition = {
  id: "canvas.youtube@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      videoId: { type: "string", pattern: "^[A-Za-z0-9_-]{6,20}$" },
      title: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 300 },
    },
    required: ["videoId", "title"],
  },
  eventSchemas: {},
  sizing: { compact: true, expanded: true, minHeight: 220 },
  semanticDescription: "A YouTube video, embedded from YouTube when it is displayed",
  requestedCapabilities: [],
  textFallback: "A YouTube video is named in text, with its identifier, when it cannot be embedded.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** A video the host holds, served under an opaque reference like an imported image. */
export const VIDEO: WidgetDefinition = {
  id: "canvas.video@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      videoRef: datasetProp,
      alt: { type: "string", maxLength: 300 },
      title: { type: "string", maxLength: 200 },
      posterRef: datasetProp,
    },
    required: ["videoRef", "alt"],
  },
  eventSchemas: {},
  sizing: { compact: true, expanded: true, minHeight: 220 },
  semanticDescription: "A video the host holds, described by its required description text",
  requestedCapabilities: [],
  textFallback: "A video is described in text when it cannot be played.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/**
 * The M1 call to action, which could only save the current view and pin it.
 *
 * Superseded by `canvas.action@1` for anything a model places. It stays in `WIDGETS` because the composed overview
 * still uses it for its save region, and because every message that already shows one must keep rendering; it is
 * left out of the view vocabulary in the runtime, which is what stops new ones being asked for.
 */
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

/** The icons an action may show: a closed set, so a model names one and never supplies a picture. */
export const ACTION_ICONS = ["none", "play", "send", "save", "add", "refresh", "open", "check"] as const;

/**
 * One button, bound by the host to one action.
 *
 * What the button does is not in its props. A model asks for the action alongside the props, the host compiles it into
 * a binding — `view`, `invoke`, `agent` or `workflow` — and keeps it; the renderer is told only what to show and whether
 * the binding can run now. That is what lets one renderer draw every kind without knowing any of them, and what stops a
 * stored prop from introducing an action after the fact.
 */
export const ACTION: WidgetDefinition = {
  id: "canvas.action@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      label: { type: "string", minLength: 1, maxLength: 120 },
      description: { type: "string", maxLength: 300 },
      emphasis: { type: "string", enum: ["primary", "secondary"] },
      icon: { type: "string", enum: [...ACTION_ICONS] },
    },
    required: ["label"],
  },
  eventSchemas: { activate: { type: "object" } },
  sizing: { compact: true, expanded: true, minHeight: 56 },
  semanticDescription:
    "One button bound to one action the host runs: pinning this view, a package service capability, a new request to Clark, or a workflow",
  requestedCapabilities: [],
  textFallback: "An action was offered here. It can be used again when the button can be shown.",
  // A button can be bound to anything the node can run; the binding carries the category that actually applies.
  effectCategories: ["read", "local-write", "external-write", "destructive", "financial", "communication", "media-capture"],
  datasetRefs: [],
};

/* ------------------------------------------------------------------ *
 * Things a person fills in or picks from
 *
 * A choice, an input and a search box hold their value on the page; a form sends its values to the one action the host
 * bound to it, and a list may send the item a person picked. Neither the form nor the list learns what that action is:
 * like the action button, each is told only what to show and whether its binding can run now. The rules for a value
 * live in `@clarkcant/contracts` (`checkFieldValue`), which the node runs again before anything is sent on.
 * ------------------------------------------------------------------ */

const optionsSchema = {
  type: "array",
  maxItems: MAX_FIELD_OPTIONS,
  items: {
    type: "object",
    additionalProperties: false,
    properties: { value: { type: "string", minLength: 1, maxLength: 120 }, label: { type: "string", minLength: 1, maxLength: 120 } },
    required: ["value", "label"],
  },
};

/** What describes one field, beside its kind; shared by the standalone choice and input and by each field of a form. */
const fieldShape = {
  label: { type: "string", minLength: 1, maxLength: 120 },
  help: { type: "string", maxLength: 300 },
  placeholder: { type: "string", maxLength: 120 },
  options: optionsSchema,
  min: { type: "number" },
  max: { type: "number" },
  step: { type: "number", exclusiveMinimum: 0 },
  minLength: { type: "integer", minimum: 0, maximum: MAX_TEXT_LENGTH },
  maxLength: { type: "integer", minimum: 1, maximum: MAX_TEXT_LENGTH },
  multiline: { type: "boolean" },
};

/** Chips, a select, a multi-select, radio buttons, a checkbox or a toggle, holding its value on the page. */
export const CHOICE: WidgetDefinition = {
  id: "canvas.choice@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      label: fieldShape.label,
      kind: { type: "string", enum: [...CHOICE_KINDS] },
      help: fieldShape.help,
      options: optionsSchema,
      value: { description: "The value it starts with: an option's value, a list of them, or true/false" },
    },
    required: ["label", "kind"],
  },
  eventSchemas: { "choice.change": { type: "object" } },
  stateSchema: { type: "object", properties: { value: {} } },
  stateVersion: 1,
  sizing: { compact: true, expanded: false, minHeight: 48 },
  semanticDescription: "A choice a person makes: chips, a select, a multi-select, radio buttons, a checkbox or a toggle",
  requestedCapabilities: [],
  textFallback: "A choice appears as text: its label and the options it offers.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** A text, number, date, date-range, time or slider input, holding its value on the page. */
export const INPUT: WidgetDefinition = {
  id: "canvas.input@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...fieldShape,
      kind: { type: "string", enum: [...INPUT_KINDS] },
      value: { description: "The value it starts with" },
    },
    required: ["label", "kind"],
  },
  eventSchemas: { "input.change": { type: "object" } },
  stateSchema: { type: "object", properties: { value: {} } },
  stateVersion: 1,
  sizing: { compact: true, expanded: false, minHeight: 48 },
  semanticDescription: "One value a person types or sets: text, a number, a date, a date range, a time or a slider",
  requestedCapabilities: [],
  textFallback: "An input appears as text: its label and the value it holds.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** A search box. The query is local to the page, settles after typing pauses, and is the view's current query. */
export const SEARCH: WidgetDefinition = {
  id: "canvas.search@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      label: { type: "string", minLength: 1, maxLength: 120 },
      placeholder: { type: "string", maxLength: 120 },
      query: { type: "string", maxLength: 200 },
    },
    required: ["label"],
  },
  eventSchemas: { "query.change": { type: "object" } },
  stateSchema: { type: "object", properties: { query: { type: "string" } } },
  stateVersion: 1,
  sizing: { compact: true, expanded: false, minHeight: 48 },
  semanticDescription: "A search box whose query stays on the page and names what the view is currently searching for",
  requestedCapabilities: [],
  textFallback: "A search box appears as text: its label and the current query.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/**
 * A form: fields described by a schema, checked as they are filled and again by the node, sent to one bound action.
 *
 * The draft stays on the page until it is sent, a refusal leaves it as it was, and no field can ask for a secret.
 */
export const FORM: WidgetDefinition = {
  id: "canvas.form@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 500 },
      submitLabel: { type: "string", minLength: 1, maxLength: 60 },
      fields: {
        type: "array",
        minItems: 1,
        maxItems: MAX_FORM_FIELDS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,39}$" },
            kind: { type: "string", enum: [...CHOICE_KINDS, ...INPUT_KINDS] },
            required: { type: "boolean" },
            ...fieldShape,
          },
          required: ["name", "label", "kind"],
        },
      },
    },
    required: ["submitLabel", "fields"],
  },
  eventSchemas: { submit: { type: "object" } },
  stateSchema: { type: "object", properties: { draft: { type: "object" } } },
  stateVersion: 1,
  sizing: { compact: true, expanded: true, minHeight: 160 },
  semanticDescription: "A form whose fields a person fills in and sends to one action the host runs",
  requestedCapabilities: [],
  textFallback: "A form appears as text: its fields and what sending it does.",
  // A form can be bound to anything the node can run; the binding carries the category that actually applies.
  effectCategories: ["read", "local-write", "external-write", "destructive", "financial", "communication", "media-capture"],
  datasetRefs: [],
};

/** A list of items with stable ids: selection, pages, an empty state, and optionally one action a person runs per item. */
export const LIST: WidgetDefinition = {
  id: "canvas.list@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", maxLength: 200 },
      items: {
        type: "array",
        maxItems: MAX_LIST_ITEMS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 120 },
            title: { type: "string", minLength: 1, maxLength: 200 },
            subtitle: { type: "string", maxLength: 300 },
            meta: { type: "string", maxLength: 80 },
          },
          required: ["id", "title"],
        },
      },
      selection: { type: "string", enum: ["none", "single", "multi"] },
      pageSize: { type: "integer", minimum: LIST_PAGE_SIZES.min, maximum: LIST_PAGE_SIZES.max },
      emptyText: { type: "string", maxLength: 200 },
      itemActionLabel: { type: "string", minLength: 1, maxLength: 60 },
    },
    required: ["items"],
  },
  eventSchemas: { "selection.change": { type: "object" }, "item.activate": { type: "object" } },
  stateSchema: { type: "object", properties: { selected: { type: "array" }, page: { type: "number" } } },
  stateVersion: 1,
  sizing: { compact: true, expanded: true, minHeight: 120 },
  semanticDescription: "A list of items with stable ids that a person can page through, select from, and act on one at a time",
  requestedCapabilities: [],
  textFallback: "A list appears as text: one line per item.",
  // An item's action can be bound to anything the node can run; the binding carries the category that applies.
  effectCategories: ["read", "local-write", "external-write", "destructive", "financial", "communication", "media-capture"],
  datasetRefs: [],
};

/*
 * Status cards: a status, the progress of one thing, a few labelled facts.
 *
 * What they show is what the model wrote when it placed them; none reads a task, a connection or a dataset. The node's
 * own task and connection cards stay host-owned and are built from its records. So these carry no freshness badge and
 * no control, and an `asOf` is said in words: "as of" a time, never "live".
 */

/**
 * A one-line string with no control, bidi or invisible character; the node says which one it found. A required one
 * also holds something besides spaces, since the card reads it trimmed.
 */
function oneLineProp(maxLength: number, minLength?: number): Record<string, unknown> {
  return minLength === undefined
    ? { type: "string", maxLength, pattern: ONE_LINE_PATTERN }
    : { type: "string", minLength, maxLength, pattern: ONE_LINE_REQUIRED_PATTERN };
}

const asOfProp = {
  type: "string",
  maxLength: 40,
  pattern: AS_OF_PATTERN,
  description: "When the facts were true: a day (2026-09-30) or an instant with its offset (2026-09-30T09:00:00+07:00)",
};

/** One labelled state with a tone. The tone is said in words and a symbol as well as colour. */
export const STATUS: WidgetDefinition = {
  id: "canvas.status@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: oneLineProp(200),
      label: oneLineProp(120, 1),
      tone: { type: "string", enum: [...STATUS_TONES] },
      detail: oneLineProp(500),
      asOf: asOfProp,
    },
    required: ["label", "tone"],
  },
  eventSchemas: {},
  sizing: { compact: true, expanded: true, minHeight: 72 },
  semanticDescription: "A status the model states: one label with a tone (neutral, info, success, warning or danger) and an optional detail",
  requestedCapabilities: [],
  textFallback: "A status appears as text: its label, its tone and its detail.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** Progress of one thing: a value of a maximum, or a short list of steps. Never a spinner with nothing behind it. */
export const PROGRESS: WidgetDefinition = {
  id: "canvas.progress@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: oneLineProp(200),
      label: oneLineProp(200),
      value: { type: "number", minimum: 0 },
      max: { type: "number", exclusiveMinimum: 0 },
      unit: oneLineProp(20),
      steps: {
        type: "array",
        minItems: 1,
        maxItems: MAX_PROGRESS_STEPS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: oneLineProp(120, 1),
            status: { type: "string", enum: [...STEP_STATUSES] },
            detail: oneLineProp(200),
          },
          required: ["label", "status"],
        },
      },
      asOf: asOfProp,
    },
  },
  eventSchemas: {},
  sizing: { compact: true, expanded: true, minHeight: 72 },
  semanticDescription: "Progress the model states for one thing: a value of a maximum, or steps each done, current, pending, failed or skipped",
  requestedCapabilities: [],
  textFallback: "Progress appears as text: the value of its maximum, or each step with its status.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** A few labelled facts, in the order the model gave them. */
export const DETAILS: WidgetDefinition = {
  id: "canvas.details@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: oneLineProp(200),
      items: {
        type: "array",
        minItems: 1,
        maxItems: MAX_DETAIL_ITEMS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: oneLineProp(80, 1),
            value: oneLineProp(300, 1),
          },
          required: ["label", "value"],
        },
      },
      asOf: asOfProp,
    },
    required: ["items"],
  },
  eventSchemas: {},
  sizing: { compact: true, expanded: true, minHeight: 72 },
  semanticDescription: "Labelled facts the model states about one thing, as label and value pairs",
  requestedCapabilities: [],
  textFallback: "Details appear as text: one label and value per line.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** Which kind of status card each definition draws. */
export const STATUS_CARD_KIND: Readonly<Record<string, StatusCardKind>> = {
  [STATUS.id]: "status",
  [PROGRESS.id]: "progress",
  [DETAILS.id]: "details",
};

/**
 * A personal note.
 *
 * Exported here, beside the other descriptors, but deliberately **not** in `WIDGETS`: that list is
 * what the runtime turns into the model's callable view vocabulary, so joining it would change what
 * the model may ask for rather than only what the library can show. It also must not live in
 * `sample.ts`, because `sample.ts` imports `@clarkcant/core` and anything that reaches it would drag
 * a Node-only module graph into the browser bundle.
 */
export const NOTE: WidgetDefinition = {
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
  CAROUSEL,
  GALLERY,
  YOUTUBE,
  VIDEO,
  CTA,
  ACTION,
  CHOICE,
  INPUT,
  SEARCH,
  FORM,
  LIST,
  STATUS,
  PROGRESS,
  DETAILS,
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
  "canvas.carousel@1": "media",
  "canvas.gallery@1": "media",
  "canvas.youtube@1": "media",
  "canvas.video@1": "media",
  "canvas.cta@1": "cta",
  // Its own family rather than `cta`: a composed template filling its save region must not be offered a button whose
  // action is not a view save.
  "canvas.action@1": "action",
  "canvas.choice@1": "choice",
  "canvas.input@1": "input",
  "canvas.search@1": "search",
  // A form and an item action each send something to a bound action; their own families keep them out of regions that
  // expect a control with no effect.
  "canvas.form@1": "form",
  "canvas.list@1": "list",
  // One family for the three: each says where something stands in the model's words, and a layout places any of them in
  // the same region.
  "canvas.status@1": "status",
  "canvas.progress@1": "status",
  "canvas.details@1": "status",
};

/**
 * What a primitive's props say that its schema cannot check: a field that asks for a secret or a choice with no
 * options, a starting value that does not fit its own field, two form fields with one name, two list items with one id.
 *
 * Run wherever a model's props become an instance — its own `show_view` and a layout leaf — so a widget that could
 * never be filled in, or whose selection could name two items at once, is refused with the reason instead of drawn.
 */
export function primitivePropsProblems(definitionId: string, props: Readonly<Record<string, unknown>>): string[] {
  if (definitionId === CHOICE.id || definitionId === INPUT.id) {
    const field = fieldFromProps(props);
    if (field === undefined) return ["the props do not describe a field"];
    const problems = checkField(field).map((problem) => problem.replace('field "value"', "the field"));
    const value = checkFieldValue(field, props.value);
    if (props.value !== undefined && value !== undefined) problems.push(`the starting value does not fit: ${value}`);
    return problems;
  }
  if (definitionId === FORM.id) {
    const fields = parseFields(props.fields);
    return fields === undefined ? ["the fields are not ones a form can hold"] : checkFields(fields);
  }
  if (definitionId === LIST.id) {
    const items = parseListItems(props.items);
    return items === undefined ? ["the items are not ones a list can hold"] : checkListItems(items);
  }
  const card = STATUS_CARD_KIND[definitionId];
  if (card !== undefined) return statusCardProblems(card, props);
  return [];
}
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
