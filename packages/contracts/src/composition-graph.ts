import { z } from "zod";

/**
 * The state and event graph of a composed surface.
 *
 * A layout tree places widgets; this says how they affect one another. It is data the host owns, not code a widget
 * runs, and it is built from three closed parts:
 *
 * - **State**: a few named values, each with a type and a starting value.
 * - **On**: when a leaf reports one of the events its definition emits, a short list of steps writes state. The
 *   steps are the whole vocabulary: set, toggle, copy, append, remove, select-field, map-field, take and count.
 * - **Feed**: a leaf reads state through one of the inputs its definition accepts: a table's or a list's query, or an
 *   exact-match filter on a table column, a list field or a chart's series.
 *
 * A leaf never names a sibling. It says which state it writes and which state it reads, so two widgets are connected
 * only through a value the host holds, can check, can store with a revision and can describe to the agent.
 *
 * Every function here is pure and runs in both places: the page applies an event at once so the person sees it, and
 * the node applies the same event again to the value it stored, so what is kept is what the rules say, never what a
 * page claimed.
 */

export const GRAPH_STATE_TYPES = ["string", "number", "boolean", "string-list"] as const;
export type GraphStateType = (typeof GRAPH_STATE_TYPES)[number];
export type GraphValue = string | number | boolean | string[];

export const MAX_GRAPH_KEYS = 16;
export const MAX_GRAPH_RULES = 24;
export const MAX_GRAPH_FEEDS = 24;
export const MAX_GRAPH_STEPS = 8;
export const MAX_GRAPH_STRING = 200;
/** The longest list a state value may hold. */
export const MAX_GRAPH_LIST = 50;
/** The longest list an event may carry, such as a table's selected row ids. */
export const MAX_GRAPH_EVENT_LIST = 5000;
export const MAX_GRAPH_MAP_ENTRIES = 20;
export const MAX_GRAPH_BYTES = 16 * 1024;

export const GRAPH_STEP_OPS = ["set", "toggle", "copy", "append", "remove", "select-field", "map-field", "take", "count"] as const;
export type GraphStepOp = (typeof GRAPH_STEP_OPS)[number];
export const GRAPH_FEED_OPS = ["query", "filter-equals"] as const;
export type GraphFeedOp = (typeof GRAPH_FEED_OPS)[number];

/** What a field of an event carries. `value` is whatever the control holds: text, a number, true/false or a list. */
type EventFieldType = "string" | "string-list" | "value";

interface GraphEventSpec {
  fields: Readonly<Record<string, EventFieldType>>;
  /**
   * The field the source leaf shows as its own value, when it has one. A step that copies it into state gives the
   * leaf that value back, so a search box or a choice reloaded from the node shows what the node holds.
   */
  echo?: string;
}

/**
 * The events a leaf may wire, by definition. Closed: an event a definition does not emit cannot be wired, and a
 * definition that emits nothing worth wiring is not here.
 */
export const GRAPH_EVENTS: Readonly<Record<string, Readonly<Record<string, GraphEventSpec>>>> = {
  "canvas.search@1": { "query.change": { fields: { query: "string" }, echo: "query" } },
  "canvas.choice@1": { "choice.change": { fields: { value: "value" }, echo: "value" } },
  "canvas.input@1": { "input.change": { fields: { value: "value" }, echo: "value" } },
  "canvas.list@1": { "selection.change": { fields: { selected: "string-list" } } },
  "canvas.table@1": { "row.select": { fields: { rowIds: "string-list" } } },
  "canvas.calendar@1": { "date.select": { fields: { date: "string" } } },
  "canvas.timeline@1": { "timeline.select": { fields: { selectedId: "string" } } },
  "canvas.tree@1": {
    "tree.select": { fields: { selectedId: "string" } },
    "tree.toggle": { fields: { nodeId: "string", expanded: "value" } },
  },
};

interface GraphFeedSpec {
  query: boolean;
  /** Fields an exact-match filter may name; `any` is a table, whose columns are the dataset's. */
  filterFields: "any" | readonly string[];
}

