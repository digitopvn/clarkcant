import { beforeEach, describe, expect, it } from "vitest";

import { createInstance, initialiseState, type WidgetDeps } from "@clarkcant/core";
import { migrate, openDatabase } from "@clarkcant/storage";
import { CONTRACT_ASSERTIONS, FIXTURE_LABEL, mount, restore, unmount } from "../src/fixture.ts";

/**
 * Media fixture: one live owner, and no autoplay on restore (T47, T48).
 *
 * This is a synthetic fixture. Passing these tests says something about our ownership and restore
 * rules and nothing at all about any vendor player, which is why the label is asserted below.
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

function makePlayer(deps: WidgetDeps, positionSeconds = 0) {
  const instance = createInstance(deps, {
    definition: {
      id: "fixture.media.player",
      version: "1.0.0",
      renderer: "isolated-app",
      propsSchema: { type: "object", additionalProperties: true },
      eventSchemas: {},
      stateSchema: { type: "object" },
      stateVersion: 1,
      sizing: { compact: true, expanded: true },
      textFallback: "A media player.",
      effectCategories: ["read"],
      datasetRefs: [],
      semanticDescription: "A synthetic media player",
      requestedCapabilities: [],
    },
    packageDigest: "digest_media_v1",
    ownerPrincipalId: "prin_owner" as never,
    props: { title: "Fixture clip" },
  });
  initialiseState(deps, { instanceId: instance.instanceId, body: { positionSeconds } });
  return instance;
}

let deps: ReturnType<typeof makeDeps>;
beforeEach(() => {
  deps = makeDeps();
});

describe("the fixture says what it is", () => {
  it("is labelled synthetic, so a pass is never read as a vendor integration", () => {
    expect(FIXTURE_LABEL).toContain("Synthetic");
    expect(FIXTURE_LABEL).toContain("No real playback SDK");
  });

  it("keeps its declared assertions listed", () => {
    expect(CONTRACT_ASSERTIONS).toHaveLength(4);
  });
});

describe("one logical instance has one live owner", () => {
  it("mounts once inline and once pinned, and refuses the second", () => {
    const player = makePlayer(deps);

    const inline = mount(deps, {
      instanceId: player.instanceId,
      surface: "inline",
      ownerToken: "tok_inline",
    });
    expect(inline).toEqual({ mounted: true, surface: "inline", playing: false });

    const pinned = mount(deps, {
      instanceId: player.instanceId,
      surface: "pin",
      ownerToken: "tok_pin",
    });
    expect(pinned.mounted).toBe(false);
    expect(pinned.mounted === false && pinned.reason).toBe("ALREADY_OWNED");
    // The refusal names where playback is, so the UI can move there rather than duplicating it.
    expect(pinned.mounted === false && pinned.heldBy).toBe("inline");
  });

  it("does not start playback on mount", () => {
    const player = makePlayer(deps);
    const mounted = mount(deps, {
      instanceId: player.instanceId,
      surface: "inline",
      ownerToken: "tok_inline",
    });
    // Audio that starts because a panel appeared is the behaviour users complain about.
    expect(mounted.mounted && mounted.playing).toBe(false);
  });

  it("frees the owner on unmount so the other surface can take it", () => {
    const player = makePlayer(deps);
    mount(deps, { instanceId: player.instanceId, surface: "inline", ownerToken: "tok_inline" });
    expect(unmount(deps, { instanceId: player.instanceId, ownerToken: "tok_inline" }).released).toBe(true);

    const pinned = mount(deps, {
      instanceId: player.instanceId,
      surface: "pin",
      ownerToken: "tok_pin",
    });
    expect(pinned.mounted).toBe(true);
  });

  it("does not release the owner for a token that does not hold it", () => {
    const player = makePlayer(deps);
    mount(deps, { instanceId: player.instanceId, surface: "inline", ownerToken: "tok_inline" });
    expect(unmount(deps, { instanceId: player.instanceId, ownerToken: "tok_other" }).released).toBe(false);
  });
});

describe("restoring a pin does not autoplay (T48)", () => {
  function addPin(deps: ReturnType<typeof makeDeps>, instanceId: string): string {
    const pinId = `pin_${String(++counter).padStart(6, "0")}`;
    deps.db
      .prepare(
        "INSERT INTO pins (pin_id, conversation_id, instance_id, display_mode, position, refresh_policy, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(pinId, "conv_1", instanceId, "expanded", 0, "on-open", AT);
    return pinId;
  }

  it("returns the stored position with playback stopped", () => {
    const player = makePlayer(deps, 97.5);
    const pinId = addPin(deps, player.instanceId);

    const outcome = restore(deps, pinId);

    expect(outcome.positionSeconds).toBe(97.5);
    expect(outcome.playing).toBe(false);
    expect(outcome.reason).toContain("starts when you ask for it");
  });

  it("keeps the position in storage, so restoring twice resumes the same place", () => {
    const player = makePlayer(deps, 12);
    const pinId = addPin(deps, player.instanceId);
    restore(deps, pinId);
    expect(restore(deps, pinId).positionSeconds).toBe(12);
  });

  it("refuses to restore a pin that does not exist", () => {
    expect(() => restore(deps, "pin_missing")).toThrow(/does not exist/);
  });
});
