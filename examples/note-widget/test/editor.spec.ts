import { beforeEach, describe, expect, it } from "vitest";

import type { WidgetDefinition } from "@clarkcant/contracts";
import { createInstance, initialiseState, type WidgetDeps } from "@clarkcant/core";
import { migrate, openDatabase } from "@clarkcant/storage";
import { NOTE_DEFINITION, PERMISSIONS } from "../src/index.ts";
import { abandonNote, approveNote, openNote, previewNote, typeNote } from "../src/editor.ts";

/**
 * Note widget: build, preview, approve, persist (T46).
 *
 * The happy path is three lines. The interesting cases are the refusals, because a note editor
 * that loses text is a note editor nobody uses.
 */

const AT = "2026-09-16T06:00:00.000Z" as never;
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

function makeNote(deps: WidgetDeps, body = "") {
  const definition: WidgetDefinition = NOTE_DEFINITION;
  const instance = createInstance(deps, {
    definition,
    packageDigest: "digest_note_v1",
    ownerPrincipalId: "prin_owner" as never,
    props: { title: "Shopping" },
  });
  initialiseState(deps, { instanceId: instance.instanceId, body: { body } });
  return instance;
}

let deps: ReturnType<typeof makeDeps>;
beforeEach(() => {
  deps = makeDeps();
});

describe("the note keeps no permissions it does not need", () => {
  it("declares no network origin, no microphone, no camera and no filesystem path", () => {
    expect(PERMISSIONS.networkOrigins).toEqual([]);
    expect(PERMISSIONS.microphone).toBe(false);
    expect(PERMISSIONS.camera).toBe(false);
    expect(PERMISSIONS.filesystem).toEqual([]);
  });

  it("requests only state read and write", () => {
    expect(NOTE_DEFINITION.requestedCapabilities).toEqual([
      "widget.state.read@1",
      "widget.state.write@1",
    ]);
  });
});

describe("build, preview, approve, persist", () => {
  it("previews unsaved text without committing it", () => {
    const instance = makeNote(deps, "milk");
    const session = openNote(deps, { instanceId: instance.instanceId, editorToken: "surface_a" });

    expect(typeNote(deps, session, "milk and bread").ok).toBe(true);

    const preview = previewNote(deps, session);
    expect(preview.text).toBe("milk and bread");
    // The committed text is still the old one, so the preview distinguishes the two.
    expect(preview.committedText).toBe("milk");
    expect(preview.unsaved).toBe(true);
  });

  it("persists on approve and clears the unsaved flag", () => {
    const instance = makeNote(deps, "milk");
    const session = openNote(deps, { instanceId: instance.instanceId, editorToken: "surface_a" });
    typeNote(deps, session, "milk and bread");

    expect(approveNote(deps, session)).toEqual({ ok: true, revision: 2 });

    const preview = previewNote(deps, session);
    expect(preview.committedText).toBe("milk and bread");
    expect(preview.unsaved).toBe(false);
  });

  it("starts from the revision it read rather than assuming one", () => {
    const instance = makeNote(deps);
    const before = openNote(deps, { instanceId: instance.instanceId, editorToken: "surface_a" });
    typeNote(deps, before, "first");
    approveNote(deps, before);

    const after = openNote(deps, { instanceId: instance.instanceId, editorToken: "surface_b" });
    expect(after.revision).toBe(2);
  });

  it("refuses to open a note whose state does not exist, instead of inventing one", () => {
    expect(() => openNote(deps, { instanceId: "winst_missing", editorToken: "surface_a" })).toThrow(
      /no state/,
    );
  });
});

/** Narrow a refusal to the conflict case, so its fields can be read. */
function conflictOf(outcome: ReturnType<typeof typeNote>) {
  if (outcome.ok || outcome.reason !== "conflict") {
    throw new Error(`expected a conflict, received ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe("a conflict keeps the user's text and shows them the newer one", () => {
  it("reports both texts so the user can choose", () => {
    const instance = makeNote(deps, "milk");
    const mine = openNote(deps, { instanceId: instance.instanceId, editorToken: "surface_a" });
    const theirs = openNote(deps, { instanceId: instance.instanceId, editorToken: "surface_b" });

    typeNote(deps, mine, "milk, eggs");
    approveNote(deps, mine);

    // The other surface still holds revision 1 and now types.
    const refused = typeNote(deps, theirs, "milk, bread");

    const conflict = conflictOf(refused);
    expect(conflict.currentText).toBe("milk, eggs");
    expect(conflict.draftKept).toBe(true);
    // And nothing was published, so the newer text survives.
    expect(previewNote(deps, mine).committedText).toBe("milk, eggs");
  });

  it("shows the committed text when another surface holds the draft", () => {
    const instance = makeNote(deps, "milk");
    const mine = openNote(deps, { instanceId: instance.instanceId, editorToken: "surface_a" });
    const theirs = openNote(deps, { instanceId: instance.instanceId, editorToken: "surface_b" });

    typeNote(deps, mine, "in progress by A");
    const preview = previewNote(deps, theirs);

    // Presenting another surface's in-progress text as the user's own edits would misstate
    // whose work is on screen.
    expect(preview.text).toBe("milk");
    expect(preview.heldByAnotherSurface).toBe("surface_a");
  });
});

describe("abandoning is separate from approving", () => {
  it("drops the draft only for the surface that made it", () => {
    const instance = makeNote(deps, "milk");
    const mine = openNote(deps, { instanceId: instance.instanceId, editorToken: "surface_a" });
    typeNote(deps, mine, "discard me");

    expect(abandonNote(deps, mine)).toEqual({ discarded: true });
    expect(previewNote(deps, mine).unsaved).toBe(false);
    expect(previewNote(deps, mine).committedText).toBe("milk");
  });
});
