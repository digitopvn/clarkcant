import { z } from "zod";

import { effectCategorySchema, instantSchema } from "./primitives.ts";

/**
 * Composed surfaces.
 *
 * A mini-app is one host container (`canvas.overview@1`) holding a fixed number of *leaf*
 * sections. The container is a layout, not a widget: it owns no data and no actions of its
 * own, and each section is an ordinary catalog renderer whose props were validated against
 * that definition's schema before they were stored.
 *
 * Three properties are worth naming, because the schemas below are what make them true
 * rather than merely intended:
 *
 * 1. **No recursion.** A section is a leaf. There is no `sections` field inside a section,
 *    and `props` is checked for a nested `sections` key, so a composition cannot contain a
 *    composition. One level, twelve sections, done.
 * 2. **Nothing executable.** The spec carries definition ids, prop values, opaque data
 *    references and references to *server-compiled* action bindings. It carries no code, no
 *    URL, no capability name and no permission.
 * 3. **A snapshot is data, not a pointer.** `presentationRef` says which renderer drew
 *    something; it never said what the user saw. A `PresentationBundle` materialises the
 *    values at capture time so history cannot be rewritten by a later revision.
 */

export const SURFACE_COMPOSITION_SCHEMA_VERSION = 1;

/** Ceilings from docs/widgets-and-extensions.md §12 and the analysis report §3.2. */
export const MAX_COMPOSITION_SECTIONS = 12;
export const MAX_COMPOSITION_SPEC_BYTES = 256 * 1024;
export const MAX_PRESENTATION_BUNDLE_BYTES = 1024 * 1024;
export const MAX_SELECTION_METADATA_BYTES = 16 * 1024;
export const MAX_MATERIALIZED_ROWS = 5000;

/**
 * Fixed slots the container lays out.
 *
 * A closed enum rather than a free-form name: the container has exactly these positions, and
 * a section that names a position the container does not have would silently not be drawn.
 */
export const compositionSlotSchema = z.enum([
  "metrics",
  "filter",
  "trend",
  "table",
  "calendar",
  "image",
  "note",
  "cta",
]);
export type CompositionSlot = z.infer<typeof compositionSlotSchema>;

export const compositionPeriodSchema = z.enum(["week", "month"]);
export type CompositionPeriod = z.infer<typeof compositionPeriodSchema>;

/** Calendar dates are local dates; the instant they describe needs a timezone beside it. */
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD date");

/**
 * The exact definition an instance was compiled against.
 *
 * `digest` is not decoration. Two definitions can share an id and version while meaning
 * different things, so a spec that names a definition without pinning its schema is a spec
 * that can start rendering something else after an upgrade.
 */
export const definitionDigestRefSchema = z.strictObject({
  id: z.string().min(1).max(160),
  version: z.string().min(1).max(80),
  digest: z.string().min(1).max(120),
});
export type DefinitionDigestRef = z.infer<typeof definitionDigestRefSchema>;

/**
 * One leaf section, as the pure compiler emits it.
 *
 * `rows` is the materialised presentation data. The spec projection drops it (data does not
 * belong in the layout document); the bundle projection keeps it (that is the whole point of
 * a bundle).
 */
export const compiledSectionSchema = z.strictObject({
  sectionId: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "section ids are lowercase identifiers"),
  slot: compositionSlotSchema,
  definitionRef: definitionDigestRefSchema,
  props: z.record(z.string(), z.unknown()),
  /** Opaque, host-resolved references. Never a path, never a URL, never inline rows. */
  dataRefs: z.array(z.string().min(1).max(200)).max(64),
  rows: z.array(z.record(z.string(), z.unknown())).max(MAX_MATERIALIZED_ROWS).optional(),
  /** Mandatory: history has to read when the renderer is gone (T44). */
  textAlternative: z.string().min(1).max(2000),
});
export type CompiledSection = z.infer<typeof compiledSectionSchema>;

/** The spec's view of a section: everything except the materialised data. */
export const compositionSectionSchema = z.strictObject({
  sectionId: compiledSectionSchema.shape.sectionId,
  slot: compositionSlotSchema,
  definitionRef: definitionDigestRefSchema,
  props: z.record(z.string(), z.unknown()),
  dataRefs: compiledSectionSchema.shape.dataRefs,
  textAlternative: compiledSectionSchema.shape.textAlternative,
});
export type CompositionSection = z.infer<typeof compositionSectionSchema>;

