import { beforeEach, describe, expect, it } from "vitest";

import type { WidgetDefinition } from "@clarkcant/contracts";
import { migrate, openDatabase, toJson } from "@clarkcant/storage";
import { createInstance, type WidgetDeps } from "../src/widget-service.ts";
import {
  commitDraft,
  disablePackage,
  discardDraft,
  initialiseState,
  migrateInstanceStateReported,
  readInstanceState,
  readSnapshotForDisplay,
  restorePinnedInstance,
  saveDraft,
  type StateMigration,
} from "../src/widget-lifecycle.ts";

/**
 * Widget lifecycle tests (T46, T48, T50, T51).
 *
 * Each test names the outcome it is protecting. The two that matter most are the refusals: a
 * stale autosave must lose without taking the draft with it, and a failed state migration must
 * leave the old state readable rather than half-converted.
 */

const AT = "2026-09-16T06:00:00.000Z" as never;

const DEF: WidgetDefinition = {
  id: "example.notes.editor",
  version: "1.0.0",
  renderer: "isolated-app",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: { type: "object" },
  stateVersion: 1,
  sizing: { compact: true, expanded: true },
  textFallback: "A saved note.",
  effectCategories: ["read", "local-write"],
  datasetRefs: [],
  semanticDescription: "A personal note",
  requestedCapabilities: ["widget.state.read@1", "widget.state.write@1"],
};

/**
 * Narrow a refused save to the refusal under test.
 *
 * The outcome is a discriminated union, so reading a variant's field without checking the code
 * would be reading a field that may not exist.
 */