/** The inputs a leaf may read state through, by definition. */
export const GRAPH_FEEDS: Readonly<Record<string, GraphFeedSpec>> = {
  "canvas.table@1": { query: true, filterFields: "any" },
  "canvas.list@1": { query: true, filterFields: ["title", "subtitle", "meta"] },
  "canvas.line@1": { query: false, filterFields: ["series"] },
  "canvas.bar@1": { query: false, filterFields: ["series"] },
  "canvas.donut@1": { query: false, filterFields: ["series"] },
};

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

const keySchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/u, "a state key is a short camelCase name");
const fieldSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/u, "a field is a short name");
const sectionIdSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const graphValueSchema: z.ZodType<GraphValue> = z.union([
  z.string().max(MAX_GRAPH_STRING),
  z.number(),
  z.boolean(),
  z.array(z.string().max(MAX_GRAPH_STRING)).max(MAX_GRAPH_LIST),
]);

export const graphStateDeclSchema = z.strictObject({
  type: z.enum(GRAPH_STATE_TYPES),
  initial: graphValueSchema,
});
export type GraphStateDecl = z.infer<typeof graphStateDeclSchema>;

export const graphStepSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("set"), key: keySchema, value: graphValueSchema }),
  z.strictObject({ op: z.literal("toggle"), key: keySchema, field: fieldSchema.optional() }),
  z.strictObject({ op: z.literal("copy"), key: keySchema, from: keySchema }),
  z.strictObject({ op: z.literal("append"), key: keySchema, field: fieldSchema }),
  z.strictObject({ op: z.literal("remove"), key: keySchema, field: fieldSchema }),
  z.strictObject({ op: z.literal("select-field"), key: keySchema, field: fieldSchema }),
  z.strictObject({
    op: z.literal("map-field"),
    key: keySchema,
    field: fieldSchema,
    map: z.record(z.string().max(MAX_GRAPH_STRING), graphValueSchema),
    fallback: graphValueSchema.optional(),
  }),
  z.strictObject({ op: z.literal("take"), key: keySchema, field: fieldSchema, count: z.int().min(1).max(MAX_GRAPH_LIST) }),
  z.strictObject({ op: z.literal("count"), key: keySchema, field: fieldSchema }),
]);
export type GraphStep = z.infer<typeof graphStepSchema>;

export const graphRuleSchema = z.strictObject({
  sectionId: sectionIdSchema,
  event: z.string().min(1).max(80),
  steps: z.array(graphStepSchema).min(1).max(MAX_GRAPH_STEPS),
});
export type GraphRule = z.infer<typeof graphRuleSchema>;

export const graphFeedSchema = z.discriminatedUnion("op", [
  z.strictObject({ sectionId: sectionIdSchema, op: z.literal("query"), key: keySchema }),
  z.strictObject({ sectionId: sectionIdSchema, op: z.literal("filter-equals"), field: fieldSchema, key: keySchema }),
]);
export type GraphFeed = z.infer<typeof graphFeedSchema>;

export const compositionGraphSchema = z.strictObject({
  state: z.record(keySchema, graphStateDeclSchema),
  on: z.array(graphRuleSchema).max(MAX_GRAPH_RULES),
  feed: z.array(graphFeedSchema).max(MAX_GRAPH_FEEDS),
});
export type CompositionGraph = z.infer<typeof compositionGraphSchema>;

export type GraphValues = Record<string, GraphValue>;

/* ------------------------------------------------------------------ *
 * Values and types
 * ------------------------------------------------------------------ */

function typeOfValue(value: unknown): GraphStateType | undefined {
  if (typeof value === "string") return "string";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return "string-list";
  return undefined;
}