/**
 * View state a composition starts with.
 *
 * Held here rather than in `props` so the filter's period survives being re-rendered from a
 * snapshot, and so a later live edit has somewhere honest to live.
 */
export const compositionInitialStateSchema = z.strictObject({
  period: compositionPeriodSchema,
  selectedDate: localDateSchema.optional(),
  timezone: z.string().min(1).max(60),
});
export type CompositionInitialState = z.infer<typeof compositionInitialStateSchema>;

/**
 * A reference to a binding the *server* compiled.
 *
 * The spec never carries a proposal. If it did, a stored document would become a way to
 * introduce an action after the fact, which is exactly what `compileActionBinding` exists to
 * prevent.
 */
export const compositionActionRefSchema = z.strictObject({
  actionBindingId: z.string().min(1).max(128),
  sectionId: compiledSectionSchema.shape.sectionId,
  label: z.string().min(1).max(200),
  kind: z.enum(["view", "invoke", "agent", "workflow"]),
  effectCategory: effectCategorySchema,
});
export type CompositionActionRef = z.infer<typeof compositionActionRefSchema>;

/**
 * How the template was chosen.
 *
 * `mode` distinguishes a deterministic compile from a model decision, and a fallback is
 * labelled as a fallback. Presenting a fallback as if Jev had chosen it would make the one
 * measurement that matters — how often the selector is right — impossible to take.
 */
export const compositionSelectorProvenanceSchema = z.strictObject({
  mode: z.enum(["explicit", "jev", "fallback", "rank"]),
  model: z.string().min(1).max(120).optional(),
  policyVersion: z.string().min(1).max(80),
  confidence: z.number().min(0).max(1).optional(),
  margin: z.number().min(0).max(1).optional(),
  fallbackReason: z.string().min(1).max(500).optional(),
});
export type CompositionSelectorProvenance = z.infer<typeof compositionSelectorProvenanceSchema>;

export const compositionSourceRevisionSchema = z.strictObject({
  ref: z.string().min(1).max(200),
  revision: z.string().min(1).max(120),
});
export type CompositionSourceRevision = z.infer<typeof compositionSourceRevisionSchema>;

export const compositionProvenanceSchema = z.strictObject({
  createdAt: instantSchema,
  selector: compositionSelectorProvenanceSchema,
  sourceRevisions: z.array(compositionSourceRevisionSchema).max(64),
  /** What the compiler read to reach this decision, for evidence and for re-verification. */
  templateId: z.string().min(1).max(120),
  templateVersion: z.string().min(1).max(80),
});
export type CompositionProvenance = z.infer<typeof compositionProvenanceSchema>;

/**
 * The compiled layout document.
 *
 * Strict by construction: a spec with an unknown field is refused rather than stored, because
 * the fields that are not here are exactly the ones that would let a document do something.
 */
export const surfaceCompositionSpecSchema = z.strictObject({
  schemaVersion: z.literal(SURFACE_COMPOSITION_SCHEMA_VERSION),
  compositionId: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128),
  templateId: z.string().min(1).max(120),
  templateVersion: z.string().min(1).max(80),
  catalogDigest: z.string().min(1).max(120),
  sections: z.array(compositionSectionSchema).min(1).max(MAX_COMPOSITION_SECTIONS),
  initialState: compositionInitialStateSchema,
  actions: z.array(compositionActionRefSchema).max(32),
  provenance: compositionProvenanceSchema,
});
export type SurfaceCompositionSpec = z.infer<typeof surfaceCompositionSpecSchema>;

/* ------------------------------------------------------------------ *
 * The immutable snapshot bundle
 * ------------------------------------------------------------------ */

/**
 * A materialised snapshot.
 *
 * `tombstone` is deliberate. When the underlying data is deleted under a privacy policy the
 * bundle may no longer be shown, and a message that simply lost its bundle would look like a
 * rendering bug. Naming the removal keeps the history honest and stops the deleted values
 * being resurrected by re-reading the live source.
 */
