import { instantSchema, type DirectoryEntry, type WidgetDefinition } from "@clarkcant/contracts";
import { MIGRATIONS, migrate, openDatabase } from "@clarkcant/storage";
import { beforeEach, describe, expect, it } from "vitest";

import { installFromSource, type InstallFromSourceInput } from "../src/install-from-source.ts";
import { activeGeneration, getPlan } from "../src/install-lifecycle.ts";
import { listInstalledPackages } from "../src/installed-packages.ts";
import { listRestorablePackages, restorePackage, uninstallPackage } from "../src/package-lifecycle.ts";
import { createInstance } from "../src/widget-service.ts";
import { readInstanceState } from "../src/widget-lifecycle.ts";
import { applyWidgetStatePatch } from "../src/widget-state.ts";

/**
 * Installing from a source.
 *
 * The claim is that a marketplace is a source resolver and nothing more: everything after resolution is the install
 * supervisor that already existed. So the tests are about the supervisor's guarantees holding through this entry
 * point — no plan without consent, no `active` without a healthcheck, a digest that has to match, and a rollback
 * that is reported as refused rather than claimed when it comes too late.
 */

const AT = instantSchema.parse("2026-09-20T02:00:00.000Z");
const EXPIRES = instantSchema.parse("2026-09-20T03:00:00.000Z");
const DIGEST = "sha256:published-digest";

const ENTRY: DirectoryEntry = {
  packageId: "com.example.calendar",
  version: "1.2.0",
  displayName: "Calendar Plus",
  description: "A compact agenda and week view.",
  source: { kind: "local", path: "/tmp/pkg" },
  publisher: { id: "example", sourceUrl: "https://github.com/example/calendar-plus", license: "MIT" },
  preview: {},
  facets: ["ui"],
  isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
  platforms: ["linux-x64"],
  hostApi: { min: 1, max: 2 },
  permissionsSummary: [],
  riskTier: "isolated-ui",
  sizeBytes: 40_960,
  digest: DIGEST,
};

/**
 * `input()` below resolves an npm source (`com.example.calendar@1.2.0`) against `[ENTRY]`. `resolvePackageSource`
 * now matches an npm source by the directory entry's actual `source.name`, not by `packageId` (the "findEntry"
 * fix) — so the directory entry these npm-resolving fixtures search against has to really be an npm source, not
 * `ENTRY`'s `local` one, which shares a `packageId` string but is a different kind of source entirely.
 */
const NPM_ENTRY: DirectoryEntry = { ...ENTRY, source: { kind: "npm", name: "com.example.calendar", version: "1.2.0" } };

let counter = 0;

function makeDeps() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  return {
    db,
    nodeId: "node_a",
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  };
}

let deps: ReturnType<typeof makeDeps>;

beforeEach(() => {
  deps = makeDeps();
});

