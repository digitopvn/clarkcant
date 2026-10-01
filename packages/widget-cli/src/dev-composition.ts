import {
  GRAPH_EVENTS,
  GRAPH_FEEDS,
  applyGraphEvent,
  checkCompositionGraph,
  graphValues,
  type GraphStateType,
  type GraphValue,
} from "@clarkcant/contracts";
import { z } from "zod";

export interface DeclaredCompositionEvent {
  name: string;
  fields: readonly string[];
  example: Record<string, unknown>;
}

export function declaredCompositionInputs(definitionId: string): string[] {
  const feed = GRAPH_FEEDS[definitionId];
  if (feed === undefined) return [];
  const inputs: string[] = [];
  if (feed.query) inputs.push("query");
  if (feed.filterFields === "any") inputs.push("filter-equals (cột trong dataset)");
  else if (feed.filterFields.length > 0) inputs.push("filter-equals: " + feed.filterFields.join(", "));
  return inputs;
}

export function declaredCompositionEvents(definitionId: string): DeclaredCompositionEvent[] {
  return Object.entries(GRAPH_EVENTS[definitionId] ?? {}).map(([name, spec]) => {
    const example: Record<string, unknown> = {};
    for (const [field, type] of Object.entries(spec.fields)) {
      example[field] =
        type === "string-list"
          ? ["sample"]
          : type === "string"
            ? "sample"
            : field === "position"
              ? 0
              : field === "expanded"
                ? false
                : "sample";
    }
    return { name, fields: Object.keys(spec.fields), example };
  });
}

export function declaredWidgetEvents(
  definitionId: string,
  schemas: Readonly<Record<string, Record<string, unknown>>>,
): DeclaredCompositionEvent[] {
  const packageEvents = Object.entries(schemas).map(([name, schema]) => {
    const properties =
      typeof schema.properties === "object" && schema.properties !== null
        ? (schema.properties as Record<string, { type?: unknown }>)
        : {};
    const example: Record<string, unknown> = {};
    for (const [field, property] of Object.entries(properties)) {
      example[field] =
        property.type === "array"
          ? []
          : property.type === "number" || property.type === "integer"
            ? 0
            : property.type === "boolean"
              ? false
              : "";
    }
    return { name, fields: Object.keys(properties), example };
  });
  const graphEvents = declaredCompositionEvents(definitionId);
  const graphNames = new Set(graphEvents.map((event) => event.name));
  return [...graphEvents, ...packageEvents.filter((event) => !graphNames.has(event.name))];
}

export function validateDeclaredWidgetEvent(
  schema: Record<string, unknown> | undefined,
  rawPayload: unknown,
): { ok: true; payload: Record<string, unknown> } | { ok: false; problem: string } {
  const payload = record(rawPayload);
  if (payload === undefined) return { ok: false, problem: "the event payload must be a JSON object" };
  if (schema === undefined) return { ok: false, problem: "the event is not declared by this widget" };
  const parser = declaredWidgetEventParser(schema);
  if (!parser.ok) return parser;
  const parsed = parser.parser.safeParse(payload);
  return parsed.success
    ? { ok: true, payload: parsed.data as Record<string, unknown> }
    : { ok: false, problem: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

export function validateDeclaredWidgetEventSchema(
  schema: Record<string, unknown>,
): { ok: true } | { ok: false; problem: string } {
  const parser = declaredWidgetEventParser(schema);
  return parser.ok ? { ok: true } : parser;
}

function declaredWidgetEventParser(
  schema: Record<string, unknown>,
): { ok: true; parser: z.ZodType } | { ok: false; problem: string } {
  try {
    return { ok: true, parser: z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) };
  } catch (error) {
    return {
      ok: false,
      problem: "the declared event schema could not be read: " + (error instanceof Error ? error.message : String(error)),
    };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function valueType(value: unknown): GraphStateType | undefined {
  if (typeof value === "string") return "string";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return "string-list";
  return undefined;
}

function initialValue(type: GraphStateType): GraphValue {
  switch (type) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "string-list":
      return [];
  }
}

export interface CompositionEventResult {
  name: string;
  payload: Record<string, unknown>;
  values: Record<string, GraphValue>;
}

export function validateCompositionEvent(
  definitionId: string,
  name: unknown,
  rawPayload: unknown,
): { ok: true; event: CompositionEventResult } | { ok: false; problem: string } {
  if (typeof name !== "string" || name.length === 0) return { ok: false, problem: "choose a declared event" };
  const spec = GRAPH_EVENTS[definitionId]?.[name];
  if (spec === undefined) return { ok: false, problem: definitionId + " does not declare event " + name };

  const payload = record(rawPayload);
  if (payload === undefined) return { ok: false, problem: "the event payload must be a JSON object" };

  const state: Record<string, { type: GraphStateType; initial: GraphValue }> = {};
  const steps: { op: "select-field"; key: string; field: string }[] = [];
  for (const [index, [field, expected]] of Object.entries(spec.fields).entries()) {
    const providedType = valueType(payload[field]);
    const type =
      expected === "string"
        ? "string"
        : expected === "string-list"
          ? "string-list"
          : (providedType ?? "string");
    const key = "field" + String(index);
    state[key] = { type, initial: initialValue(type) };
    steps.push({ op: "select-field", key, field });
  }

  const sectionId = "dev-widget";
  const graph = { state, on: [{ sectionId, event: name, steps }], feed: [] };
  const problems = checkCompositionGraph(graph, [{ sectionId, definitionId }]);
  if (problems.length > 0) return { ok: false, problem: problems.join("; ") };

  const outcome = applyGraphEvent(graph, graphValues(graph), { sectionId, definitionId, event: name, payload });
  return outcome.ok ? { ok: true, event: { name, payload, values: outcome.values } } : { ok: false, problem: outcome.problem };
}
