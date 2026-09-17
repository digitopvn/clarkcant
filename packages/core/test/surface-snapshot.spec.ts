import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CompiledSection,
  type Instant,
  type StoredPresentationBundle,
  type WidgetDefinition,
  compileActionBinding,
} from "@clarkcant/contracts";
import {
  MIGRATIONS,
  type Database,
  closeDatabase,
  createBackup,
  getPresentationBundle,
  getSurfaceComposition,
  migrate,
  openDatabase,
  tableCounts,
  tombstonePresentationBundle,
  verifyBackup,
} from "@clarkcant/storage";

import {
  bumpRevision,
  captureCompositeSurface,
  captureSnapshot,
  createInstance,
  type WidgetDeps,
} from "../src/index.ts";

/**
 * Composed surface persistence (Phase 1).
 *
 * These tests are about atomicity and immutability, not about rendering. The failure they exist
 * to prevent is the quiet one: a snapshot that still parses after the live data moved, and shows
 * the new numbers under the old timestamp.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;

const OVERVIEW: WidgetDefinition = {
  id: "canvas.overview@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: { type: "object" },
  stateVersion: 1,
  semanticDescription: "A composed overview that lays out several leaf sections",
  requestedCapabilities: [],
  sizing: { compact: true, expanded: true },
  textFallback: "An overview that cannot be rendered is described in text.",
  effectCategories: ["read"],
  datasetRefs: [],
};

let counter = 0;

function makeDeps(db: Database): WidgetDeps {
  return {
    db,
    nodeId: "node_local",
    now: () => AT,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  };
}

function sections(): CompiledSection[] {
  return [
    {
      sectionId: "metrics",
      slot: "metrics",
      definitionRef: { id: "canvas.metrics@1", version: "1.0.0", digest: "sha256:metrics" },
      props: { datasetRef: "ds_tasks" },
      dataRefs: ["ds_tasks"],
      rows: [{ label: "done", value: 4 }],
      textAlternative: "Four tasks completed.",
    },
    {
      sectionId: "trend",
      slot: "trend",
      definitionRef: { id: "canvas.line@1", version: "1.0.0", digest: "sha256:line" },
      props: { datasetRef: "ds_tasks" },
      dataRefs: ["ds_tasks"],
      rows: [
        { date: "2026-09-16", value: 2 },
        { date: "2026-09-17", value: 2 },
      ],
      textAlternative: "Two tasks completed on each of the last two days.",
    },
  ];
}

function capture(deps: WidgetDeps, overrides: Record<string, unknown> = {}) {
  return captureCompositeSurface(deps, {
    conversationId: "conv_1",
    messageId: "msg_1",
    principalId: "prin_owner" as never,
    definition: OVERVIEW,
    packageDigest: "sha256:overview",
    catalogDigest: "sha256:catalog",
    templateId: "overview",
    templateVersion: "1",
    sections: sections(),
    props: { period: "week" },
    initialState: { period: "week", timezone: "Asia/Saigon" },
    provenance: {
      createdAt: AT,
      templateId: "overview",
      templateVersion: "1",
      selector: { mode: "explicit", policyVersion: "1" },
      sourceRevisions: [{ ref: "tasks", revision: "12" }],
    },
    textAlternative: "Work overview for this week.",
    dataRefs: ["ds_tasks"],
    at: AT,
    ...overrides,
  });
}

function rowCount(db: Database, table: string): number {
  const counts = tableCounts(db);
  return counts[table] ?? 0;
}

let temporary: string | undefined;

afterEach(() => {
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
  temporary = undefined;
});

describe("composed surface capture", () => {
  let db: Database;
  let deps: WidgetDeps;

  beforeEach(() => {
    counter = 0;
    db = openDatabase({ path: ":memory:" });
    migrate(db);
    deps = makeDeps(db);
  });

  it("writes the instance, the spec, the snapshot and the bundle together", () => {
    const result = capture(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const spec = getSurfaceComposition(db, result.composition.compositionId, "prin_owner");
    expect(spec?.sections.map((section) => section.sectionId)).toEqual(["metrics", "trend"]);
    // The spec must not carry the rows: data belongs in the bundle, not in the layout document.
    expect(JSON.stringify(spec)).not.toContain('"label":"done"');
    // And the bundle must not be JSON.stringify-equal to the spec: it is the one holding data.
    expect(JSON.stringify(result.bundle)).toContain('"label":"done"');

    const stored = getPresentationBundle(db, result.bundle.bundleId, "prin_owner");
    expect(stored?.byteSize).toBe(result.bundle.byteSize);
    expect(stored?.sections[1]?.rows).toHaveLength(2);

    expect(result.snapshot.bundleRef).toBe(result.bundle.bundleId);
    expect(result.snapshot.capturedRevision).toBe(1);
  });

  it("keeps revision N through a live update and through a restart", () => {
    temporary = mkdtempSync(join(tmpdir(), "clarkcant-surface-"));
    const path = join(temporary, "node.sqlite");
    const fileDb = openDatabase({ path });
    migrate(fileDb);
    const fileDeps = makeDeps(fileDb);

    const result = capture(fileDeps, { messageId: "msg_n" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundleId = result.bundle.bundleId;
    const before = getPresentationBundle(fileDb, bundleId, "prin_owner");
    expect(before?.sections[0]?.rows).toEqual([{ label: "done", value: 4 }]);

    // The live instance moves on. History must not follow it.
    bumpRevision(fileDeps, result.instance.instanceId, "presentation", { props: { period: "month" } });
    const afterLive = getPresentationBundle(fileDb, bundleId, "prin_owner");
    expect(afterLive?.sections[0]?.rows).toEqual([{ label: "done", value: 4 }]);
    expect(afterLive?.composition.initialState.period).toBe("week");
    expect(afterLive?.byteSize).toBe(before?.byteSize);

    closeDatabase(fileDb);

    const reopened = openDatabase({ path });
    try {
      const afterRestart = getPresentationBundle(reopened, bundleId, "prin_owner");
      expect(afterRestart?.sections[0]?.rows).toEqual([{ label: "done", value: 4 }]);
      expect(afterRestart?.composition.sections).toHaveLength(2);
      expect(getSurfaceComposition(reopened, result.composition.compositionId, "prin_owner")).toBeDefined();
    } finally {
      closeDatabase(reopened);
    }
  });

  it("refuses an oversized bundle and writes nothing at all", () => {
    const result = capture(deps, { maxBundleBytes: 64 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("BUNDLE_TOO_LARGE");

    expect(rowCount(db, "widget_instances")).toBe(0);
    expect(rowCount(db, "widget_snapshots")).toBe(0);
    expect(rowCount(db, "surface_compositions")).toBe(0);
    expect(rowCount(db, "presentation_bundles")).toBe(0);
  });

  it("rolls back every artifact when a write fails inside the transaction", () => {
    const instanceId = "winst_dup";
    const binding = (id: string) =>
      compileActionBinding({
        bindingId: id,
        instance: {
          instanceId,
          ownerNodeId: "node_local",
          definitionRef: { id: OVERVIEW.id, version: OVERVIEW.version, packageDigest: "sha256:overview" },
          actionBindingRevision: 1,
        },
        packageGeneration: "sha256:overview",
        label: "Save this view",
        proposal: { kind: "view", operation: "save-view", args: {} },
        inputSchema: { type: "object" },
        allowedDataRefs: ["ds_tasks"],
        fixedConstraints: {},
        effectCategory: "read",
        requiresApproval: false,
        limits: {},
        bindingDigest: "sha256:digest",
        at: AT,
        knownCapabilities: new Set<string>(),
      });

    const first = binding("act_1");
    if (!first.ok) throw new Error("fixture binding should compile");
    // Same id twice: the second insert violates the primary key, which is the cheap stand-in for
    // any mid-transaction failure. What matters is that the whole capture is undone, not just the
    // statement that failed.
    expect(() =>
      capture(deps, { bindings: [{ binding: first.binding, sectionId: "metrics" }, { binding: first.binding, sectionId: "trend" }] }),
    ).toThrow();

    expect(rowCount(db, "widget_instances")).toBe(0);
    expect(rowCount(db, "action_bindings")).toBe(0);
    expect(rowCount(db, "widget_snapshots")).toBe(0);
    expect(rowCount(db, "surface_compositions")).toBe(0);
    expect(rowCount(db, "presentation_bundles")).toBe(0);
  });

  it("refuses a binding that belongs to a different definition", () => {
    const compiled = compileActionBinding({
      bindingId: "act_other",
      instance: {
        instanceId: "winst_x",
        ownerNodeId: "node_local",
        definitionRef: { id: "canvas.table@1", version: "1.0.0", packageDigest: "sha256:table" },
        actionBindingRevision: 1,
      },
      packageGeneration: "sha256:table",
      label: "Export",
      proposal: { kind: "view", operation: "export", args: {} },
      inputSchema: { type: "object" },
      allowedDataRefs: [],
      fixedConstraints: {},
      effectCategory: "read",
      requiresApproval: false,
      limits: {},
      bindingDigest: "sha256:digest",
      at: AT,
      knownCapabilities: new Set<string>(),
    });
    if (!compiled.ok) throw new Error("fixture binding should compile");

    const result = capture(deps, { bindings: [{ binding: compiled.binding, sectionId: "metrics" }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("OWNERSHIP_MISMATCH");
    expect(rowCount(db, "widget_instances")).toBe(0);
    expect(rowCount(db, "presentation_bundles")).toBe(0);
  });

  it("refuses a binding attached to a section that does not exist", () => {
    const compiled = compileActionBinding({
      bindingId: "act_dangling",
      instance: {
        instanceId: "winst_y",
        ownerNodeId: "node_local",
        definitionRef: { id: OVERVIEW.id, version: OVERVIEW.version, packageDigest: "sha256:overview" },
        actionBindingRevision: 1,
      },
      packageGeneration: "sha256:overview",
      label: "Save",
      proposal: { kind: "view", operation: "save-view", args: {} },
      inputSchema: { type: "object" },
      allowedDataRefs: [],
      fixedConstraints: {},
      effectCategory: "read",
      requiresApproval: false,
      limits: {},
      bindingDigest: "sha256:digest",
      at: AT,
      knownCapabilities: new Set<string>(),
    });
    if (!compiled.ok) throw new Error("fixture binding should compile");

    const result = capture(deps, { bindings: [{ binding: compiled.binding, sectionId: "sidebar" }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SPEC_INVALID");
  });

  it("does not let a second principal read the composition or the bundle", () => {
    const result = capture(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(getSurfaceComposition(db, result.composition.compositionId, "prin_other")).toBeUndefined();
    expect(getPresentationBundle(db, result.bundle.bundleId, "prin_other")).toBeUndefined();
    expect(getPresentationBundle(db, result.bundle.bundleId, "prin_owner")).toBeDefined();
  });

  it("tombstones a bundle rather than resurrecting deleted data", () => {
    const result = capture(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(tombstonePresentationBundle(db, result.bundle.bundleId, "source deleted by retention policy", AT)).toBe(true);
    const stored = getPresentationBundle(db, result.bundle.bundleId, "prin_owner") as
      | (StoredPresentationBundle & { tombstone?: { reason: string } })
      | undefined;
    expect(stored).toBeDefined();
    // The rows are gone from the stored document; the reason is what remains. Re-reading the live
    // source to fill the panel back in is the behaviour this replaces.
    expect(JSON.stringify(stored)).not.toContain('"label":"done"');
    expect(stored?.tombstone?.reason).toBe("source deleted by retention policy");
    // Tombstoning twice is a no-op rather than a second, louder removal.
    expect(tombstonePresentationBundle(db, result.bundle.bundleId, "again", AT)).toBe(false);
  });
});

describe("migration and restore", () => {
  it("reads rows written before the composition tables existed", () => {
    temporary = mkdtempSync(join(tmpdir(), "clarkcant-upgrade-"));
    const path = join(temporary, "node.sqlite");
    const old = openDatabase({ path });
    migrate(old, MIGRATIONS.filter((migration) => migration.version <= 9));

    const oldDeps = makeDeps(old);
    const instance = createInstance(oldDeps, {
      definition: OVERVIEW,
      packageDigest: "sha256:overview",
      ownerPrincipalId: "prin_owner" as never,
      props: { period: "week" },
    });
    const legacySnapshot = captureSnapshot(oldDeps, {
      messageId: "msg_legacy",
      instance,
      textAlternative: "An overview from before bundles existed.",
      presentationRef: `catalog:${OVERVIEW.id}`,
    });
    const before = tableCounts(old);
    closeDatabase(old);

    const upgraded = openDatabase({ path });
    try {
      const result = migrate(upgraded);
      expect(result.applied).toContain(10);
      const counts = tableCounts(upgraded);
      expect(counts.widget_snapshots).toBe(before.widget_snapshots);
      expect(counts.widget_instances).toBe(before.widget_instances);
      expect(counts.presentation_bundles).toBe(0);
      expect(counts.surface_compositions).toBe(0);

      // The legacy snapshot is still readable and still has no bundle, which is the signal the
      // renderer uses to show the text alternative instead of current props.
      const row = upgraded
        .prepare("SELECT document FROM widget_snapshots WHERE snapshot_id = ?")
        .get(legacySnapshot.snapshotId) as { document: string } | undefined;
      expect(row).toBeDefined();
      const parsed = JSON.parse(row?.document ?? "{}") as { bundleRef?: string; textAlternative?: string };
      expect(parsed.bundleRef).toBeUndefined();
      expect(parsed.textAlternative).toBe("An overview from before bundles existed.");
    } finally {
      closeDatabase(upgraded);
    }
  });

  it("backs up and verifies a database that holds a composition and a bundle", () => {
    temporary = mkdtempSync(join(tmpdir(), "clarkcant-backup-"));
    const path = join(temporary, "node.sqlite");
    const db = openDatabase({ path });
    try {
      migrate(db);
      const deps = makeDeps(db);
      const result = capture(deps);
      expect(result.ok).toBe(true);

      const destination = join(temporary, "backup");
      const manifest = createBackup({ db, destination, now: () => AT });
      // Read from the migration list rather than written as a literal: a later migration must not
      // be able to turn this into a false failure, and the version it should be is whatever the
      // list says it is.
      expect(manifest.schemaVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
      expect(manifest.tableCounts.presentation_bundles).toBe(1);
      expect(manifest.tableCounts.surface_compositions).toBe(1);

      const verification = verifyBackup(destination);
      expect(verification.problems).toEqual([]);
      expect(verification.ok).toBe(true);
      expect(verification.tableCounts.surface_compositions).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });
});
