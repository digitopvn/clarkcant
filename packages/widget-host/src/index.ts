import {
  type MessageBlock,
  type SurfaceCompositionSpec,
  type WidgetDefinition,
  checkSurfaceCompositionSpec,
  definitionCatalogKey,
  degradeUnrenderableBlocks,
  isHostOwnedBlock,
} from "@clarkcant/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Built-in catalog registry, sandbox policy and the action-proposal compiler.
 *
 * The catalog exists so a rich response is a JSON document rather than a bespoke
 * React component per answer. The sandbox policy exists so a custom mini-app can be
 * genuinely isolated rather than relying on an iframe being called "sandboxed".
 */

export interface CatalogEntry {
  definition: WidgetDefinition;
  /** Lazy chunk name, so heavy widgets are not in the initial conversation bundle. */
  chunk: string;
  /** Families the release gate requires a functional fixture for. */
  family: string;
}

export class CatalogRegistry {
  readonly #entries = new Map<string, CatalogEntry>();
  readonly #families = new Set<string>();

  register(entry: CatalogEntry): void {
    const key = `${entry.definition.id}@${entry.definition.version}`;
    if (this.#entries.has(key)) {
      throw new Error(`catalog definition ${key} is already registered`);
    }
    this.#entries.set(key, entry);
    this.#families.add(entry.family);
  }

  get(id: string, version?: string): CatalogEntry | undefined {
    if (version !== undefined) return this.#entries.get(`${id}@${version}`);
    for (const entry of this.#entries.values()) {
      if (entry.definition.id === id) return entry;
    }
    return undefined;
  }

  has(id: string, version?: string): boolean {
    return this.get(id, version) !== undefined;
  }

