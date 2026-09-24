import { describe, expect, it } from "vitest";

import type { WidgetDefinition } from "@clarkcant/contracts";
import { migrate, openDatabase } from "@clarkcant/storage";

import { activeGeneration } from "../src/install-lifecycle.ts";
import { listInstalledPackages } from "../src/installed-packages.ts";
import {
  listRestorablePackages,
  previousPackageVersion,
  restorePackage,
  rollbackPackage,
  uninstallPackage,
} from "../src/package-lifecycle.ts";
import { createInstance, type WidgetDeps } from "../src/widget-service.ts";
import { initialiseState, readInstanceState } from "../src/widget-lifecycle.ts";

/**
 * Uninstalling, restoring and rolling back a package.
 *
 * Each of these moves which generation is active and which instances can run. None of them deletes anything: the
 * person's widget state and the conversation's snapshots outlive the code that wrote them, and the generation rows
 * outlive an uninstall so it can be undone without fetching anything.
 */

const PACKAGE = "com.example.board";
const WIDGET = "com.example.board.main@1";
const OWNER = "prin_owner";

const DEF: WidgetDefinition = {
  id: WIDGET,
  version: "2.0.0",
  renderer: "isolated-app",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: { type: "object" },
  stateVersion: 1,
  sizing: { compact: true, expanded: true },
  textFallback: "A task list.",
  effectCategories: [],
  datasetRefs: [],
  semanticDescription: "A task list",
  requestedCapabilities: [],
};

let clock = 0;
let counter = 0;

function makeDeps(): WidgetDeps {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  return {
    db,
    nodeId: "node_a",
    // A clock that moves, because the order generations were retired in is what restore and rollback read.
    now: () => new Date(Date.UTC(2026, 8, 24, 6, 0, clock++)).toISOString() as never,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  } as WidgetDeps;
}