export const presentationBundleSchema = z.strictObject({
  schemaVersion: z.literal(SURFACE_COMPOSITION_SCHEMA_VERSION),
  bundleId: z.string().min(1).max(128),
  snapshotId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128),
  ownerPrincipalId: z.string().min(1).max(128),
  catalogDigest: z.string().min(1).max(120),
  capturedAt: instantSchema,
  composition: surfaceCompositionSpecSchema,
  /**
   * The materialised sections.
   *
   * Empty only for a tombstone, and `checkPresentationBundle` is what enforces that: a live
   * bundle with no sections would be a snapshot that promises data and holds none.
   */
  sections: z.array(compiledSectionSchema).max(MAX_COMPOSITION_SECTIONS),
  sourceRevisions: z.array(compositionSourceRevisionSchema).max(64),
  tombstone: z
    .strictObject({
      reason: z.string().min(1).max(200),
      at: instantSchema,
    })
    .optional(),
});
export type PresentationBundle = z.infer<typeof presentationBundleSchema>;

/** Stored form: the bundle above plus the bytes it occupied when it was accepted. */
export const storedPresentationBundleSchema = presentationBundleSchema.extend({
  byteSize: z.int().nonnegative(),
});
export type StoredPresentationBundle = z.infer<typeof storedPresentationBundleSchema>;

/* ------------------------------------------------------------------ *
 * Selection result
 * ------------------------------------------------------------------ */

/**
 * What a selector may return.
 *
 * The shape is a closed set of opaque ids drawn from candidates the host supplied. A model
 * cannot name a definition, a dataset or a capability that was not offered, because there is
 * no field to put one in — `selected` carries ids and nothing else.
 */
export const miniAppSelectionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("selected"),
    templateId: z.string().min(1).max(120),
    templateVersion: z.string().min(1).max(80),
    sections: z
      .array(
        z.strictObject({
          slot: compositionSlotSchema,
          definitionId: z.string().min(1).max(160),
          definitionVersion: z.string().min(1).max(80),
          dataRef: z.string().min(1).max(200).optional(),
        }),
      )
      .min(1)
      .max(MAX_COMPOSITION_SECTIONS),
    confidence: z.number().min(0).max(1).optional(),
    margin: z.number().min(0).max(1).optional(),
  }),
  z.strictObject({
    status: z.literal("abstained"),
    reason: z.string().min(1).max(500),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.string().min(1).max(500),
  }),
]);
export type MiniAppSelection = z.infer<typeof miniAppSelectionSchema>;

/* ------------------------------------------------------------------ *
 * Pure checks
 * ------------------------------------------------------------------ */

export type CompositionCheck =
  | { ok: true }
  | { ok: false; problems: string[] };

/**
 * Structural checks a schema cannot express.
 *
 * Uniqueness, cross-references and size are relational rather than shape properties, so they
 * are computed here and shared by both the compiler and the persistence path. Running the same
 * function in both places is what stops "the compiler validated it" from being the only
 * evidence that a stored document is sound.
 */
