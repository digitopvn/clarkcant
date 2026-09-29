import { z } from "zod";

import { describeUnsafePattern, MAX_PATTERN_INPUT_LENGTH, overlongPatternInput, unsafeSchemaPattern } from "./schema-patterns.ts";
import type { MessageBlock } from "./surfaces.ts";
import { ONE_LINE_PATTERN, ONE_LINE_REQUIRED_PATTERN, hiddenCharacterProblem } from "./text-rules.ts";
import type { WidgetDefinition } from "./widgets.ts";

/**
 * Props validation for a widget definition, as a pure function.
 *
 * It lives in the contracts package because both the node (`@clarkcant/widget-host`) and the Widget
 * Lab in a browser (`@clarkcant/widget-catalog`) need it, and this package reads no Node builtin. Both
 * re-export this one implementation, so there is exactly one copy of the rules.
 *
 * Two passes. The structural one names the failures people and models hit most — an unknown key, a
 * missing required key, a wrong primitive type, a string that is too long — in plain words. The
 * second holds the props to the definition's whole JSON Schema (ranges, enums, array items, nested
 * objects, `oneOf`), so a `pageSize` of 1000 on a table that allows 200 is refused rather than stored.
 * Either way a failure carries the definition's text fallback so the timeline still reads.
 *
 * Before either, the schema's own patterns are read (`schema-patterns.ts`): one that could take unbounded time to check
 * means no parser is ever built for that schema and no props are accepted under it, and a value a pattern would be run
 * on may be at most {@link MAX_PATTERN_INPUT_LENGTH} characters.
 */

export type PropsValidation =
  | { ok: true; props: Record<string, unknown> }
  | { ok: false; fallback: MessageBlock; problems: string[] };

interface StructuralSchema {
  properties?: Record<string, { type?: string; maxLength?: number }>;
  required?: string[];
  additionalProperties?: boolean;
}

/** At most this many problems from the full-schema pass, so one bad array cannot flood a refusal. */
const MAX_SCHEMA_PROBLEMS = 5;

/** Parsers by schema object: a definition's schema is fixed for its lifetime, and building one is not free. */
const parsers = new WeakMap<object, z.ZodType | null>();

/** Why a schema's patterns were refused, by schema object, for the same reason; `null` when none was. */
const refusals = new WeakMap<object, string | null>();

function refusalOf(schema: Record<string, unknown>): string | null {
  const cached = refusals.get(schema);
  if (cached !== undefined) return cached;
  const unsafe = unsafeSchemaPattern(schema);
  const refusal = unsafe === undefined ? null : `the widget's props schema was refused: ${describeUnsafePattern(unsafe)}`;
  refusals.set(schema, refusal);
  return refusal;
}

function parserFor(schema: Record<string, unknown>): z.ZodType | null {
  const cached = parsers.get(schema);
  if (cached !== undefined) return cached;
  let parser: z.ZodType | null;
  try {
    parser = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    parser = null;
  }
  parsers.set(schema, parser);
  return parser;
}

function structuralProblems(schema: StructuralSchema, props: Record<string, unknown>): { problems: string[]; keys: Set<string> } {
  const problems: string[] = [];
  const keys = new Set<string>();
  const allowed = schema.properties ?? {};
  const flag = (key: string, problem: string): void => {
    problems.push(problem);
    keys.add(key);
  };

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(props)) {
      if (!(key in allowed)) flag(key, `unknown property "${key}"`);
    }
  }

  for (const key of schema.required ?? []) {
    if (!(key in props)) flag(key, `required property "${key}" is missing`);
  }

  for (const [key, value] of Object.entries(props)) {
    const spec = allowed[key];
    if (!spec) continue;
    if (spec.type === "string" && typeof value !== "string") {
      flag(key, `property "${key}" must be a string`);
    }
    if (spec.type === "number" && typeof value !== "number") {
      flag(key, `property "${key}" must be a number`);
    }
    if (spec.type === "boolean" && typeof value !== "boolean") {
      flag(key, `property "${key}" must be a boolean`);
    }
    if (spec.type === "string" && typeof value === "string" && spec.maxLength !== undefined && value.length > spec.maxLength) {
      flag(key, `property "${key}" exceeds its maximum length of ${spec.maxLength}`);
    }
  }

  return { problems, keys };
}