/** Record a generation as the install supervisor would, retiring whatever was active. */
function install(deps: WidgetDeps, version: string, digest = `sha256:${version}`): void {
  const at = deps.now();
  deps.db
    .prepare("UPDATE package_generations SET superseded_at = ? WHERE package_id = ? AND node_id = ? AND superseded_at IS NULL")
    .run(at, PACKAGE, deps.nodeId);
  const generation = {
    generationId: `${PACKAGE}@${version}:code_${version}`,
    packageId: PACKAGE,
    version,
    digest,
    nodeId: deps.nodeId,
    codeGeneration: `code_${version}`,
    activatedAt: at,
    uiOnlyFacets: ["ui"],
    grantedCapabilities: [],
  };
  deps.db
    .prepare(
      `INSERT INTO package_generations
         (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(generation.generationId, PACKAGE, version, digest, deps.nodeId, generation.codeGeneration, at, JSON.stringify(generation));
}

function lifecycleOf(deps: WidgetDeps, instanceId: string): string {
  return (deps.db.prepare("SELECT lifecycle FROM widget_instances WHERE instance_id = ?").get(instanceId) as { lifecycle: string })
    .lifecycle;
}

function snapshotCount(deps: WidgetDeps): number {
  return (deps.db.prepare("SELECT COUNT(*) AS n FROM widget_snapshots").get() as { n: number }).n;
}

const always = () => true;

describe("uninstalling a package", () => {
  it("retires the active generation, takes its widgets offline and keeps their state", () => {
    const deps = makeDeps();
    install(deps, "1.0.0");
    const { instanceId } = createInstance(deps, { definition: DEF, packageDigest: "sha256:1.0.0", ownerPrincipalId: OWNER as never, props: {} });
    initialiseState(deps, { instanceId, body: { items: ["kept"] }, stateVersion: 1 });
    const snapshotsBefore = snapshotCount(deps);

    const outcome = uninstallPackage(deps, { packageId: PACKAGE, widgetIds: [WIDGET] });

    expect(outcome).toEqual({
      ok: true,
      packageId: PACKAGE,
      activeVersion: undefined,
      previousVersion: "1.0.0",
      instancesOffline: 1,
      instancesRestored: 0,
      statesKept: 1,
    });
    expect(activeGeneration(deps, PACKAGE, deps.nodeId)).toBeUndefined();
    expect(listInstalledPackages(deps)).toEqual([]);
    expect(lifecycleOf(deps, instanceId)).toBe("offline");
    expect(readInstanceState(deps, instanceId)?.body).toEqual({ items: ["kept"] });
    expect(snapshotCount(deps)).toBe(snapshotsBefore);
  });

  it("refuses a package that is not installed", () => {
    const deps = makeDeps();

    expect(uninstallPackage(deps, { packageId: PACKAGE, widgetIds: [WIDGET] })).toMatchObject({ ok: false, code: "NOT_INSTALLED" });
  });

  it("leaves another package's widgets alone", () => {
    const deps = makeDeps();
    install(deps, "1.0.0");
    const other = createInstance(deps, {
      definition: { ...DEF, id: "com.example.other.main@1" },
      packageDigest: "sha256:other",
      ownerPrincipalId: OWNER as never,
      props: {},
    });

    uninstallPackage(deps, { packageId: PACKAGE, widgetIds: [WIDGET] });

    expect(lifecycleOf(deps, other.instanceId)).not.toBe("offline");
  });
});

describe("restoring an uninstalled package", () => {
  it("reactivates the same generation and brings the same instances back with their state", () => {
    const deps = makeDeps();
    install(deps, "1.0.0");
    const { instanceId } = createInstance(deps, { definition: DEF, packageDigest: "sha256:1.0.0", ownerPrincipalId: OWNER as never, props: {} });
    initialiseState(deps, { instanceId, body: { items: ["kept"] }, stateVersion: 1 });
    uninstallPackage(deps, { packageId: PACKAGE, widgetIds: [WIDGET] });

    expect(listRestorablePackages(deps)).toEqual([
      { packageId: PACKAGE, version: "1.0.0", digest: "sha256:1.0.0", uninstalledAt: expect.any(String) },
    ]);

    const outcome = restorePackage(deps, { packageId: PACKAGE, widgetIds: [WIDGET], available: always });

    expect(outcome).toMatchObject({ ok: true, activeVersion: "1.0.0", instancesRestored: 1, statesKept: 1 });
    expect(activeGeneration(deps, PACKAGE, deps.nodeId)?.version).toBe("1.0.0");
    expect(lifecycleOf(deps, instanceId)).toBe("ready");
    expect(readInstanceState(deps, instanceId)?.body).toEqual({ items: ["kept"] });
    expect(listRestorablePackages(deps)).toEqual([]);
  });

  it("puts each instance back in the lifecycle it had, and leaves alone one that was already offline", () => {
    const deps = makeDeps();
    install(deps, "1.0.0");
    const waiting = createInstance(deps, { definition: DEF, packageDigest: "sha256:1.0.0", ownerPrincipalId: OWNER as never, props: {} });
    const alreadyOffline = createInstance(deps, { definition: DEF, packageDigest: "sha256:1.0.0", ownerPrincipalId: OWNER as never, props: {} });
    deps.db.prepare("UPDATE widget_instances SET lifecycle = 'needs_auth' WHERE instance_id = ?").run(waiting.instanceId);
    deps.db.prepare("UPDATE widget_instances SET lifecycle = 'offline' WHERE instance_id = ?").run(alreadyOffline.instanceId);

    expect(uninstallPackage(deps, { packageId: PACKAGE, widgetIds: [WIDGET] })).toMatchObject({ instancesOffline: 1 });
    expect(lifecycleOf(deps, waiting.instanceId)).toBe("offline");

    const outcome = restorePackage(deps, { packageId: PACKAGE, widgetIds: [WIDGET], available: always });

    expect(outcome).toMatchObject({ ok: true, instancesRestored: 1 });
    expect(lifecycleOf(deps, waiting.instanceId)).toBe("needs_auth");
    expect(lifecycleOf(deps, alreadyOffline.instanceId)).toBe("offline");
  });

  it("restores the version that was uninstalled, not an older one", () => {
    const deps = makeDeps();
    install(deps, "1.0.0");
    install(deps, "2.0.0");
    uninstallPackage(deps, { packageId: PACKAGE, widgetIds: [WIDGET] });

    expect(restorePackage(deps, { packageId: PACKAGE, widgetIds: [WIDGET], available: always })).toMatchObject({
      ok: true,
      activeVersion: "2.0.0",
    });
  });

  it("refuses when the directory no longer lists the bytes this node installed", () => {
    const deps = makeDeps();
    install(deps, "1.0.0");
    uninstallPackage(deps, { packageId: PACKAGE, widgetIds: [WIDGET] });

    const outcome = restorePackage(deps, { packageId: PACKAGE, widgetIds: [WIDGET], available: () => false });

    expect(outcome).toMatchObject({ ok: false, code: "VERSION_UNAVAILABLE" });
    expect(activeGeneration(deps, PACKAGE, deps.nodeId)).toBeUndefined();
  });

  it("refuses when the package is installed, and when it never was", () => {
    const deps = makeDeps();
    expect(restorePackage(deps, { packageId: PACKAGE, widgetIds: [], available: always })).toMatchObject({
      ok: false,
      code: "NOTHING_TO_RESTORE",
    });

    install(deps, "1.0.0");
    expect(restorePackage(deps, { packageId: PACKAGE, widgetIds: [], available: always })).toMatchObject({
      ok: false,
      code: "ALREADY_INSTALLED",
    });
  });
});

describe("rolling back to the previous version", () => {
  it("swaps the active generation and can swap it back", () => {
    const deps = makeDeps();
    install(deps, "1.0.0");
    install(deps, "2.0.0");
    expect(previousPackageVersion(deps, PACKAGE)).toBe("1.0.0");
    expect(listInstalledPackages(deps)[0]?.previousVersion).toBe("1.0.0");

    expect(rollbackPackage(deps, { packageId: PACKAGE, available: always })).toMatchObject({
      ok: true,
      activeVersion: "1.0.0",
      previousVersion: "2.0.0",
    });
    expect(activeGeneration(deps, PACKAGE, deps.nodeId)?.version).toBe("1.0.0");
    expect(previousPackageVersion(deps, PACKAGE)).toBe("2.0.0");

    expect(rollbackPackage(deps, { packageId: PACKAGE, available: always })).toMatchObject({ ok: true, activeVersion: "2.0.0" });
  });

  it("keeps state written by the newer version where it is", () => {
    const deps = makeDeps();
    install(deps, "1.0.0");
    install(deps, "2.0.0");
    const { instanceId } = createInstance(deps, { definition: DEF, packageDigest: "sha256:2.0.0", ownerPrincipalId: OWNER as never, props: {} });
    initialiseState(deps, { instanceId, body: { items: ["v2 shape"] }, stateVersion: 2 });

    rollbackPackage(deps, { packageId: PACKAGE, available: always });

    expect(readInstanceState(deps, instanceId)).toMatchObject({ stateVersion: 2, body: { items: ["v2 shape"] } });
  });

  it("refuses when no other version was ever active, or its bytes are gone", () => {
    const deps = makeDeps();
    expect(rollbackPackage(deps, { packageId: PACKAGE, available: always })).toMatchObject({ ok: false, code: "NOT_INSTALLED" });

    install(deps, "1.0.0");
    expect(previousPackageVersion(deps, PACKAGE)).toBeUndefined();
    expect(rollbackPackage(deps, { packageId: PACKAGE, available: always })).toMatchObject({
      ok: false,
      code: "NO_PREVIOUS_VERSION",
    });

    install(deps, "2.0.0");
    expect(rollbackPackage(deps, { packageId: PACKAGE, available: () => false })).toMatchObject({
      ok: false,
      code: "VERSION_UNAVAILABLE",
    });
    expect(activeGeneration(deps, PACKAGE, deps.nodeId)?.version).toBe("2.0.0");
  });
});
