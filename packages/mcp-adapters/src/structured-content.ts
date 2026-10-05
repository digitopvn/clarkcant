import { describeUnsafePattern, unsafeSchemaPattern } from "@clarkcant/contracts";

/**
 * Structured values from an MCP server: a tool's `structuredContent` and its declared `outputSchema`.
 *
 * Both are untrusted data. They are copied into objects this node builds, bounded, and never interpreted: a value here
 * never becomes an instruction, a host card or a widget, and never changes what a call is decided as.
 */

/** A JSON value as a server may send one, after `boundedJsonObject` copied it. */
export type McpJsonValue = string | number | boolean | null | McpJsonValue[] | { [key: string]: McpJsonValue };
export type McpJsonObject = { [key: string]: McpJsonValue };

/**
 * How much structure one value from a server may have. A tool result is one message of at most `MAX_MESSAGE_CHARS`, so
 * this bounds the work of copying it, and the depth bounds the recursion that does.
 */
export const STRUCTURED_JSON_LIMITS = { maxDepth: 32, maxNodes: 16_384 } as const;

/** The largest output schema kept, as JSON. One larger is dropped and the tool stays usable without it. */
export const MAX_OUTPUT_SCHEMA_CHARS = 16_384;

/** Keys that name an object's prototype rather than its data. A value from a server that uses one is not kept. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A server's JSON object, copied into objects this node built, or why it was not.
 *
 * The value is untrusted data: it is only ever copied, never interpreted. It must be a plain object made of strings,
 * finite numbers, booleans, nulls, arrays and plain objects, no deeper than `maxDepth` and with no more than `maxNodes`
 * values in all. A key that names a prototype (`__proto__`, `constructor`, `prototype`) refuses the whole value rather
 * than being dropped from it, so what is kept is always exactly what the server sent.
 */
export function boundedJsonObject(value: unknown): { ok: true; value: McpJsonObject } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: "it is not a JSON object" };
  const walk: { nodes: number; problem: string | undefined } = { nodes: 0, problem: undefined };
  const refuse = (problem: string): undefined => {
    walk.problem = problem;
    return undefined;
  };
  const copy = (input: unknown, depth: number): McpJsonValue | undefined => {
    walk.nodes += 1;
    if (walk.nodes > STRUCTURED_JSON_LIMITS.maxNodes) {
      return refuse(`it holds more than ${String(STRUCTURED_JSON_LIMITS.maxNodes)} values`);
    }
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : refuse("it holds a number JSON cannot carry");
    if (depth >= STRUCTURED_JSON_LIMITS.maxDepth) {
      return refuse(`it is nested deeper than ${String(STRUCTURED_JSON_LIMITS.maxDepth)} levels`);
    }
    if (Array.isArray(input)) {
      const items: McpJsonValue[] = [];
      for (const item of input) {
        const copied = copy(item, depth + 1);
        if (copied === undefined) return undefined;
        items.push(copied);
      }
      return items;
    }
    if (!isPlainObject(input)) return refuse("it holds a value that is not JSON");
    const object: McpJsonObject = {};
    for (const key of Object.keys(input)) {
      if (PROTOTYPE_KEYS.has(key)) return refuse(`it uses the key "${key}", which names a prototype rather than data`);
      const copied = copy(input[key], depth + 1);
      if (copied === undefined) return undefined;
      object[key] = copied;
    }
    return object;
  };
  const copied = copy(value, 0);
  if (copied === undefined || walk.problem !== undefined) return { ok: false, reason: walk.problem ?? "it is not JSON" };
  // A plain object in, so a plain object out: the root was checked above and is copied as one.
  return { ok: true, value: copied as McpJsonObject };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * A tool's declared output schema, if this node keeps it.
 *
 * The protocol makes it a JSON Schema whose `type` is `object`. Anything else — another type, a value that is not
 * bounded JSON, one over `MAX_OUTPUT_SCHEMA_CHARS`, or one holding a pattern that could stall the node when a result is
 * checked against it — is dropped with the reason, and the tool is still listed and callable. It only ever describes
 * the shape of a result; it never changes what a call is decided as.
 */
export function acceptOutputSchema(value: unknown): { ok: true; schema?: McpJsonObject } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  const bounded = boundedJsonObject(value);
  if (!bounded.ok) return { ok: false, reason: `the output schema was dropped because ${bounded.reason}` };
  if (bounded.value["type"] !== "object") {
    return { ok: false, reason: 'the output schema was dropped because its type is not "object"' };
  }
  if (JSON.stringify(bounded.value).length > MAX_OUTPUT_SCHEMA_CHARS) {
    return { ok: false, reason: `the output schema was dropped because it is longer than ${String(MAX_OUTPUT_SCHEMA_CHARS)} characters` };
  }
  const unsafe = unsafeSchemaPattern(bounded.value);
  if (unsafe !== undefined) return { ok: false, reason: `the output schema was dropped: ${describeUnsafePattern(unsafe)}` };
  return { ok: true, schema: bounded.value };
}