/** Why a value cannot be held by a key of this type, or undefined when it can. */
export function graphValueProblem(type: GraphStateType, value: unknown): string | undefined {
  const actual = typeOfValue(value);
  if (actual !== type) return `expected ${type}, got ${actual ?? typeof value}`;
  if (typeof value === "string" && value.length > MAX_GRAPH_STRING) return `text longer than ${String(MAX_GRAPH_STRING)} characters`;
  if (Array.isArray(value)) {
    if (value.length > MAX_GRAPH_LIST) return `a list of more than ${String(MAX_GRAPH_LIST)} values`;
    if (value.some((item) => item.length > MAX_GRAPH_STRING)) return `a list value longer than ${String(MAX_GRAPH_STRING)} characters`;
  }
  return undefined;
}

/**
 * The values a surface holds now: each key's starting value, replaced by the stored one when that still fits.
 *
 * A stored value that does not fit its key (the graph changed, or the document was edited by hand) is not shown as if
 * it did: the starting value is used instead.
 */
export function graphValues(graph: CompositionGraph, stored?: unknown): GraphValues {
  const values: GraphValues = {};
  const record = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : undefined;
  for (const [key, decl] of Object.entries(graph.state)) {
    const held = record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
    values[key] = held !== undefined && graphValueProblem(decl.type, held) === undefined ? (held as GraphValue) : decl.initial;
  }
  return values;
}

/* ------------------------------------------------------------------ *
 * Checking a graph
 * ------------------------------------------------------------------ */

function fieldFits(fieldType: EventFieldType, keyType: GraphStateType): boolean {
  if (fieldType === "value") return true;
  return fieldType === keyType;
}

/**
 * Every reason a graph cannot be used with these sections.
 *
 * Unknown keys, unknown operations, an event the definition does not emit, an input it does not read, and a type
 * that cannot hold what a step would write are all refused here, before anything is stored. What cannot be known
 * until an event arrives (a control whose value can be text or a list) is checked again when it does.
 */
