import { describe, expect, it } from "vitest";

import {
  type CompiledSection,
  type PresentationBundle,
  type SurfaceCompositionSpec,
  MAX_COMPOSITION_SECTIONS,
  MAX_PRESENTATION_BUNDLE_BYTES,
  checkPresentationBundle,
  checkSelectionAgainstCandidates,
  definitionCatalogKey,
  checkSurfaceCompositionSpec,
  compositionProvenanceSchema,
  instantSchema,
  miniAppSelectionSchema,
  noulVerdict,
  presentationBundleSchema,
  selectionIsDecisive,
  surfaceCompositionSpecSchema,
  toCompositionSection,
  utf8Bytes,
  widgetSnapshotSchema,
} from "../src/index.ts";

/**
 * Composed-surface contracts (Phase 1).
 *
 * The schema is doing more work here than in most of this repository: a composition document is
 * stored, read back months later, and rendered without a human in the loop. So the tests below
 * are less about fields being present and more about the four things a stored document must not
 * be able to do — recurse, name a definition nobody offered, carry data it was not authorized
 * for, and claim a confidence it cannot support.
 */

const AT = instantSchema.parse("2026-09-17T04:00:00.000Z");

const DIGEST = "sha256:overview-leaf";

function section(overrides: Partial<CompiledSection> = {}): CompiledSection {
  return {
    sectionId: "metrics",
    slot: "metrics",
    definitionRef: { id: "canvas.metrics@1", version: "1.0.0", digest: DIGEST },
    props: { datasetRef: "ds_tasks" },
    dataRefs: ["ds_tasks"],
    rows: [{ label: "done", value: 4 }],
    textAlternative: "Four tasks completed.",
    ...overrides,
  };
}

function spec(overrides: Partial<SurfaceCompositionSpec> = {}): SurfaceCompositionSpec {
  return surfaceCompositionSpecSchema.parse({
    schemaVersion: 1,
    compositionId: "comp_1",
    instanceId: "winst_1",
    templateId: "overview",
    templateVersion: "1",
    catalogDigest: "sha256:catalog",
    sections: [toCompositionSection(section())],
    initialState: { period: "week", timezone: "Asia/Saigon" },
    actions: [],
    provenance: {
      createdAt: AT,
      templateId: "overview",
      templateVersion: "1",
      selector: { mode: "explicit", policyVersion: "1" },
      sourceRevisions: [{ ref: "tasks", revision: "12" }],
    },
    ...overrides,
  });
}

describe("composition spec bounds", () => {
  it("refuses a duplicate section id", () => {
    const parsed = spec({
      sections: [
        toCompositionSection(section()),
        toCompositionSection(section({ slot: "trend", definitionRef: { id: "canvas.line@1", version: "1.0.0", digest: DIGEST } })),
      ],
    });
    const check = checkSurfaceCompositionSpec(parsed);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.join(" ")).toContain('duplicate section id "metrics"');
  });

  it("refuses one slot claimed by two sections", () => {
    const parsed = spec({
      sections: [
        toCompositionSection(section()),
        toCompositionSection(section({ sectionId: "metrics-again", slot: "metrics" })),
      ],
    });
    const check = checkSurfaceCompositionSpec(parsed);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.join(" ")).toContain('slot "metrics" is claimed by more than one section');
  });

  it("refuses a slot the container does not have", () => {
    const candidate = { ...spec(), sections: [{ ...toCompositionSection(section()), slot: "sidebar" }] };
    expect(surfaceCompositionSpecSchema.safeParse(candidate).success).toBe(false);
  });

  it("refuses a recursive section", () => {
    // `sections` is not a property of a section, so the only way to nest one is inside props.
    // That is exactly the hole a "one level deep" promise usually has.
    const parsed = spec({
      sections: [toCompositionSection(section({ props: { datasetRef: "ds_tasks", sections: [section()] } }))],
    });
    const check = checkSurfaceCompositionSpec(parsed);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.join(" ")).toContain("one level deep");
  });

  it("refuses more sections than the container lays out", () => {
    const many = Array.from({ length: MAX_COMPOSITION_SECTIONS + 1 }, (_unused, index) =>
      toCompositionSection(
        section({
          sectionId: `s${index}`,
          slot: index % 2 === 0 ? "metrics" : "trend",
        }),
      ),
    );
    expect(surfaceCompositionSpecSchema.safeParse({ ...spec(), sections: many }).success).toBe(false);
  });

  it("refuses an unknown definition, an unauthorized data ref and a dangling action", () => {
    const parsed = spec({
      actions: [
        { actionBindingId: "act_1", sectionId: "metrics", label: "Save view", kind: "view", effectCategory: "read" },
      ],
    });
    const check = checkSurfaceCompositionSpec(parsed, {
      knownDefinitions: new Map([[definitionCatalogKey("canvas.metrics@1", "1.0.0"), "sha256:something-else"]]),
      allowedDataRefs: new Set(["ds_other"]),
      knownActionBindingIds: new Set(["act_other"]),
    });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      const joined = check.problems.join("\n");
      expect(joined).toContain("pins digest");
      expect(joined).toContain("unauthorized data ds_tasks");
      expect(joined).toContain("is not a binding of this instance");
    }
  });

  it("refuses a spec over the catalog ceiling instead of truncating it", () => {
    const parsed = spec();
    const check = checkSurfaceCompositionSpec(parsed, { maxBytes: 10 });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.join(" ")).toContain("over the 10-byte ceiling");
  });
});

