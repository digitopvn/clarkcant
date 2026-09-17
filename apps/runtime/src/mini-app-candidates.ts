import { type CompositionSlot, MAX_SELECTION_METADATA_BYTES, utf8Bytes } from "@clarkcant/contracts";

/**
 * What the selector is allowed to see.
 *
 * A selector that can be shown anything will eventually be shown everything, so this module is
 * the choke point: it turns host records into opaque ids, kinds and schema *field names*, and
 * nothing else. No row values, no titles, no file paths, no message bodies, no image bytes.
 *
 * Two consequences are deliberate:
 *
 * - The intent is sanitized rather than passed through. It is the one piece of free text in the
 *   request, so it is where a pasted token or an email address would arrive.
 * - The state is measured before it is sent. A ceiling that is only checked by the provider is a
 *   ceiling that fails as a 422 in production instead of as a refusal in the node.
 */

/** One presentation template the host can compile. */
export interface TemplateCandidate {
  templateId: string;
  templateVersion: string;
  label: string;
  slots: readonly CompositionSlot[];
}

/** One renderer the host could place in a slot. */
export interface DefinitionCandidate {
  id: string;
  version: string;
  /** Catalog family, e.g. `charts`. Used by the caller to filter, not by the model to invent. */
  family: string;
  /** Property names and types only — never example values. */
  fields: readonly string[];
}

/** One data source the caller may reference, described structurally. */
export interface DataCandidate {
  ref: string;
  kind: "tasks" | "runs" | "calendar" | "image" | "dataset";
  label: string;
  /** Row count as a bucket, not an exact figure: precise counts are user data too. */
  scale: "empty" | "small" | "medium" | "large";
  freshness: "live" | "cached" | "sample" | "unknown";
}

export interface MiniAppCandidateSet {
  templates: readonly TemplateCandidate[];
  definitions: readonly DefinitionCandidate[];
  data: readonly DataCandidate[];
  locale: string;
}

/** What actually crosses the wire. Kept as a named type so the shape can be asserted in a test. */
export interface JevSelectionState {
  intent: string;
  locale: string;
  templates: { id: string; label: string; slots: string[] }[];
  definitions: { id: string; kind: string; fields: string[] }[];
  data: { ref: string; kind: string; scale: string; freshness: string }[];
}

/**
 * Replace control characters with a space.
 *
 * A code-point loop rather than a regular expression: `no-control-regex` is right that a pattern
 * containing literal control characters is hard to read, and the intent here is a range check.
 */
function stripControlCharacters(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : character;
  }
  return out;
}

/**
 * Token-shaped strings, which are what a pasted credential looks like.
 *
 * Deliberately broad. The cost of redacting a harmless long word is a slightly worse prompt; the
 * cost of not redacting a key is a credential leaving the machine.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk|api|key|token|secret)[-_][A-Za-z0-9._-]{8,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:\+?\d[\s-]?){9,}\b/g,
];

/**
 * Reduce free text to something safe to hand to a third party.
 *
 * Returns a bounded string; never throws. A caller that gets an empty string should treat the
 * request as having no intent rather than sending "intent: " and hoping.
 */
export function sanitizeIntent(text: string, maxLength = 1000): string {
  let clean = stripControlCharacters(text).replace(/\s+/g, " ").trim();
  for (const shape of SECRET_SHAPES) {
    clean = clean.replace(shape, "[redacted]");
  }
  if (clean.length > maxLength) clean = `${clean.slice(0, maxLength - 1)}…`;
  return clean;
}

/**
 * Summarise a JSON Schema by field name and type.
 *
 * The selector needs to know what a renderer can be told; it does not need an example of it.
 * Only the top-level properties are listed, and only the first 24, so a pathological schema
 * cannot enlarge the request on its own.
 */
export function schemaFieldSummary(schema: Record<string, unknown>, limit = 24): string[] {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const summary: string[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    if (summary.length >= limit) break;
    const spec = (raw ?? {}) as { type?: unknown; maxLength?: unknown };
    const type = typeof spec.type === "string" ? spec.type : "unknown";
    summary.push(`${name}:${type}${required.has(name) ? "!" : ""}`);
  }
  return summary;
}

/** Row counts are bucketed: "412 rows" is a fact about the user that the choice does not need. */
export function rowScale(rowCount: number): DataCandidate["scale"] {
  if (rowCount <= 0) return "empty";
  if (rowCount <= 50) return "small";
  if (rowCount <= 1000) return "medium";
  return "large";
}

/**
 * Build the candidate set.
 *
 * `definitions` are filtered against the slots the templates actually declare, because offering a
 * renderer that no template can place is an invitation to select one and then fail the
 * combination check.
 */
export function buildMiniAppCandidateSet(input: {
  templates: readonly TemplateCandidate[];
  definitions: readonly DefinitionCandidate[];
  data: readonly DataCandidate[];
  locale?: string;
}): MiniAppCandidateSet {
  const slots = new Set(input.templates.flatMap((template) => [...template.slots]));
  return {
    templates: [...input.templates],
    definitions: input.definitions.filter((definition) => definition.family !== "layout" && slots.size > 0),
    data: [...input.data],
    locale: input.locale ?? "vi-VN",
  };
}

/** The exact object sent as `state`. Nothing else is ever added to it. */
export function buildSelectionState(candidateSet: MiniAppCandidateSet, rawIntent: string): JevSelectionState {
  return {
    intent: sanitizeIntent(rawIntent),
    locale: candidateSet.locale,
    templates: candidateSet.templates.map((template) => ({
      id: `${template.templateId}@${template.templateVersion}`,
      label: template.label,
      slots: [...template.slots],
    })),
    definitions: candidateSet.definitions.map((definition) => ({
      id: `${definition.id}@${definition.version}`,
      kind: definition.family,
      fields: [...definition.fields],
    })),
    data: candidateSet.data.map((entry) => ({
      ref: entry.ref,
      kind: entry.kind,
      scale: entry.scale,
      freshness: entry.freshness,
    })),
  };
}

export type CandidateStateCheck =
  | { ok: true; bytes: number }
  | { ok: false; bytes: number; message: string };

/**
 * Refuse an oversized state before it is sent.
 *
 * Over the ceiling the honest outcomes are "ask for less" and "fall back", not "send it anyway
 * and see what the provider says" — a 422 from the provider is indistinguishable from a dozen
 * other 422s, and it costs a round trip to learn nothing.
 */
export function checkSelectionStateSize(
  state: JevSelectionState,
  maxBytes = MAX_SELECTION_METADATA_BYTES,
): CandidateStateCheck {
  const bytes = utf8Bytes(state);
  if (bytes <= maxBytes) return { ok: true, bytes };
  return {
    ok: false,
    bytes,
    message: `the selection state is ${bytes} bytes, over the ${maxBytes}-byte ceiling; reduce the candidate set rather than truncating it silently`,
  };
}

/**
 * Whether a state still contains anything that looks like a secret.
 *
 * A defence in depth check rather than the primary control: the sanitizer runs first, and this
 * catches the case where a future field is added without going through it. It is intentionally
 * the same pattern list, applied to the serialised request.
 */
export function stateLooksRedacted(state: JevSelectionState): { ok: true } | { ok: false; matches: string[] } {
  const serialised = JSON.stringify(state);
  const matches: string[] = [];
  for (const shape of SECRET_SHAPES) {
    const pattern = new RegExp(shape.source, shape.flags.replace("g", ""));
    const found = serialised.match(pattern);
    if (found !== null) matches.push(found[0].slice(0, 12));
  }
  return matches.length === 0 ? { ok: true } : { ok: false, matches };
}