export function checkCompositionGraph(
  graph: unknown,
  sections: readonly { sectionId: string; definitionId: string }[],
): string[] {
  const parsed = compositionGraphSchema.safeParse(graph);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `graph${issue.path.length === 0 ? "" : `.${issue.path.join(".")}`}: ${issue.message}`);
  }
  const value = parsed.data;
  const problems: string[] = [];
  const definitionOf = new Map(sections.map((section) => [section.sectionId, section.definitionId]));
  const keys = Object.keys(value.state);

  if (keys.length > MAX_GRAPH_KEYS) problems.push(`the graph declares ${String(keys.length)} state keys; at most ${String(MAX_GRAPH_KEYS)} are allowed`);
  for (const [key, decl] of Object.entries(value.state)) {
    const problem = graphValueProblem(decl.type, decl.initial);
    if (problem !== undefined) problems.push(`state "${key}" starts at a value it cannot hold: ${problem}`);
  }
  const typeOf = (key: string, where: string): GraphStateType | undefined => {
    const decl = value.state[key];
    if (decl === undefined) problems.push(`${where} names state "${key}", which the graph does not declare`);
    return decl?.type;
  };

  const seen = new Set<string>();
  value.on.forEach((rule, ruleIndex) => {
    const where = `on[${String(ruleIndex)}] (${rule.sectionId} ${rule.event})`;
    const definitionId = definitionOf.get(rule.sectionId);
    if (definitionId === undefined) {
      problems.push(`${where} names a section the surface does not have`);
      return;
    }
    const event = GRAPH_EVENTS[definitionId]?.[rule.event];
    if (event === undefined) {
      const offered = Object.keys(GRAPH_EVENTS[definitionId] ?? {});
      problems.push(
        `${where}: ${definitionId} does not emit "${rule.event}"${offered.length === 0 ? "; it emits nothing a graph can wire" : `; it emits ${offered.join(", ")}`}`,
      );
      return;
    }
    const id = `${rule.sectionId} ${rule.event}`;
    if (seen.has(id)) problems.push(`${where} is wired twice; put every step for one event in one rule`);
    seen.add(id);

    rule.steps.forEach((step, stepIndex) => {
      const at = `${where} step ${String(stepIndex + 1)} (${step.op})`;
      const keyType = typeOf(step.key, at);
      if (keyType === undefined) return;
      const fieldType = "field" in step && step.field !== undefined ? event.fields[step.field] : undefined;
      if ("field" in step && step.field !== undefined && fieldType === undefined) {
        problems.push(`${at} reads "${step.field}", which "${rule.event}" does not carry; it carries ${Object.keys(event.fields).join(", ")}`);
        return;
      }
      switch (step.op) {
        case "set": {
          const problem = graphValueProblem(keyType, step.value);
          if (problem !== undefined) problems.push(`${at} writes a value "${step.key}" cannot hold: ${problem}`);
          break;
        }
        case "toggle":
          if (step.field === undefined && keyType !== "boolean") problems.push(`${at} flips "${step.key}", which is ${keyType}, not boolean`);
          if (step.field !== undefined && keyType !== "string-list") problems.push(`${at} adds or removes a value in "${step.key}", which is ${keyType}, not a string-list`);
          break;
        case "copy": {
          const fromType = typeOf(step.from, at);
          if (fromType !== undefined && fromType !== keyType) problems.push(`${at} copies ${fromType} "${step.from}" into ${keyType} "${step.key}"`);
          break;
        }
        case "append":
        case "remove":
          if (keyType !== "string-list") problems.push(`${at} needs "${step.key}" to be a string-list; it is ${keyType}`);
          if (fieldType === "string-list") problems.push(`${at} reads a list; append and remove take one value`);
          break;
        case "select-field":
          if (fieldType !== undefined && !fieldFits(fieldType, keyType)) problems.push(`${at} writes a ${fieldType} into ${keyType} "${step.key}"`);
          break;
        case "map-field":
          if (fieldType === "string-list") problems.push(`${at} maps one value; "${step.field}" is a list`);
          if (Object.keys(step.map).length === 0 || Object.keys(step.map).length > MAX_GRAPH_MAP_ENTRIES) {
            problems.push(`${at} has ${String(Object.keys(step.map).length)} map entries; it needs 1 to ${String(MAX_GRAPH_MAP_ENTRIES)}`);
          }
          for (const [from, to] of Object.entries(step.map)) {
            const problem = graphValueProblem(keyType, to);
            if (problem !== undefined) problems.push(`${at} maps "${from}" to a value "${step.key}" cannot hold: ${problem}`);
          }
          if (step.fallback !== undefined) {
            const problem = graphValueProblem(keyType, step.fallback);
            if (problem !== undefined) problems.push(`${at} falls back to a value "${step.key}" cannot hold: ${problem}`);
          }
          break;
        case "take":
          if (keyType !== "string-list") problems.push(`${at} needs "${step.key}" to be a string-list; it is ${keyType}`);
          if (fieldType === "string") problems.push(`${at} takes from a list; "${step.field}" is one value`);
          break;
        case "count":
          if (keyType !== "number") problems.push(`${at} needs "${step.key}" to be a number; it is ${keyType}`);
          break;
      }
    });
  });

  value.feed.forEach((feed, feedIndex) => {
    const where = `feed[${String(feedIndex)}] (${feed.sectionId} ${feed.op})`;
    const definitionId = definitionOf.get(feed.sectionId);
    if (definitionId === undefined) {
      problems.push(`${where} names a section the surface does not have`);
      return;
    }
    const accepts = GRAPH_FEEDS[definitionId];
    if (accepts === undefined) {
      problems.push(`${where}: ${definitionId} reads nothing from a graph`);
      return;
    }
    const keyType = typeOf(feed.key, where);
    if (feed.op === "query") {
      if (!accepts.query) problems.push(`${where}: ${definitionId} has no query to read`);
      if (keyType !== undefined && keyType !== "string") problems.push(`${where} reads ${keyType} "${feed.key}" as a query; a query is text`);
    } else {
      if (accepts.filterFields !== "any" && !accepts.filterFields.includes(feed.field)) {
        problems.push(`${where}: ${definitionId} filters only on ${accepts.filterFields.join(", ")}, not "${feed.field}"`);
      }
      if (keyType === "string-list") problems.push(`${where} filters on a list; an exact-match filter compares one value`);
    }
  });

  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_GRAPH_BYTES) {
    problems.push(`the graph is larger than ${String(MAX_GRAPH_BYTES)} bytes`);
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Applying an event
 * ------------------------------------------------------------------ */

export type GraphEventOutcome =
  | { ok: true; values: GraphValues; changed: string[] }
  | { ok: false; problem: string };

/** Whether an event is wired, so a page knows to hand it to the graph rather than elsewhere. */
export function graphRuleFor(graph: CompositionGraph | undefined, sectionId: string, event: string): GraphRule | undefined {
  return graph?.on.find((rule) => rule.sectionId === sectionId && rule.event === event);
}

function payloadField(type: EventFieldType, value: unknown, name: string): { ok: true; value: GraphValue } | { ok: false; problem: string } {
  const actual = typeOfValue(value);
  if (actual === undefined) return { ok: false, problem: `"${name}" is not text, a number, true/false or a list of text` };
  if (type === "string" && actual !== "string") return { ok: false, problem: `"${name}" should be text` };
  if (type === "string-list" && actual !== "string-list") return { ok: false, problem: `"${name}" should be a list of text` };
  if (typeof value === "string" && value.length > MAX_GRAPH_STRING) return { ok: false, problem: `"${name}" is longer than ${String(MAX_GRAPH_STRING)} characters` };
  if (Array.isArray(value)) {
    if (value.length > MAX_GRAPH_EVENT_LIST) return { ok: false, problem: `"${name}" holds more than ${String(MAX_GRAPH_EVENT_LIST)} values` };
    if (value.some((item: string) => item.length > MAX_GRAPH_STRING)) return { ok: false, problem: `"${name}" holds a value longer than ${String(MAX_GRAPH_STRING)} characters` };
  }
  return { ok: true, value: value as GraphValue };
}

function sameValue(left: GraphValue | undefined, right: GraphValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Apply one event to the values a surface holds.
 *
 * The event must be one this section's definition emits and the graph wires, carry exactly the fields it declares,
 * and every value a step writes must fit its key. Anything else is refused whole: no step of a refused event is kept.
 */
export function applyGraphEvent(
  graph: CompositionGraph,
  current: GraphValues,
  input: { sectionId: string; definitionId: string; event: string; payload: unknown },
): GraphEventOutcome {
  const spec = GRAPH_EVENTS[input.definitionId]?.[input.event];
  const rule = graphRuleFor(graph, input.sectionId, input.event);
  if (spec === undefined || rule === undefined) return { ok: false, problem: `"${input.event}" from ${input.sectionId} is not wired on this surface` };
  if (typeof input.payload !== "object" || input.payload === null || Array.isArray(input.payload)) {
    return { ok: false, problem: "the event carries no fields" };
  }
  const payload = input.payload as Record<string, unknown>;
  const extra = Object.keys(payload).filter((name) => spec.fields[name] === undefined);
  if (extra.length > 0) return { ok: false, problem: `"${input.event}" does not carry ${extra.join(", ")}` };

  const read = (name: string): { ok: true; value: GraphValue } | { ok: false; problem: string } => {
    const type = spec.fields[name];
    if (type === undefined) return { ok: false, problem: `"${input.event}" does not carry "${name}"` };
    if (!(name in payload)) return { ok: false, problem: `"${input.event}" is missing "${name}"` };
    return payloadField(type, payload[name], name);
  };

  const next: GraphValues = { ...current };
  for (const step of rule.steps) {
    const decl = graph.state[step.key];
    if (decl === undefined) return { ok: false, problem: `state "${step.key}" is not declared` };
    let written: GraphValue;
    switch (step.op) {
      case "set":
        written = step.value;
        break;
      case "toggle": {
        if (step.field === undefined) {
          written = next[step.key] !== true;
          break;
        }
        const field = read(step.field);
        if (!field.ok) return field;
        const item = String(field.value);
        const list = Array.isArray(next[step.key]) ? (next[step.key] as string[]) : [];
        written = list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];
        break;
      }
      case "copy": {
        const from = next[step.from];
        if (from === undefined) return { ok: false, problem: `state "${step.from}" is not declared` };
        written = Array.isArray(from) ? [...from] : from;
        break;
      }
      case "append":
      case "remove": {
        const field = read(step.field);
        if (!field.ok) return field;
        if (Array.isArray(field.value)) return { ok: false, problem: `"${step.field}" is a list; ${step.op} takes one value` };
        const item = String(field.value);
        const list = Array.isArray(next[step.key]) ? (next[step.key] as string[]) : [];
        written = step.op === "append" ? (list.includes(item) ? list : [...list, item]) : list.filter((entry) => entry !== item);
        break;
      }
      case "select-field": {
        const field = read(step.field);
        if (!field.ok) return field;
        written = Array.isArray(field.value) ? [...field.value] : field.value;
        break;
      }
      case "map-field": {
        const field = read(step.field);
        if (!field.ok) return field;
        if (Array.isArray(field.value)) return { ok: false, problem: `"${step.field}" is a list; map-field maps one value` };
        const mapped = Object.hasOwn(step.map, String(field.value)) ? step.map[String(field.value)] : step.fallback;
        if (mapped === undefined) return { ok: false, problem: `"${String(field.value)}" has no mapping and the step has no fallback` };
        written = mapped;
        break;
      }
      case "take": {
        const field = read(step.field);
        if (!field.ok) return field;
        if (!Array.isArray(field.value)) return { ok: false, problem: `"${step.field}" is one value; take needs a list` };
        written = field.value.slice(0, step.count);
        break;
      }
      case "count": {
        const field = read(step.field);
        if (!field.ok) return field;
        written = Array.isArray(field.value) ? field.value.length : typeof field.value === "string" ? field.value.length : 1;
        break;
      }
    }
    const problem = graphValueProblem(decl.type, written);
    if (problem !== undefined) return { ok: false, problem: `step ${step.op} would write a value "${step.key}" cannot hold: ${problem}` };
    next[step.key] = written;
  }

  const changed = Object.keys(next).filter((key) => !sameValue(current[key], next[key] as GraphValue));
  return { ok: true, values: next, changed };
}

/* ------------------------------------------------------------------ *
 * Feeding a leaf
 * ------------------------------------------------------------------ */

/** An empty text or an empty list means "no filter", so a cleared control shows everything again. */
function filters(value: GraphValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === "string") return value !== "";
  if (Array.isArray(value)) return false;
  return true;
}

