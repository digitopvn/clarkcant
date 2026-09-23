import { createHash } from "node:crypto";

/** Values JSON can represent. Used instead of `unknown` at serialisation edges. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Raise an arbitrary value to `JsonValue`.
 *
 * Anything JSON cannot represent is refused here rather than silently dropped by
 * `JSON.stringify`, because a dropped field would change a payload digest and make
 * an idempotency check disagree with itself.
 */
export function asJsonValue(value: unknown, path = "$"): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot serialise non-finite number at ${path}`);
    }
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item, index) => asJsonValue(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, inner]) => inner !== undefined,
    );
    return Object.fromEntries(entries.map(([key, inner]) => [key, asJsonValue(inner, `${path}.${key}`)]));
  }
  throw new Error(`cannot serialise ${typeof value} at ${path}`);
}

/** Canonical payload digest. Key ordering must not change the digest. */
export function payloadDigest(payload: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, inner]) => [key, sortKeys(inner)]));
  }
  return value;
}