/**
 * Why a string failed its pattern, in words, when the pattern is a one-line field's.
 *
 * A one-line field's pattern (`ONE_LINE_PATTERN`) is a long character class; "must match pattern" with that class
 * tells a model nothing it can fix, while "contains U+202E" or "is empty" does. Any other pattern keeps its own
 * message: its author's rule is not this one, and a value can fail it for a reason that has nothing to do with a hidden
 * character the value also holds.
 */
const ONE_LINE_PATTERNS: ReadonlySet<string> = new Set(
  [ONE_LINE_PATTERN, ONE_LINE_REQUIRED_PATTERN].map((pattern) => new RegExp(pattern).toString()),
);

function patternProblemAt(props: Record<string, unknown>, issue: z.core.$ZodIssue): string | undefined {
  if (issue.code !== "invalid_format" || issue.format !== "regex") return undefined;
  if (issue.pattern === undefined || !ONE_LINE_PATTERNS.has(issue.pattern)) return undefined;
  let value: unknown = props;
  for (const key of issue.path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  if (typeof value !== "string") return undefined;
  return hiddenCharacterProblem(value) ?? (value.trim() === "" ? "is empty" : undefined);
}

/** What the full schema refuses that the structural pass has not already named. */
function schemaProblems(
  schema: Record<string, unknown>,
  props: Record<string, unknown>,
  flagged: ReadonlySet<string>,
  forbidsExtra: boolean,
): string[] {
  const parser = parserFor(schema);
  // A schema this node cannot read is not a reason to trust any props: they are refused rather than unchecked.
  if (parser === null) return ["the widget's props schema could not be read, so no props can be checked against it"];
  const parsed = parser.safeParse(props);
  if (parsed.success) return [];

  const problems: string[] = [];
  for (const issue of parsed.error.issues) {
    const [head] = issue.path;
    if (head !== undefined && flagged.has(String(head))) continue;
    // Unknown top-level keys were already named one by one.
    if (issue.path.length === 0 && issue.code === "unrecognized_keys" && forbidsExtra) continue;
    const where = issue.path.length === 0 ? "props" : `property "${issue.path.map(String).join(".")}"`;
    problems.push(`${where}: ${patternProblemAt(props, issue) ?? issue.message}`);
    if (problems.length === MAX_SCHEMA_PROBLEMS) break;
  }
  return problems;
}

/** Why these props cannot be checked at all, before any pattern in the schema runs, or undefined. */
function uncheckable(schema: Record<string, unknown>, props: Record<string, unknown>): string | undefined {
  const refusal = refusalOf(schema);
  if (refusal !== null) return refusal;
  const overlong = overlongPatternInput(schema, props);
  if (overlong === undefined) return undefined;
  const where = overlong === "" ? "props" : `property "${overlong}"`;
  return `${where}: is longer than the ${String(MAX_PATTERN_INPUT_LENGTH)} characters a value checked against a pattern may have`;
}

export function validateProps(definition: WidgetDefinition, props: Record<string, unknown>): PropsValidation {
  const schema = definition.propsSchema;
  const refused = uncheckable(schema, props);
  const structural = structuralProblems(schema as StructuralSchema, props);
  const problems =
    refused === undefined
      ? [
          ...structural.problems,
          ...schemaProblems(schema, props, structural.keys, (schema as StructuralSchema).additionalProperties === false),
        ]
      : // The structural pass runs no pattern, so what it names is still worth saying; the full schema is not run.
        [refused, ...structural.problems];

  if (problems.length === 0) return { ok: true, props };

  return {
    ok: false,
    problems,
    fallback: {
      type: "text",
      format: "plain",
      content: definition.textFallback,
      streaming: false,
    },
  };
}