  ids(): string[] {
    return [...this.#entries.keys()].sort();
  }

  /**
   * Every registered entry.
   *
   * Added because the key is `id@version` and a definition id already carries an `@`, so
   * recovering the two halves by splitting a key is exactly the kind of parsing that works until
   * the first id with two separators in it. Callers that need both halves read them from here.
   */
  entries(): CatalogEntry[] {
    return [...this.#entries.values()];
  }

  families(): string[] {
    return [...this.#families].sort();
  }

  /** Which catalog families still have no fixture. Used by the P6 release gate. */
  familiesWithoutFixtures(requiredFamilies: readonly string[]): string[] {
    return requiredFamilies.filter((family) => !this.#families.has(family));
  }
}

/* ------------------------------------------------------------------ *
 * Props validation and fallback
 * ------------------------------------------------------------------ */

export type PropsValidation =
  | { ok: true; props: Record<string, unknown> }
  | { ok: false; fallback: MessageBlock; problems: string[] };

/**
 * Validate props against the definition's schema.
 *
 * A minimal structural check rather than a full JSON Schema engine: the parts that
 * matter here are that unknown keys never reach the DOM, that a wrong type is
 * caught, and that a failure produces a text fallback so the timeline still reads
 * (acceptance test T44).
 */
export function validateProps(
  definition: WidgetDefinition,
  props: Record<string, unknown>,
): PropsValidation {
  const schema = definition.propsSchema as {
    properties?: Record<string, { type?: string; maxLength?: number }>;
    required?: string[];
    additionalProperties?: boolean;
  };

  const problems: string[] = [];
  const allowed = schema.properties ?? {};

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(props)) {
      if (!(key in allowed)) problems.push(`unknown property "${key}"`);
    }
  }

  for (const key of schema.required ?? []) {
    if (!(key in props)) problems.push(`required property "${key}" is missing`);
  }

  for (const [key, value] of Object.entries(props)) {
    const spec = allowed[key];
    if (!spec) continue;
    if (spec.type === "string" && typeof value !== "string") {
      problems.push(`property "${key}" must be a string`);
    }
    if (spec.type === "number" && typeof value !== "number") {
      problems.push(`property "${key}" must be a number`);
    }
    if (spec.type === "boolean" && typeof value !== "boolean") {
      problems.push(`property "${key}" must be a boolean`);
    }
    if (spec.type === "string" && typeof value === "string" && spec.maxLength !== undefined && value.length > spec.maxLength) {
      problems.push(`property "${key}" exceeds its maximum length of ${spec.maxLength}`);
    }
  }

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

/* ------------------------------------------------------------------ *
 * Sandbox policy
 * ------------------------------------------------------------------ */

export interface SandboxPolicy {
  iframeSandbox: string[];
  csp: string;
  allow: string[];
  /** Always true: host chrome sits outside the iframe it describes. */
  hostChromeOutsideFrame: true;
}

/**
 * Build the isolation policy for a custom mini-app.
 *
 * The defaults are restrictive and `allow-same-origin` is never included, which is
 * what keeps a custom widget on an opaque origin that cannot read host storage.
 * Network and media access come from the manifest, so a package that wants a camera
 * has to have declared it and had it approved.
 */
export function buildSandboxPolicy(input: {
  networkOrigins: readonly string[];
  microphone: boolean;
  camera: boolean;
  needsPopups: boolean;
  isolation: "isolated-ui";
}): SandboxPolicy {
  const sandbox = ["allow-scripts", "allow-forms"];
  if (input.needsPopups) sandbox.push("allow-popups");
  // Deliberately absent: allow-same-origin (would defeat the opaque origin),
  // allow-top-navigation, allow-downloads, allow-modals.

  const permissions: string[] = [];
  if (input.microphone) permissions.push("microphone");
  if (input.camera) permissions.push("camera");

  const connect = input.networkOrigins.length > 0 ? `connect-src ${input.networkOrigins.join(" ")};` : "connect-src 'none';";

  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "media-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    connect,
  ].join("; ");

  return {
    iframeSandbox: sandbox,
    csp,
    allow: permissions,
    hostChromeOutsideFrame: true,
  };
}

/* ------------------------------------------------------------------ *
 * Timeline safety
 * ------------------------------------------------------------------ */

/**
 * Prepare blocks for render.
 *
 * Host-owned trust cards are passed through untouched — they were built by the host —
 * and everything else is checked for provenance. A widget that fabricated an
 * approval-shaped block fails here rather than drawing something convincing
 * (acceptance test T41).
 */
export function prepareBlocksForRender(
  blocks: readonly MessageBlock[],
  context: { builtByHost: boolean; definitionIds: ReadonlySet<string>; maxSurfaceBytes: number },
): { blocks: MessageBlock[]; rejected: string[] } {
  const rejected: string[] = [];
  const trusted: MessageBlock[] = [];

  for (const block of blocks) {
    if (isHostOwnedBlock(block) && !context.builtByHost) {
      rejected.push(`a ${block.type} block was supplied by a non-host origin and was dropped`);
      continue;
    }
    trusted.push(block);
  }

  return {
    blocks: degradeUnrenderableBlocks(trusted, {
      definitionIds: context.definitionIds,
      maxSurfaceBytes: context.maxSurfaceBytes,
    }),
    rejected,
  };
}

/**
 * Families the P6 gate requires a working fixture for, from
 * docs/widgets-and-extensions.md §4.
 */
export const REQUIRED_CATALOG_FAMILIES = [
  "layout",
  "text-status",
  "choice",
  "form",
  "lists",
  "tables",
  "charts",
  "diagram",
  "map",
  "calendar",
  "timeline-board",
  "files-artifacts",
  "notes-editor",
  "media",
  "conversation",
  "call-surface",
  "browser-computer",
  "operational-cards",
] as const;

export const specSchema = z.strictObject({
  type: z.literal("object"),
  properties: z.record(z.string(), z.record(z.string(), z.unknown())),
  required: z.array(z.string()).optional(),
  additionalProperties: z.boolean().optional(),
});

/* ------------------------------------------------------------------ *
 * Definition digests and composition coverage
 * ------------------------------------------------------------------ */

/**
 * A digest of the exact definition an instance was created against.
 *
 * A widget's meaning is its schema, so an instance created under one props schema and rendered
 * under another is a different thing wearing the same name. Computed rather than hand-maintained,
 * because a digest somebody has to remember to update is a digest that stops being true.
 */
export function definitionDigest(definition: WidgetDefinition): string {
  const canonical = {
    id: definition.id,
    version: definition.version,
    propsSchema: definition.propsSchema,
    stateSchema: definition.stateSchema ?? null,
    stateVersion: definition.stateVersion ?? 0,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/**
 * Register a list of definitions with their families.
 *
 * The family is required rather than derived: it is what the release gate checks coverage against
 * and what a candidate set filters on, so a definition that cannot say which family it belongs to
 * is a definition nothing can select.
 */
export function registerCatalog(
  registry: CatalogRegistry,
  entries: readonly { definition: WidgetDefinition; family: string; chunk?: string }[],
): CatalogRegistry {
  for (const entry of entries) {
    registry.register({ definition: entry.definition, family: entry.family, chunk: entry.chunk ?? entry.family });
  }
  return registry;
}

/**
 * Families a composed surface needs a usable renderer for.
 *
 * From the two sketches: summary figures, a range control, a chart, a calendar, an image and one
 * call to action. `note` and `tables` are reusable extras, not requirements.
 */
export const COMPOSITION_FAMILIES = ["metrics", "filter", "trend", "calendar", "media", "cta"] as const;

/** Which required families the catalog cannot yet draw. Empty means the surface is drawable. */
export function missingCompositionFamilies(
  registry: CatalogRegistry,
  required: readonly string[] = COMPOSITION_FAMILIES,
): string[] {
  const present = new Set(registry.families());
  return required.filter((family) => !present.has(family));
}

export type CompositionCoverage = { ok: true } | { ok: false; problems: string[] };

/**
 * Check a composed spec against the catalog that will actually draw it.
 *
 * This is the last boundary before persistence, and it is deliberately the same function the
 * runtime calls: a spec that pins a definition the catalog does not hold, or a digest the catalog
 * has moved past, must be refused here rather than stored and discovered at render time.
 */
export function checkCompositionCoverage(
  spec: SurfaceCompositionSpec,
  registry: CatalogRegistry,
  options: {
    allowedDataRefs?: ReadonlySet<string>;
    knownActionBindingIds?: ReadonlySet<string>;
    maxBytes?: number;
  } = {},
): CompositionCoverage {
  const knownDefinitions = new Map<string, string>();
  for (const entry of registry.entries()) {
    knownDefinitions.set(
      definitionCatalogKey(entry.definition.id, entry.definition.version),
      definitionDigest(entry.definition),
    );
  }

  const problems: string[] = [];
  const missing = missingCompositionFamilies(registry);
  if (missing.length > 0) {
    problems.push(`the catalog cannot draw these required families: ${missing.join(", ")}`);
  }

  const result = checkSurfaceCompositionSpec(spec, {
    knownDefinitions,
    ...(options.allowedDataRefs === undefined ? {} : { allowedDataRefs: options.allowedDataRefs }),
    ...(options.knownActionBindingIds === undefined
      ? {}
      : { knownActionBindingIds: options.knownActionBindingIds }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  if (!result.ok) problems.push(...result.problems);

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

export * from "./session.ts";