function conflictOf(outcome: ReturnType<typeof saveDraft>) {
  if (outcome.ok || outcome.code !== "CONFLICT") {
    throw new Error(`expected a conflict, received ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function heldOf(outcome: ReturnType<typeof saveDraft>) {
  if (outcome.ok || outcome.code !== "DRAFT_HELD") {
    throw new Error(`expected a held draft, received ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

let counter = 0;

function makeDeps() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  db.prepare(
    "INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)",
  ).run("conv_1", "node_a", AT, AT);
  return {
    db,
    nodeId: "node_a",
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  };
}

/** A widget instance with an initialised state row, which is what editing starts from. */
function makeInstance(deps: WidgetDeps, body: Record<string, unknown> = { body: "first draft" }) {
  const instance = createInstance(deps, {
    definition: DEF,
    packageDigest: "digest_pack_v1",
    ownerPrincipalId: "prin_owner" as never,
    props: { title: "Notes" },
  });
  initialiseState(deps, { instanceId: instance.instanceId, body });
  return instance;
}

function addPin(deps: WidgetDeps, instanceId: string): string {
  const pinId = `pin_${String(++counter).padStart(6, "0")}`;
  deps.db
    .prepare(
      "INSERT INTO pins (pin_id, conversation_id, instance_id, display_mode, position, refresh_policy, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(pinId, "conv_1", instanceId, "expanded", 0, "on-open", AT);
  return pinId;
}

function addSnapshot(deps: WidgetDeps, instanceId: string, text: string): string {
  const snapshotId = `snap_${String(++counter).padStart(6, "0")}`;
  deps.db
    .prepare(
      "INSERT INTO widget_snapshots (snapshot_id, instance_id, message_id, captured_revision, captured_at, stale, document) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      snapshotId,
      instanceId,
      "msg_1",
      1,
      AT,
      0,
      toJson({
        snapshotId,
        instanceId,
        messageId: "msg_1",
        capturedRevision: 1,
        capturedAt: AT,
        textAlternative: text,
        presentationRef: "note:1",
        stale: false,
      }),
    );
  return snapshotId;
}

let deps: ReturnType<typeof makeDeps>;
beforeEach(() => {
  deps = makeDeps();
});

const SURFACE_A = "surface_a";
const SURFACE_B = "surface_b";

function save(
  instanceId: string,
  body: Record<string, unknown>,
  expectedRevision: number,
  editorToken = SURFACE_A,
) {
  return saveDraft(deps, { instanceId, body, expectedRevision, editorToken });
}

function commit(instanceId: string, expectedRevision: number, editorToken = SURFACE_A) {
  return commitDraft(deps, { instanceId, expectedRevision, editorToken });
}

describe("a stale autosave loses without discarding the draft (T46)", () => {
  it("refuses a save composed against an older revision and keeps the draft", () => {
    const instance = makeInstance(deps);

    expect(save(instance.instanceId, { body: "text the user typed" }, 1).ok).toBe(true);
    expect(commit(instance.instanceId, 1)).toEqual({ ok: true, revision: 2 });

    // Something newer lands while this editor still holds revision 1.
    expect(save(instance.instanceId, { body: "content from another surface" }, 2).ok).toBe(true);
    expect(commit(instance.instanceId, 2)).toEqual({ ok: true, revision: 3 });

    const stale = save(instance.instanceId, { body: "text the user typed" }, 1);

    const conflict = conflictOf(stale);
    // The newer content is untouched, which is the point of refusing.
    expect(conflict.currentBody).toEqual({ body: "content from another surface" });

    const state = readInstanceState(deps, instance.instanceId);
    // And the user's text still exists, so a refusal is recoverable rather than destructive.
    expect(state?.draft).toEqual({ body: "text the user typed" });
    expect(state?.body).toEqual({ body: "content from another surface" });
  });

  it("says explicitly that the draft was preserved", () => {
    const instance = makeInstance(deps);
    save(instance.instanceId, { body: "a" }, 1);
    commit(instance.instanceId, 1);
    expect(conflictOf(save(instance.instanceId, { body: "b" }, 1)).draftPreserved).toBe(true);
  });

  it("lets the holding surface commit its own draft and clears it afterwards", () => {
    const instance = makeInstance(deps);
    save(instance.instanceId, { body: "written by A" }, 1, SURFACE_A);
    expect(commit(instance.instanceId, 1, SURFACE_A)).toEqual({ ok: true, revision: 2 });

    const state = readInstanceState(deps, instance.instanceId);
    expect(state?.body).toEqual({ body: "written by A" });
    expect(state?.draft).toBeUndefined();
    expect(state?.draftEditor).toBeUndefined();
  });

  it("drops the draft only when the holding surface discards it", () => {
    const instance = makeInstance(deps);
    save(instance.instanceId, { body: "mine" }, 1, SURFACE_A);

    expect(
      discardDraft(deps, { instanceId: instance.instanceId, editorToken: SURFACE_B }),
    ).toEqual({ discarded: false, refused: expect.stringContaining(SURFACE_A) });
    expect(
      discardDraft(deps, { instanceId: instance.instanceId, editorToken: SURFACE_A }),
    ).toEqual({ discarded: true });
    expect(readInstanceState(deps, instance.instanceId)?.draft).toBeUndefined();
    // Discarding twice reports that there was nothing left rather than pretending otherwise.
    expect(
      discardDraft(deps, { instanceId: instance.instanceId, editorToken: SURFACE_A }),
    ).toEqual({ discarded: false });
  });

  it("requires state to be initialised before editing, instead of inventing a row", () => {
    const orphan = createInstance(deps, {
      definition: DEF,
      packageDigest: "digest_pack_v1",
      ownerPrincipalId: "prin_owner" as never,
      props: { title: "Uninitialised" },
    });
    expect(() =>
      saveDraft(deps, {
        instanceId: orphan.instanceId,
        body: { body: "x" },
        expectedRevision: 1,
        editorToken: SURFACE_A,
      }),
    ).toThrow(/no state row/);
  });
});

describe("one draft per widget, held by the surface that opened it", () => {
  it("refuses a second surface's save instead of replacing the open draft", () => {
    const instance = makeInstance(deps);
    expect(save(instance.instanceId, { body: "written by A" }, 1, SURFACE_A).ok).toBe(true);

    const refused = heldOf(save(instance.instanceId, { body: "written by B" }, 1, SURFACE_B));

    expect(refused.heldBy).toBe(SURFACE_A);
    // The second editor is shown what the first wrote, so the situation is recoverable.
    expect(refused.heldDraft).toEqual({ body: "written by A" });

    const state = readInstanceState(deps, instance.instanceId);
    expect(state?.draft).toEqual({ body: "written by A" });
    expect(state?.draftEditor).toBe(SURFACE_A);
  });

  it("refuses to commit another surface's draft", () => {
    const instance = makeInstance(deps);
    save(instance.instanceId, { body: "written by A" }, 1, SURFACE_A);

    const refused = heldOf(commit(instance.instanceId, 1, SURFACE_B));

    // The refusal names who holds the draft, so the editor can say something useful.
    expect(refused.message).toContain(SURFACE_A);
    // Nothing was published, so the committed state is still what it was.
    expect(readInstanceState(deps, instance.instanceId)?.body).toEqual({ body: "first draft" });
  });

  it("refuses to commit a draft once the state has moved underneath it", () => {
    const instance = makeInstance(deps);
    save(instance.instanceId, { body: "mine" }, 1);

    // Another writer advances the committed state while this draft is open. The guard is
    // exercised directly because editor ownership normally makes this unreachable, and a guard
    // that is never executed is a guard nobody knows works.
    deps.db
      .prepare("UPDATE widget_state SET state_revision = 2 WHERE instance_id = ?")
      .run(instance.instanceId);

    const refused = conflictOf(commit(instance.instanceId, 1));
    expect(refused.draftPreserved).toBe(true);
  });
});

describe("a failed state migration recovers the old state (T51)", () => {
  const v1to2: StateMigration = { from: 1, to: 2, apply: (body) => ({ ...body, migrated: true }) };
  const v2to3: StateMigration = {
    from: 2,
    to: 3,
    apply: () => {
      throw new Error("the version 3 transform cannot read this document");
    },
  };

  it("leaves the original state and version intact when a step throws", () => {
    const instance = makeInstance(deps, { body: "original", shape: "v1" });

    const outcome = migrateInstanceStateReported(deps, {
      instanceId: instance.instanceId,
      toVersion: 3,
      migrations: [v1to2, v2to3],
    });

    if (outcome.ok) throw new Error("expected the migration to fail");
    expect(outcome.code).toBe("MIGRATION_FAILED");
    expect(outcome.reason).toContain("version 3 transform");

    // Read back from storage rather than trusting the returned copy: the claim is that the
    // half-converted document was never written.
    const state = readInstanceState(deps, instance.instanceId);
    expect(state?.stateVersion).toBe(1);
    expect(state?.body).toEqual({ body: "original", shape: "v1" });
    expect(state?.body).not.toHaveProperty("migrated");
    expect(outcome.ok === false && outcome.recoveredAtVersion).toBe(1);
  });

  it("reports a missing step rather than stopping half-way", () => {
    const instance = makeInstance(deps, { body: "original" });
    const outcome = migrateInstanceStateReported(deps, {
      instanceId: instance.instanceId,
      toVersion: 5,
      // Nothing bridges 2 -> 5, so the run cannot proceed past version 2.
      migrations: [v1to2],
    });
    expect(outcome.ok).toBe(false);
    expect(readInstanceState(deps, instance.instanceId)?.stateVersion).toBe(1);
  });

  it("advances the version only when every step succeeds", () => {
    const instance = makeInstance(deps, { body: "original" });
    const outcome = migrateInstanceStateReported(deps, {
      instanceId: instance.instanceId,
      toVersion: 2,
      migrations: [v1to2],
    });
    expect(outcome).toEqual({ ok: true, fromVersion: 1, toVersion: 2, steps: 1 });

    const state = readInstanceState(deps, instance.instanceId);
    expect(state?.stateVersion).toBe(2);
    expect(state?.body).toEqual({ body: "original", migrated: true });
  });

  it("does nothing when the state is already at the target version", () => {
    const instance = makeInstance(deps, { body: "original" });
    const outcome = migrateInstanceStateReported(deps, {
      instanceId: instance.instanceId,
      toVersion: 1,
      migrations: [],
    });
    expect(outcome).toEqual({ ok: true, fromVersion: 1, toVersion: 1, steps: 0 });
  });
});

describe("restoring a pin does not start playback (T48)", () => {
  it("returns the position and reports that nothing is playing", () => {
    const instance = makeInstance(deps, { positionSeconds: 431.5 });
    const pinId = addPin(deps, instance.instanceId);

    const restored = restorePinnedInstance(deps, pinId);

    expect(restored.instanceId).toBe(instance.instanceId);
    // The position survives, so a re-opened player resumes rather than restarts.
    expect(restored.positionSeconds).toBe(431.5);
    expect(restored.playing).toBe(false);
    expect(restored.autoplayRefused).toContain("starts when you ask for it");
  });

  it("does not mark the instance as playing, so a second restore is also silent", () => {
    const instance = makeInstance(deps, { positionSeconds: 12 });
    const pinId = addPin(deps, instance.instanceId);
    restorePinnedInstance(deps, pinId);
    const again = restorePinnedInstance(deps, pinId);
    expect(again.playing).toBe(false);
    expect(readInstanceState(deps, instance.instanceId)?.body.positionSeconds).toBe(12);
  });

  it("treats a missing position as the start rather than inventing one", () => {
    const instance = makeInstance(deps, { body: "no media here" });
    const pinId = addPin(deps, instance.instanceId);
    expect(restorePinnedInstance(deps, pinId).positionSeconds).toBe(0);
  });
});

describe("a disabled package leaves its history readable (T50)", () => {
  it("takes the instance offline and keeps the snapshot readable", () => {
    const instance = makeInstance(deps);
    const snapshotId = addSnapshot(deps, instance.instanceId, "The notes widget showed: three records.");

    const outcome = disablePackage(deps, {
      packageDigest: "digest_pack_v1",
      reason: "the package was uninstalled",
    });

    expect(outcome.instancesOffline).toBe(1);
    expect(outcome.snapshotsStillReadable).toBe(1);

    const row = deps.db
      .prepare("SELECT lifecycle FROM widget_instances WHERE instance_id = ?")
      .get(instance.instanceId) as { lifecycle: string };
    expect(row.lifecycle).toBe("offline");

    const display = readSnapshotForDisplay(deps, snapshotId);
    expect(display?.text).toBe("The notes widget showed: three records.");
    // The actions are reported as unavailable rather than silently doing nothing.
    expect(display?.actionsAvailable).toBe(false);
    expect(display?.unavailableBecause).toContain("no longer installed");
  });

  it("leaves instances from other packages alone", () => {
    const instance = makeInstance(deps);
    const other = createInstance(deps, {
      definition: { ...DEF, id: "example.other.widget" },
      packageDigest: "digest_pack_v2",
      ownerPrincipalId: "prin_owner" as never,
      props: { title: "Other" },
    });

    const outcome = disablePackage(deps, { packageDigest: "digest_pack_v1", reason: "uninstalled" });

    expect(outcome.instancesOffline).toBe(1);
    const untouched = deps.db
      .prepare("SELECT lifecycle FROM widget_instances WHERE instance_id = ?")
      .get(other.instanceId) as { lifecycle: string };
    expect(untouched.lifecycle).toBe("ready");
    expect(
      readInstanceState(deps, instance.instanceId)?.body,
      "disabling a package must not erase widget state",
    ).toBeDefined();
  });

  it("returns nothing for a snapshot that does not exist", () => {
    expect(readSnapshotForDisplay(deps, "snap_missing")).toBeUndefined();
  });
});