/**
 * What a leaf's view state is, given the values: its query, its exact-match filters, a chart's series, and the value
 * a source leaf shows back. Keys the graph does not feed are left out, so the leaf keeps its own.
 */
export function graphFeedState(
  graph: CompositionGraph | undefined,
  values: GraphValues,
  section: { sectionId: string; definitionId: string },
): Record<string, unknown> {
  if (graph === undefined) return {};
  const state: Record<string, unknown> = {};
  const exact: Record<string, string | number | boolean> = {};
  for (const feed of graph.feed) {
    if (feed.sectionId !== section.sectionId) continue;
    const value = values[feed.key];
    if (feed.op === "query") {
      state.query = typeof value === "string" ? value : "";
    } else if (filters(value)) {
      exact[feed.field] = value as string | number | boolean;
    }
  }
  if (Object.keys(exact).length > 0 || graph.feed.some((feed) => feed.sectionId === section.sectionId && feed.op === "filter-equals")) {
    state.filters = exact;
  }
  for (const rule of graph.on) {
    if (rule.sectionId !== section.sectionId) continue;
    const echo = GRAPH_EVENTS[section.definitionId]?.[rule.event]?.echo;
    if (echo === undefined) continue;
    const step = rule.steps.find((candidate) => candidate.op === "select-field" && candidate.field === echo);
    if (step !== undefined) state[echo] = values[step.key];
  }
  return state;
}

