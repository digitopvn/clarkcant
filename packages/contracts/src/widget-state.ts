import type { StateMigrationOp, StateMigrationStep, WidgetDefinition } from "./widgets.ts";

/**
 * The rules a widget's durable state is held to, as pure functions.
 *
 * Here rather than in the node because three places apply them and must agree: the node when it commits a write,
 * the node when it migrates stored state, and `clark widget test` when it proves a package's migration against its
 * own fixture. A second copy in any of them would be a second answer to "is this state valid", and the two would
 * disagree the first time one was tightened.
 */

/** The largest durable state document the node stores for one instance, in bytes of JSON. */
export const WIDGET_STATE_MAX_BYTES = 16 * 1024;

/** The keys of `body` a definition says are durable, without the view-state keys it declares ephemeral. */
export function durableState(
  definition: Pick<WidgetDefinition, "ephemeralStateKeys">,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const ephemeral = new Set(definition.ephemeralStateKeys ?? []);
  if (ephemeral.size === 0) return body;
  return Object.fromEntries(Object.entries(body).filter(([key]) => !ephemeral.has(key)));
}

/**
 * Check a value against a widget's `stateSchema`.
 *
 * A bounded subset of JSON Schema, and it says which one: `type` (string, number, integer, boolean, object, array,
 * null, or a list of them), `properties`, `required`, `additionalProperties` (boolean or schema), `items`, `enum`,
 * `minLength`/`maxLength`, `minimum`/`maximum` and `maxItems`. A keyword outside that set is reported as unsupported
 * rather than skipped: a schema that looked enforced and was not would be the author trusting a check nobody ran.
 */
export function validateStateAgainstSchema(
  schema: Record<string, unknown> | undefined,
  value: unknown,
): { ok: true } | { ok: false; problems: string[] } {
  if (schema === undefined) return { ok: true };
  const problems: string[] = [];
  check(schema, value, "state", problems, 0);
  return problems.length === 0 ? { ok: true } : { ok: false, problems: problems.slice(0, 20) };
}

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "maxItems",
  // Annotations: they describe, and constrain nothing, so accepting them enforces nothing by omission.
  "title",
  "description",
  "default",
  "examples",
  "$schema",
  "$comment",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(expected: string, actual: string): boolean {
  return expected === actual || (expected === "number" && actual === "integer");
}

function check(schema: unknown, value: unknown, path: string, problems: string[], depth: number): void {
  if (depth > 16) {
    problems.push(`${path}: schema nests deeper than 16 levels`);
    return;
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    if (schema === true || schema === undefined) return;
    if (schema === false) problems.push(`${path}: no value is allowed here`);
    else problems.push(`${path}: the schema here is not an object`);
    return;
  }
  const spec = schema as Record<string, unknown>;

  for (const keyword of Object.keys(spec)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) problems.push(`${path}: schema keyword "${keyword}" is not supported`);
  }

  const actual = typeOf(value);
  if (spec.type !== undefined) {
    const expected = Array.isArray(spec.type) ? spec.type.map(String) : [String(spec.type)];
    if (!expected.some((type) => matchesType(type, actual))) {
      problems.push(`${path}: expected ${expected.join(" | ")}, got ${actual}`);
      return;
    }
  }

  if (Array.isArray(spec.enum) && !spec.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    problems.push(`${path}: not one of the allowed values`);
  }

  if (typeof value === "string") {
    if (typeof spec.maxLength === "number" && value.length > spec.maxLength) {
      problems.push(`${path}: longer than ${String(spec.maxLength)} characters`);
    }
    if (typeof spec.minLength === "number" && value.length < spec.minLength) {
      problems.push(`${path}: shorter than ${String(spec.minLength)} characters`);
    }
  }

  if (typeof value === "number") {
    if (typeof spec.maximum === "number" && value > spec.maximum) problems.push(`${path}: above ${String(spec.maximum)}`);
    if (typeof spec.minimum === "number" && value < spec.minimum) problems.push(`${path}: below ${String(spec.minimum)}`);
  }

  if (Array.isArray(value)) {
    if (typeof spec.maxItems === "number" && value.length > spec.maxItems) {
      problems.push(`${path}: more than ${String(spec.maxItems)} items`);
    }
    if (spec.items !== undefined) {
      value.forEach((item, index) => check(spec.items, item, `${path}[${String(index)}]`, problems, depth + 1));
    }
  }

  if (actual === "object") {
    const record = value as Record<string, unknown>;
    const properties =
      typeof spec.properties === "object" && spec.properties !== null
        ? (spec.properties as Record<string, unknown>)
        : {};
    for (const key of Array.isArray(spec.required) ? spec.required.map(String) : []) {
      if (!(key in record)) problems.push(`${path}.${key}: required and missing`);
    }
    for (const [key, item] of Object.entries(record)) {
      if (key in properties) {
        check(properties[key], item, `${path}.${key}`, problems, depth + 1);
      } else if (spec.additionalProperties === false) {
        problems.push(`${path}.${key}: not a declared property`);
      } else if (typeof spec.additionalProperties === "object" && spec.additionalProperties !== null) {
        check(spec.additionalProperties, item, `${path}.${key}`, problems, depth + 1);
      }
    }
  }
}

/** Apply one declarative migration step's operations, in order, to a copy of `body`. */
export function applyStateMigrationOps(
  body: Record<string, unknown>,
  ops: readonly StateMigrationOp[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  for (const op of ops) {
    switch (op.op) {
      case "rename":
        if (op.from in next) {
          // A rename onto a key that already holds a value would silently drop one of the two; refused instead.
          if (op.to in next) throw new Error(`rename ${op.from} -> ${op.to}: "${op.to}" already holds a value`);
          next[op.to] = next[op.from];
          delete next[op.from];
        }
        break;
      case "default":
        if (!(op.key in next)) next[op.key] = op.value;
        break;
      case "remove":
        delete next[op.key];
        break;
      case "map": {
        const current = next[op.key];
        if (typeof current === "string" && Object.hasOwn(op.values, current)) next[op.key] = op.values[current];
        break;
      }
    }
  }
  return next;
}

/**
 * Check that a definition's migrations can carry every older `stateVersion` to the current one.
 *
 * A chain with a gap is caught at publish rather than on a user's machine, where the only honest answer would be a
 * widget that opens read-only.
 */
export function stateMigrationGaps(
  definition: Pick<WidgetDefinition, "stateVersion" | "stateMigrations">,
): string[] {
  const target = definition.stateVersion ?? 0;
  const steps: readonly StateMigrationStep[] = definition.stateMigrations ?? [];
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const step of steps) {
    if (seen.has(step.from)) problems.push(`two migration steps start at stateVersion ${String(step.from)}`);
    seen.add(step.from);
    if (step.to > target) problems.push(`a migration step reaches stateVersion ${String(step.to)}, past the declared ${String(target)}`);
  }
  if (steps.length > 0) {
    const lowest = Math.min(...steps.map((step) => step.from));
    for (let version = lowest; version < target; version += 1) {
      if (!seen.has(version)) problems.push(`no migration step from stateVersion ${String(version)} to ${String(version + 1)}`);
    }
  }
  return problems;
}