export function checkSurfaceCompositionSpec(
  spec: SurfaceCompositionSpec,
  options: {
    /** Definition digests the host catalog actually holds, keyed `id@version`. */
    knownDefinitions?: ReadonlyMap<string, string>;
    /** Data references the host resolved for this composition. */
    allowedDataRefs?: ReadonlySet<string>;
    /** Action binding ids that exist and belong to this instance. */
    knownActionBindingIds?: ReadonlySet<string>;
    maxBytes?: number;
  } = {},
): CompositionCheck {
  const problems: string[] = [];

  const sectionIds = new Set<string>();
  const slots = new Set<string>();
  for (const section of spec.sections) {
    if (sectionIds.has(section.sectionId)) {
      problems.push(`duplicate section id "${section.sectionId}"`);
    }
    sectionIds.add(section.sectionId);

    if (slots.has(section.slot)) {
      problems.push(`slot "${section.slot}" is claimed by more than one section`);
    }
    slots.add(section.slot);

    if (options.knownDefinitions !== undefined) {
      const expected = options.knownDefinitions.get(
        definitionCatalogKey(section.definitionRef.id, section.definitionRef.version),
      );
      if (expected === undefined) {
        problems.push(`section "${section.sectionId}" names an unknown definition ${section.definitionRef.id}`);
      } else if (expected !== section.definitionRef.digest) {
        problems.push(
          `section "${section.sectionId}" pins digest ${section.definitionRef.digest} but the catalog holds ${expected}`,
        );
      }
    }

    if (options.allowedDataRefs !== undefined) {
      for (const ref of section.dataRefs) {
        if (!options.allowedDataRefs.has(ref)) {
          problems.push(`section "${section.sectionId}" references unauthorized data ${ref}`);
        }
      }
    }

    if (Object.hasOwn(section.props, "sections")) {
      problems.push(
        `section "${section.sectionId}" carries a nested "sections" prop; compositions are one level deep`,
      );
    }
  }

  for (const action of spec.actions) {
    if (!sectionIds.has(action.sectionId)) {
      problems.push(`action ${action.actionBindingId} references unknown section "${action.sectionId}"`);
    }
    if (options.knownActionBindingIds !== undefined && !options.knownActionBindingIds.has(action.actionBindingId)) {
      problems.push(`action ${action.actionBindingId} is not a binding of this instance`);
    }
  }

  if (spec.sections.length === 0) problems.push("a composition needs at least one section");

  if (options.maxBytes !== undefined && utf8Bytes(spec) > options.maxBytes) {
    problems.push(
      `the composition spec is ${utf8Bytes(spec)} bytes, over the ${options.maxBytes}-byte ceiling; fall back to a smaller layout instead of truncating it`,
    );
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** Bytes of the canonical JSON encoding. Used for every "is this too big" decision. */
export function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

export type BundleCheck =
  | { ok: true; byteSize: number }
  | { ok: false; byteSize: number; problems: string[] };

/** Size and reference checks for a bundle, before it is written. */
export function checkPresentationBundle(
  bundle: PresentationBundle,
  options: { knownDefinitions?: ReadonlyMap<string, string>; maxBytes?: number } = {},
): BundleCheck {
  const problems: string[] = [];
  const byteSize = utf8Bytes(bundle);

  if (bundle.tombstone === undefined && bundle.sections.length === 0) {
    problems.push("a live bundle materialises at least one section; an empty one is a tombstone");
  }

  const composed = checkSurfaceCompositionSpec(bundle.composition, {
    ...(options.knownDefinitions === undefined ? {} : { knownDefinitions: options.knownDefinitions }),
  });
  if (!composed.ok) problems.push(...composed.problems);

  const specSections = new Map(bundle.composition.sections.map((section) => [section.sectionId, section]));
  if (bundle.sections.length !== specSections.size) {
    problems.push("the bundle materialises a different number of sections than the spec declares");
  }
  for (const section of bundle.sections) {
    const declared = specSections.get(section.sectionId);
    if (declared === undefined) {
      problems.push(`bundle section "${section.sectionId}" is not in the composition spec`);
      continue;
    }
    if (declared.definitionRef.digest !== section.definitionRef.digest) {
      problems.push(`bundle section "${section.sectionId}" was materialised against a different definition digest`);
    }
  }

  const maxBytes = options.maxBytes ?? MAX_PRESENTATION_BUNDLE_BYTES;
  if (byteSize > maxBytes) {
    problems.push(
      `the presentation bundle is ${byteSize} bytes, over the ${maxBytes}-byte ceiling; keep the message's text alternative and record the overflow rather than truncating silently`,
    );
  }

  return problems.length === 0 ? { ok: true, byteSize } : { ok: false, byteSize, problems };
}

/**
 * Whether a selection only names things the host offered.
 *
 * Applied after the response is parsed, because "schema-valid" and "about this request" are
 * different claims: a well-formed answer naming a definition from another tenant is still an
 * answer the host must refuse.
 */
export function checkSelectionAgainstCandidates(
  selection: Extract<MiniAppSelection, { status: "selected" }>,
  candidates: {
    templates: readonly { templateId: string; templateVersion: string }[];
    definitions: readonly { id: string; version: string }[];
    dataRefs: readonly string[];
    slotsForTemplate: (templateId: string) => readonly CompositionSlot[] | undefined;
  },
): CompositionCheck {
  const problems: string[] = [];

  const template = candidates.templates.find(
    (entry) => entry.templateId === selection.templateId && entry.templateVersion === selection.templateVersion,
  );
  if (template === undefined) {
    problems.push(`template ${selection.templateId}@${selection.templateVersion} was not a candidate`);
  }

  const allowedSlots = candidates.slotsForTemplate(selection.templateId);
  if (allowedSlots === undefined) {
    problems.push(`template ${selection.templateId} has no known slot set`);
  }

  const seenSlots = new Set<string>();
  for (const section of selection.sections) {
    if (allowedSlots !== undefined && !allowedSlots.includes(section.slot)) {
      problems.push(`slot "${section.slot}" is not part of template ${selection.templateId}`);
    }
    if (seenSlots.has(section.slot)) {
      problems.push(`slot "${section.slot}" was selected twice`);
    }
    seenSlots.add(section.slot);

    const offered = candidates.definitions.some(
      (entry) => entry.id === section.definitionId && entry.version === section.definitionVersion,
    );
    if (!offered) {
      problems.push(`definition ${section.definitionId}@${section.definitionVersion} was not a candidate`);
    }

    if (section.dataRef !== undefined && !candidates.dataRefs.includes(section.dataRef)) {
      problems.push(`data reference ${section.dataRef} was not offered for this request`);
    }
  }

  if (selection.sections.length > MAX_COMPOSITION_SECTIONS) {
    problems.push(`a composition may hold at most ${MAX_COMPOSITION_SECTIONS} sections`);
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Catalog key for a definition, matching `CatalogRegistry`'s `id@version`.
 *
 * Exported rather than inlined because the id already carries a version suffix (`canvas.line@1`),
 * so a hand-written key is easy to get subtly wrong — `metrics@1@1.0.0` is the correct form and
 * not what anyone types from memory.
 */
export function definitionCatalogKey(id: string, version: string): string {
  return `${id}@${version}`;
}

/** Drop the materialised rows, leaving the layout's view of a section. */
export function toCompositionSection(section: CompiledSection): CompositionSection {
  return {
    sectionId: section.sectionId,
    slot: section.slot,
    definitionRef: section.definitionRef,
    props: section.props,
    dataRefs: section.dataRefs,
    textAlternative: section.textAlternative,
  };
}

/** Confidence policy applied to a Choice answer. Proposed defaults, calibrated in Phase 6. */
export const SELECTION_CONFIDENCE_FLOOR = 0.85;
export const SELECTION_MARGIN_FLOOR = 0.2;

/**
 * Whether a Choice result is decisive enough to act on.
 *
 * Both a floor and a margin are applied. A 0.9 winner beside a 0.1 runner-up is a decision; a
 * 0.5 winner beside a 0.45 runner-up is a coin toss that happens to be spelled as a
 * probability.
 */
export function selectionIsDecisive(input: {
  top: number;
  runnerUp?: number;
  floor?: number;
  margin?: number;
}): { decisive: true } | { decisive: false; reason: string } {
  const floor = input.floor ?? SELECTION_CONFIDENCE_FLOOR;
  const margin = input.margin ?? SELECTION_MARGIN_FLOOR;
  if (!Number.isFinite(input.top) || input.top < 0 || input.top > 1) {
    return { decisive: false, reason: `probability ${String(input.top)} is not a finite value in [0,1]` };
  }
  if (input.top < floor) {
    return { decisive: false, reason: `top probability ${input.top.toFixed(3)} is below the ${floor} floor` };
  }
  if (input.runnerUp !== undefined) {
    const gap = input.top - input.runnerUp;
    if (gap < margin) {
      return {
        decisive: false,
        reason: `the margin ${gap.toFixed(3)} between the winner and the runner-up is below the ${margin} floor`,
      };
    }
  }
  return { decisive: true };
}

/** Noul answers a probability with no confidence field; the middle band means "do not guess". */
export function noulVerdict(
  probability: number,
  thresholds: { on?: number; off?: number } = {},
): "on" | "off" | "uncertain" {
  const on = thresholds.on ?? 0.85;
  const off = thresholds.off ?? 0.15;
  if (!Number.isFinite(probability)) return "uncertain";
  if (probability >= on) return "on";
  if (probability <= off) return "off";
  return "uncertain";
}