/**
 * The words a person picked a filter's value by.
 *
 * When a choice's rule copies its value into the key a leaf filters on, the option's label names that value, so a chart
 * can say "Việc tạo" rather than the column it reads. Keyed by the field the leaf filters; a value no choice wrote, or
 * one its options do not name, is left out and the leaf shows the value itself.
 */
export function graphFilterLabels(
  graph: CompositionGraph | undefined,
  values: GraphValues,
  sections: readonly { sectionId: string; definitionId: string; props?: Record<string, unknown> }[],
  section: { sectionId: string },
): Record<string, string> {
  if (graph === undefined) return {};
  const labels: Record<string, string> = {};
  for (const feed of graph.feed) {
    if (feed.sectionId !== section.sectionId || feed.op !== "filter-equals") continue;
    const value = values[feed.key];
    if (typeof value !== "string" || value === "") continue;
    for (const rule of graph.on) {
      const source = sections.find((candidate) => candidate.sectionId === rule.sectionId);
      if (source?.definitionId !== "canvas.choice@1") continue;
      if (!rule.steps.some((step) => step.op === "select-field" && step.key === feed.key && step.field === "value")) continue;
      const options = Array.isArray(source.props?.options) ? (source.props.options as unknown[]) : [];
      const option = options.find(
        (candidate): candidate is { value: string; label: string } =>
          typeof candidate === "object" &&
          candidate !== null &&
          (candidate as { value?: unknown }).value === value &&
          typeof (candidate as { label?: unknown }).label === "string",
      );
      if (option !== undefined) {
        labels[feed.field] = option.label;
        break;
      }
    }
  }
  return labels;
}