describe("presentation bundles", () => {
  function bundle(): PresentationBundle {
    const composition = spec();
    return presentationBundleSchema.parse({
      schemaVersion: 1,
      bundleId: "bundle_1",
      snapshotId: "wsnap_1",
      messageId: "msg_1",
      instanceId: "winst_1",
      ownerPrincipalId: "prin_owner",
      catalogDigest: "sha256:catalog",
      capturedAt: AT,
      composition,
      sections: [section()],
      sourceRevisions: [{ ref: "tasks", revision: "12" }],
    });
  }

  it("matches the spec's sections by id and digest", () => {
    const good = checkPresentationBundle(bundle());
    expect(good.ok).toBe(true);

    const mismatched = presentationBundleSchema.parse({
      ...bundle(),
      sections: [section({ sectionId: "other" })],
    });
    const bad = checkPresentationBundle(mismatched);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.join(" ")).toContain("not in the composition spec");
  });

  it("reports an oversized bundle with its measured size", () => {
    const result = checkPresentationBundle(bundle(), { maxBytes: 32 });
    expect(result.ok).toBe(false);
    expect(result.byteSize).toBeGreaterThan(32);
    expect(result.byteSize).toBeLessThan(MAX_PRESENTATION_BUNDLE_BYTES);
  });

  it("keeps a legacy snapshot readable while the new fields stay optional", () => {
    // A snapshot written before bundles existed parses, and its missing bundleRef is the signal
    // to show the text alternative rather than substitute current props.
    const legacy = widgetSnapshotSchema.parse({
      snapshotId: "wsnap_legacy",
      messageId: "msg_1",
      capturedRevision: 3,
      capturedAt: AT,
      textAlternative: "A saved chart.",
      presentationRef: "catalog:canvas.line@1",
      stale: false,
    });
    expect(legacy.bundleRef).toBeUndefined();

    const modern = widgetSnapshotSchema.parse({ ...legacy, bundleRef: "bundle_1", bundleSchemaVersion: 1 });
    expect(modern.bundleRef).toBe("bundle_1");
    expect(utf8Bytes(modern)).toBeGreaterThan(utf8Bytes(legacy));
  });
});

describe("selection shape and policy", () => {
  it("only names candidates the host offered", () => {
    const selection = miniAppSelectionSchema.parse({
      status: "selected",
      templateId: "overview",
      templateVersion: "1",
      sections: [{ slot: "metrics", definitionId: "canvas.metrics@1", definitionVersion: "1.0.0", dataRef: "ds_tasks" }],
      confidence: 0.95,
      margin: 0.4,
    });
    if (selection.status !== "selected") throw new Error("expected a selection");

    const accepted = checkSelectionAgainstCandidates(selection, {
      templates: [{ templateId: "overview", templateVersion: "1" }],
      definitions: [{ id: "canvas.metrics@1", version: "1.0.0" }],
      dataRefs: ["ds_tasks"],
      slotsForTemplate: () => ["metrics", "trend"],
    });
    expect(accepted.ok).toBe(true);

    const refused = checkSelectionAgainstCandidates(selection, {
      templates: [{ templateId: "overview", templateVersion: "1" }],
      definitions: [{ id: "canvas.bar@1", version: "1.0.0" }],
      dataRefs: [],
      slotsForTemplate: () => ["trend"],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      const joined = refused.problems.join("\n");
      expect(joined).toContain("was not a candidate");
      expect(joined).toContain('slot "metrics" is not part of template');
      expect(joined).toContain("was not offered");
    }
  });

  it("requires both a floor and a margin before acting on a probability", () => {
    expect(selectionIsDecisive({ top: 0.95, runnerUp: 0.05 }).decisive).toBe(true);
    expect(selectionIsDecisive({ top: 0.5, runnerUp: 0.45 }).decisive).toBe(false);
    expect(selectionIsDecisive({ top: 0.5, runnerUp: 0.1 }).decisive).toBe(false);
    expect(selectionIsDecisive({ top: Number.NaN }).decisive).toBe(false);
  });

  it("treats Noul's middle band as uncertainty rather than a boolean", () => {
    // The live smoke returned 0.58 for a general calendar question. A policy that rounded that
    // to "yes" would have silently guessed.
    expect(noulVerdict(0.58)).toBe("uncertain");
    expect(noulVerdict(0.91)).toBe("on");
    expect(noulVerdict(0.02)).toBe("off");
    expect(noulVerdict(Number.NaN)).toBe("uncertain");
  });

  it("round-trips provenance without losing the policy version", () => {
    const provenance = compositionProvenanceSchema.parse({
      createdAt: AT,
      templateId: "overview",
      templateVersion: "1",
      selector: { mode: "jev", model: "jev-1.13.0", policyVersion: "2026-09-17", confidence: 0.93, margin: 0.31 },
      sourceRevisions: [{ ref: "tasks", revision: "12" }],
    });
    const parsed = spec({ provenance });
    expect(parsed.provenance.selector.model).toBe("jev-1.13.0");
    expect(parsed.provenance.selector.mode).toBe("jev");
  });
});