function input(overrides: Partial<InstallFromSourceInput> = {}): InstallFromSourceInput {
  return {
    source: { kind: "npm", name: "com.example.calendar", version: "1.2.0" },
    directory: [NPM_ENTRY],
    hostApi: 1,
    platform: "linux-x64",
    ownerPrincipalId: "prin_owner",
    requirementKey: "cap:project.code.change@1",
    requestedCapabilityRefs: ["project.code.change@1"],
    grantedCapabilities: ["project.code.change@1"],
    isolationPlan: [{ facetKind: "ui", isolation: "isolated-ui" }],
    codeGeneration: "codegen_1",
    healthcheck: () => true,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

describe("what the install refuses before it plans anything", () => {
  it("refuses a branch, and leaves no plan behind", () => {
    const outcome = installFromSource(
      deps,
      input({ source: { kind: "git", url: "com.example.calendar", ref: "main" } }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("GIT_REF_NOT_EXACT");
    // Nothing planned: a refusal that still wrote a plan would leave a prompt for something nobody may install.
    const plans = deps.db.prepare("SELECT COUNT(*) AS n FROM install_plans").get() as { n: number };
    expect(plans.n).toBe(0);
  });

  it("refuses a directory entry whose digest is missing", () => {
    const outcome = installFromSource(deps, input({ directory: [{ ...NPM_ENTRY, digest: " " }] }));

    // "No digest" must never behave like "digest matched".
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("DIGEST_MISMATCH");
  });

  it("refuses a package built for another host API, before download", () => {
    const outcome = installFromSource(deps, input({ directory: [{ ...NPM_ENTRY, hostApi: { min: 9, max: 10 } }] }));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("HOST_API_MISMATCH");
  });
});

describe("a successful install", () => {
  it("reaches active with a generation, and records consent by digest", () => {
    const outcome = installFromSource(deps, input());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe("active");
    expect(outcome.generationId).toContain("com.example.calendar@1.2.0");
    expect(outcome.joinedExisting).toBe(false);

    // Consent is bound to the plan digest, so what the user approved is what was installed.
    const record = getPlan(deps, outcome.planId);
    expect(record?.consentedDigest).toBe(record?.plan.planDigest);
    expect(record?.plan.candidate.digest).toBe(DIGEST);
  });

  it("leaves the plan active and the generation current", () => {
    const outcome = installFromSource(deps, input());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const generation = activeGeneration(deps, "com.example.calendar", "node_a");
    expect(generation?.generationId).toBe(outcome.generationId);
  });

  it("joins an existing plan rather than installing the same thing twice", () => {
    const first = installFromSource(deps, input());
    expect(first.ok).toBe(true);

    /*
     * The unique index on (requirement, node) is what makes this safe under concurrency, and it is the reason two
     * tasks needing the same pack produce one prompt rather than two racing installs.
     */
    const second = installFromSource(deps, input());
    expect(second.ok).toBe(true);
    if (second.ok && first.ok) {
      expect(second.planId).toBe(first.planId);
      expect(second.joinedExisting).toBe(true);
    }
  });
});

describe("installing again after the package stopped running", () => {
  it("installs a fresh generation after an uninstall, rather than joining the plan whose generation was retired", () => {
    const first = installFromSource(deps, input());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(uninstallPackage(deps, { packageId: "com.example.calendar", widgetIds: [] })).toMatchObject({ ok: true });

    const again = installFromSource(deps, input({ codeGeneration: "codegen_2" }));

    expect(again).toMatchObject({ ok: true, state: "active", joinedExisting: false });
    if (!again.ok) return;
    expect(again.planId).not.toBe(first.planId);
    expect(activeGeneration(deps, "com.example.calendar", "node_a")?.generationId).toBe(again.generationId);
    expect(listInstalledPackages(deps).map((entry) => entry.packageId)).toEqual(["com.example.calendar"]);
    // The first plan stays as the record of what was installed then, and no longer stands for what is running.
    expect(getPlan(deps, first.planId)?.state).toBe("retired");
    expect(getPlan(deps, again.planId)?.state).toBe("active");
  });

  it("installs a version again after another version replaced it", () => {
    const v1 = installFromSource(deps, input());
    expect(v1.ok).toBe(true);
    const v2Entry: DirectoryEntry = { ...NPM_ENTRY, version: "1.3.0", source: { kind: "npm", name: "com.example.calendar", version: "1.3.0" } };
    const v2 = installFromSource(
      deps,
      input({ source: v2Entry.source, directory: [v2Entry], requirementKey: "cap:project.code.change@1.3", codeGeneration: "codegen_2" }),
    );
    expect(v2).toMatchObject({ ok: true, joinedExisting: false });

    const back = installFromSource(deps, input({ codeGeneration: "codegen_3" }));

    expect(back).toMatchObject({ ok: true, joinedExisting: false });
    expect(activeGeneration(deps, "com.example.calendar", "node_a")?.version).toBe("1.2.0");
  });

  it("installs fresh on a database upgraded from schema 41 that still holds the active plan of an uninstalled package", () => {
    // What a node holds that installed and uninstalled a package before the retired state existed.
    const base = makeDeps();
    base.db.close();
    const legacy = { ...base, db: openDatabase({ path: ":memory:" }) };
    migrate(legacy.db, MIGRATIONS.slice(0, 41));
    const first = installFromSource(legacy, input());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(uninstallPackage(legacy, { packageId: "com.example.calendar", widgetIds: [] })).toMatchObject({ ok: true });
    expect(getPlan(legacy, first.planId)?.state).toBe("active");

    expect(migrate(legacy.db).applied).toEqual([42]);
    const again = installFromSource(legacy, input({ codeGeneration: "codegen_2" }));

    expect(again).toMatchObject({ ok: true, state: "active", joinedExisting: false });
    if (!again.ok) return;
    expect(again.planId).not.toBe(first.planId);
    expect(getPlan(legacy, first.planId)?.state).toBe("retired");
    expect(activeGeneration(legacy, "com.example.calendar", "node_a")?.generationId).toBe(again.generationId);
    legacy.db.close();
  });
  it("still joins the plan while the generation it activated is the one running", () => {
    const first = installFromSource(deps, input());
    expect(uninstallPackage(deps, { packageId: "com.example.calendar", widgetIds: [] })).toMatchObject({ ok: true });
    const again = installFromSource(deps, input({ codeGeneration: "codegen_2" }));
    const third = installFromSource(deps, input({ codeGeneration: "codegen_3" }));

    expect(first.ok && again.ok && third.ok).toBe(true);
    if (!again.ok || !third.ok) return;
    expect(third).toMatchObject({ joinedExisting: true, planId: again.planId });
    expect(activeGeneration(deps, "com.example.calendar", "node_a")?.generationId).toBe(again.generationId);
  });
});

describe("installing again brings back the widgets the uninstall took offline", () => {
  const WIDGET = "com.example.calendar.agenda@1";
  const DEF: WidgetDefinition = {
    id: WIDGET,
    version: "1.2.0",
    renderer: "isolated-app",
    propsSchema: { type: "object", additionalProperties: true },
    eventSchemas: {},
    stateSchema: { type: "object" },
    stateVersion: 1,
    sizing: { compact: true, expanded: true },
    textFallback: "An agenda.",
    effectCategories: [],
    datasetRefs: [],
    semanticDescription: "An agenda",
    requestedCapabilities: [],
  };
  const lifecycleOf = (instanceId: string): string =>
    (deps.db.prepare("SELECT lifecycle FROM widget_instances WHERE instance_id = ?").get(instanceId) as { lifecycle: string }).lifecycle;
  const write = (instanceId: string, expectedRevision: number, patch: Record<string, unknown>) =>
    applyWidgetStatePatch(deps, { instanceId, principalId: "prin_owner", definition: DEF, expectedRevision, patch });

  /** Installs, writes the widget's state, then uninstalls: the instance is offline and refuses writes. */
  function uninstalledWithState(): string {
    expect(installFromSource(deps, input({ widgetIds: [WIDGET] }))).toMatchObject({ ok: true });
    const { instanceId } = createInstance(deps, { definition: DEF, packageDigest: DIGEST, ownerPrincipalId: "prin_owner" as never, props: {} });
    expect(write(instanceId, 0, { items: ["dentist"] })).toMatchObject({ ok: true, stateRevision: 1 });
    expect(uninstallPackage(deps, { packageId: "com.example.calendar", widgetIds: [WIDGET] })).toMatchObject({ instancesOffline: 1 });
    expect(write(instanceId, 1, { items: [] })).toMatchObject({ ok: false, code: "INSTANCE_OFFLINE" });
    return instanceId;
  }

  it("brings the instance back writable with the state from before the uninstall, and settles what Restore offered", () => {
    const instanceId = uninstalledWithState();
    const before = lifecycleOf(instanceId);
    expect(before).toBe("offline");
    expect(listRestorablePackages(deps)).toHaveLength(1);

    expect(installFromSource(deps, input({ widgetIds: [WIDGET], codeGeneration: "codegen_2" }))).toMatchObject({ ok: true, joinedExisting: false });

    expect(lifecycleOf(instanceId)).not.toBe("offline");
    expect(readInstanceState(deps, instanceId)?.body).toEqual({ items: ["dentist"] });
    expect(write(instanceId, 1, { items: ["dentist", "gym"] })).toMatchObject({ ok: true, stateRevision: 2 });
    // The uninstall's record is settled: nothing is left for Restore, which refuses because the package is installed.
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM package_uninstall_lifecycles").get()).toEqual({ n: 0 });
    expect(listRestorablePackages(deps)).toEqual([]);
    expect(restorePackage(deps, { packageId: "com.example.calendar", widgetIds: [WIDGET], available: () => true })).toMatchObject({
      ok: false,
      code: "ALREADY_INSTALLED",
    });
  });

  it("does the same when the version installed after the uninstall is a different one", () => {
    const instanceId = uninstalledWithState();
    const next: DirectoryEntry = { ...NPM_ENTRY, version: "1.3.0", source: { kind: "npm", name: "com.example.calendar", version: "1.3.0" } };

    // The newer version is installed without naming the widget ids: the ones generation 1.2.0 recorded still answer.
    const outcome = installFromSource(deps, input({ source: next.source, directory: [next], codeGeneration: "codegen_2" }));

    expect(outcome).toMatchObject({ ok: true });
    expect(activeGeneration(deps, "com.example.calendar", "node_a")?.version).toBe("1.3.0");
    expect(lifecycleOf(instanceId)).not.toBe("offline");
    expect(write(instanceId, 1, { items: ["dentist", "gym"] })).toMatchObject({ ok: true });
  });

  it("leaves alone an instance that was offline for another reason", () => {
    expect(installFromSource(deps, input({ widgetIds: [WIDGET] }))).toMatchObject({ ok: true });
    const { instanceId } = createInstance(deps, { definition: DEF, packageDigest: DIGEST, ownerPrincipalId: "prin_owner" as never, props: {} });
    deps.db.prepare("UPDATE widget_instances SET lifecycle = 'offline' WHERE instance_id = ?").run(instanceId);
    uninstallPackage(deps, { packageId: "com.example.calendar", widgetIds: [WIDGET] });

    installFromSource(deps, input({ widgetIds: [WIDGET], codeGeneration: "codegen_2" }));

    expect(lifecycleOf(instanceId)).toBe("offline");
  });
});
describe("a failed healthcheck", () => {
  it("reports what actually happened, and never claims a rollback it did not perform", () => {
    // A first install, so there is no previous generation to go back to.
    const first = installFromSource(deps, input());
    expect(first.ok).toBe(true);

    const second = installFromSource(
      deps,
      input({
        requirementKey: "cap:project.code.change@2",
        codeGeneration: "codegen_2",
        healthcheck: () => false,
      }),
    );

    expect(second.ok).toBe(false);
    if (second.ok) return;
    /*
     * Either outcome is honest, and the point is that the function says which. A failure this late may already have
     * replaced the active generation, in which case an automatic rollback is refused and a person is asked to look —
     * reporting "rolled back" there would be the worst answer available.
     */
    expect(["HEALTHCHECK_FAILED", "ROLLBACK_REFUSED"]).toContain(second.code);
    expect(second.message.length).toBeGreaterThan(0);
    if (second.code === "ROLLBACK_REFUSED") expect(second.rolledBack).toBe(false);
  });

  it("does not leave the new generation active when it rolled back", () => {
    const first = installFromSource(deps, input());
    expect(first.ok).toBe(true);

    const second = installFromSource(
      deps,
      input({
        requirementKey: "cap:project.code.change@3",
        codeGeneration: "codegen_3",
        healthcheck: () => false,
      }),
    );

    const current = activeGeneration(deps, "com.example.calendar", "node_a");
    if (!second.ok && second.rolledBack === true) {
      // Rolled back, so the previous generation is the current one again.
      expect(current?.generationId).not.toContain("codegen_3");
    } else {
      // Not rolled back, so the caller was told a person has to look — and the assertion here is only that the
      // function did not claim otherwise.
      expect(second.ok).toBe(false);
    }
  });
});

describe("the plan a source produces", () => {
  it("carries the rationale and the tier, so consent names where it came from", () => {
    const outcome = installFromSource(deps, input());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const record = getPlan(deps, outcome.planId);
    expect(record?.plan.candidate.rationale).toContain("npm com.example.calendar@1.2.0");
    expect(record?.plan.candidate.sourceTier).toBe("curated-registry");
    expect(record?.plan.isolationPlan).toEqual([{ facetKind: "ui", isolation: "isolated-ui" }]);
  });

  it("records the isolation the supervisor will apply, not the publisher's claim", () => {
    const outcome = installFromSource(
      deps,
      input({ isolationPlan: [{ facetKind: "tools", isolation: "trusted-native" }] }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // A native facet is what decides whether this install needs a restart, and it is the supervisor's plan that
    // says so rather than the manifest.
    const record = getPlan(deps, outcome.planId);
    expect(record?.plan.isolationPlan[0]?.isolation).toBe("trusted-native");
  });
});

describe("a local package", () => {
  it("plans against the digest the caller computed, and refuses without one", () => {
    const without = installFromSource(deps, input({ source: { kind: "local", path: "/tmp/widget" } }));
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.code).toBe("LOCAL_DIGEST_REQUIRED");

    const withDigest = installFromSource(
      deps,
      input({ source: { kind: "local", path: "/tmp/widget" }, localDigest: "sha256:local", requirementKey: "cap:local" }),
    );

    /*
     * A local path is first-class: a directory account is not a precondition for running your own widget, and the
     * plan still names the exact bytes because the digest is the identity.
     */
    expect(withDigest.ok).toBe(true);
    if (withDigest.ok) {
      expect(getPlan(deps, withDigest.planId)?.plan.candidate.digest).toBe("sha256:local");
    }
  });
});


describe("what the node reports as installed", () => {
  it("lists the active generation with its source, digest and lane", () => {
    const installed = installFromSource(deps, input());
    expect(installed.ok).toBe(true);

    const packages = listInstalledPackages(deps);

    expect(packages).toHaveLength(1);
    const entry = packages[0];
    /*
     * The four facts the marketplace's UI exists to show. Three of them a user cannot check for themselves, and the
     * digest is the one that ties what is running to what was approved.
     */
    expect(entry?.packageId).toBe("com.example.calendar");
    expect(entry?.version).toBe("1.2.0");
    expect(entry?.digest).toBe(DIGEST);
    expect(entry?.source.rationale).toContain("npm com.example.calendar@1.2.0");
    expect(entry?.lane).toBe("isolated-ui");
  });

  it("takes the lane from the plan's isolation rather than the package's own description", () => {
    const installed = installFromSource(deps, input({ isolationPlan: [{ facetKind: "tools", isolation: "trusted-native" }] }));
    expect(installed.ok).toBe(true);

    // A package is as trusted as its least isolated part; a listing that took the publisher's word for it would make
    // the label decorative.
    expect(listInstalledPackages(deps)[0]?.lane).toBe("trusted-native");
  });

  it("reports a local package under the name the directory gives it, not its path", () => {
    /*
     * One package used to have two names: the listing called it `com.example.calendar` while the installed row
     * called it `/tmp/pkg`, and the same person was shown both. This asserts they are one name now, from the row the
     * library and the marketplace both read.
     */
    const installed = installFromSource(
      deps,
      input({
        source: { kind: "local", path: "/tmp/pkg" },
        // `ENTRY` (not the default `NPM_ENTRY`) is the one directory entry whose own `source` is really `local`
        // at this path, which is what a local resolution matches against.
        directory: [ENTRY],
        localDigest: "sha256:local-bytes",
        requirementKey: "cap:local",
      }),
    );
    expect(installed.ok).toBe(true);

    const entry = listInstalledPackages(deps)[0];
    expect(entry?.packageId).toBe("com.example.calendar");
    expect(entry?.version).toBe("1.2.0");
    // The digest stays the caller's hash of the bytes on disk rather than the listed one, which describes a
    // different set of bytes: the row has to tie what is running to what was hashed.
    expect(entry?.digest).toBe("sha256:local-bytes");
  });

  it("reports nothing when nothing is installed, rather than a placeholder", () => {
    expect(listInstalledPackages(deps)).toEqual([]);
  });

  it("says nothing was frozen when the install carried no lock, rather than an empty closure", () => {
    const installed = installFromSource(deps, input());
    expect(installed.ok).toBe(true);

    // An empty closure and no closure are different statements: one would read as "this package has no
    // dependencies", and nothing here resolved any.
    expect(listInstalledPackages(deps)[0]?.lock).toBeUndefined();
  });
});

describe("the frozen build input the plan carries", () => {
  const LOCK = {
    lockRef: "com-example-calendar@1-2-0.artifact-and-dependencies.sha256-aaaa.lock.json",
    lockDigest: "sha256:lock-one",
    coverage: "artifact-and-dependencies" as const,
    dependencies: [
      { name: "com.example.calendar", version: "1.2.0", integrity: DIGEST, resolvedFrom: "npm:com.example.calendar@1.2.0" },
      { name: "left-pad", version: "1.2.5", integrity: "sha512-leftpad1", resolvedFrom: "npm:left-pad@1.2.5" },
    ],
  };

  it("binds the reference, the digest and the pins into the plan and the generation", () => {
    const outcome = installFromSource(deps, input({ dependencyLock: LOCK }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const record = getPlan(deps, outcome.planId);
    expect(record?.plan.lockRef).toBe(LOCK.lockRef);
    expect(record?.plan.lockDigest).toBe(LOCK.lockDigest);
    expect(record?.plan.lockCoverage).toBe("artifact-and-dependencies");
    expect(record?.plan.resolvedDependencies.map((pin) => `${pin.id}@${pin.version}`)).toEqual([
      "com.example.calendar@1.2.0",
      "left-pad@1.2.5",
    ]);
    expect(record?.plan.resolvedDependencies[1]?.resolvedFrom).toBe("npm:left-pad@1.2.5");

    // The generation carries it too: what is running has to be able to answer what it was built from, without a
    // superseded plan being able to change the answer.
    const generation = activeGeneration(deps, "com.example.calendar", "node_a");
    expect(generation?.lockRef).toBe(LOCK.lockRef);
    expect(generation?.lockDigest).toBe(LOCK.lockDigest);
    expect(generation?.lockCoverage).toBe("artifact-and-dependencies");

    expect(listInstalledPackages(deps)[0]?.lock).toEqual({
      ref: LOCK.lockRef,
      digest: LOCK.lockDigest,
      coverage: "artifact-and-dependencies",
    });
  });

  it("refuses to join an existing plan whose closure is not the one resolved now, naming the dependency", () => {
    const first = installFromSource(deps, input({ dependencyLock: LOCK }));
    expect(first.ok).toBe(true);

    const moved = {
      ...LOCK,
      lockRef: "com-example-calendar@1-2-0.artifact-and-dependencies.sha256-bbbb.lock.json",
      lockDigest: "sha256:lock-two",
      dependencies: LOCK.dependencies.map((pin) =>
        pin.name === "left-pad" ? { ...pin, version: "1.3.0", integrity: "sha512-leftpad2", resolvedFrom: "npm:left-pad@1.3.0" } : pin,
      ),
    };
    const second = installFromSource(deps, input({ dependencyLock: moved }));

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("LOCK_DRIFT");
    // The dependency that moved is named, with both versions: the point of the refusal is that somebody can act on it.
    expect(second.message).toContain("left-pad");
    expect(second.message).toContain("1.2.5");
    expect(second.message).toContain("1.3.0");
    // And it says which refusal this is: drift in a closure that was recorded, not a plan that predates the lock.
    expect(second.message).toContain("different frozen build input");
    expect(second.message).not.toContain("predates the frozen build input");
    // And the plan on the node is still the one that was consented to, not the second resolution.
    expect(listInstalledPackages(deps)).toHaveLength(1);
  });

  it("names a legacy plan rather than reporting a closure that never moved", () => {
    /*
     * What the pre-release installer wrote, and what a node keeps after upgrading: a plan with no reference, no
     * coverage and no pins, in state `active` because the install it recorded already finished. A repeat install of
     * the same package@version now resolves a lock and joins that plan.
     */
    const legacy = installFromSource(deps, input());
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;

    const again = installFromSource(deps, input({ dependencyLock: LOCK }));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe("LOCK_DRIFT");
    // The refusal names the cause: a plan recorded before this node froze a dependency closure, with nothing on its
    // side to compare against. Nothing here says a lock moved from "nothing" to a coverage.
    expect(again.message).toContain("predates the frozen build input");
    expect(again.message).not.toContain("the lock covered nothing");
    expect(again.message).not.toContain("different frozen build input");
    // It names which plan, so the sentence is about an install this node can find, and says what to do about it.
    expect(again.message).toContain(legacy.planId);
    expect(again.message).toContain("active");
    expect(again.message).toContain("wait for it");
  });

  it("joins again when the closure is the same, so two tasks still share one plan", () => {
    const first = installFromSource(deps, input({ dependencyLock: LOCK }));
    const second = installFromSource(deps, input({ dependencyLock: { ...LOCK, dependencies: [...LOCK.dependencies].reverse() } }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.joinedExisting).toBe(true);
    expect(second.planId).toBe(first.planId);
  });
});