/** The feeds that read any of these keys, so a page can reset what they drove (a table back to its first page). */
export function graphFeedsReading(graph: CompositionGraph | undefined, keys: readonly string[]): GraphFeed[] {
  return graph?.feed.filter((feed) => keys.includes(feed.key)) ?? [];
}

/* ------------------------------------------------------------------ *
 * The implicit graph of a search box
 * ------------------------------------------------------------------ */

/**
 * The graph a surface has when a search box was placed without one: the box writes `query`, and every table reads it.
 *
 * Built by one function for the node that compiles a layout and the page that draws an older one, so a search box
 * placed before graphs existed narrows its tables exactly as it did.
 */
export function implicitSearchGraph(
  sections: readonly { sectionId: string; definitionId: string; props?: Record<string, unknown> }[],
): CompositionGraph | undefined {
  const searches = sections.filter((section) => section.definitionId === "canvas.search@1");
  const tables = sections.filter((section) => section.definitionId === "canvas.table@1");
  if (searches.length === 0 || tables.length === 0) return undefined;
  const initial = searches[0]?.props?.query;
  return {
    state: { query: { type: "string", initial: typeof initial === "string" ? initial.slice(0, MAX_GRAPH_STRING) : "" } },
    on: searches.map((search) => ({
      sectionId: search.sectionId,
      event: "query.change",
      steps: [{ op: "select-field" as const, key: "query", field: "query" }],
    })),
    feed: tables.map((table) => ({ sectionId: table.sectionId, op: "query" as const, key: "query" })),
  };
}

/* ------------------------------------------------------------------ *
 * What the agent may read
 * ------------------------------------------------------------------ */

export interface GraphSemanticState {
  /** The values, bounded as the graph bounds them. Data about the view, never instructions. */
  values: GraphValues;
  /** One line per key, for a context note: `query = "acme"`. */
  summary: string;
}

/**
 * The surface's current values in the shape a model turn can carry (#195): small, typed, and derived from the graph,
 * not from whatever a page reported.
 */
export function graphSemanticState(graph: CompositionGraph | undefined, stored?: unknown): GraphSemanticState | undefined {
  if (graph === undefined || Object.keys(graph.state).length === 0) return undefined;
  const values = graphValues(graph, stored);
  const summary = Object.entries(values)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("; ");
  return { values, summary };
}
