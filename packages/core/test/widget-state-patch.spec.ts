import { describe, expect, it } from "vitest";

import { WIDGET_STATE_MAX_BYTES, type WidgetDefinition } from "@clarkcant/contracts";
import { migrate, openDatabase } from "@clarkcant/storage";
import { createInstance, type WidgetDeps } from "../src/widget-service.ts";
import { disablePackage, initialiseState, readInstanceState } from "../src/widget-lifecycle.ts";
import { applyWidgetStatePatch, prepareFrameState } from "../src/widget-state.ts";

/**
 * Durable state for a widget that runs in its own frame.
 *
 * The frame is third-party code, so every rule that protects the stored document is the node's:
 * view state is dropped, the schema is enforced on the merged document, a stale write loses with
 * the committed state in hand, and state that does not match the definition's version is never
 * overwritten. Stored state older than the definition is migrated by the node, all or nothing.
 */

const AT = "2026-09-24T06:00:00.000Z" as never;
const OWNER = "prin_owner";

const DEF: WidgetDefinition = {
  id: "example.tasks.board",
  version: "2.0.0",
  renderer: "isolated-app",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: {
    type: "object",
    properties: {
      items: { type: "array", maxItems: 50, items: { type: "string", maxLength: 2000 } },
      sort: { enum: ["newest", "oldest"] },
    },
    additionalProperties: false,
  },
  stateVersion: 2,
  ephemeralStateKeys: ["filter"],
  stateMigrations: [
    { from: 1, to: 2, ops: [{ op: "rename", from: "todos", to: "items" }, { op: "map", key: "sort", values: { new: "newest", old: "oldest" } }] },
  ],
  sizing: { compact: true, expanded: true },
  textFallback: "A task list.",
  effectCategories: ["read", "local-write"],
  datasetRefs: [],
  semanticDescription: "A task list",
  requestedCapabilities: [],
};

let counter = 0;

function makeDeps(): WidgetDeps {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  return {
    db,
    nodeId: "node_a",
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  } as WidgetDeps;
}

function makeInstance(deps: WidgetDeps, definition: WidgetDefinition = DEF) {
  return createInstance(deps, {
    definition,
    packageDigest: "digest_board_v2",
    ownerPrincipalId: OWNER as never,
    props: {},
  });
}

function write(deps: WidgetDeps, instanceId: string, expectedRevision: number, patch: Record<string, unknown>) {
  return applyWidgetStatePatch(deps, { instanceId, principalId: OWNER, definition: DEF, expectedRevision, patch });
}

describe("committing a frame's state write", () => {
  it("stores the first write at the definition's stateVersion and drops view state", () => {
    const deps = makeDeps();
    const { instanceId } = makeInstance(deps);

    const outcome = write(deps, instanceId, 0, { items: ["buy milk"], filter: "open" });

    expect(outcome).toEqual({ ok: true, stateRevision: 1, state: { items: ["buy milk"] } });
    const stored = readInstanceState(deps, instanceId);
    expect(stored?.stateVersion).toBe(2);
    expect(stored?.body).toEqual({ items: ["buy milk"] });
  });

  it("merges a patch over what is committed and advances the state revision only", () => {
    const deps = makeDeps();
    const instance = makeInstance(deps);
    write(deps, instance.instanceId, 0, { items: ["a"] });

    const outcome = write(deps, instance.instanceId, 1, { sort: "oldest" });

    expect(outcome).toEqual({ ok: true, stateRevision: 2, state: { items: ["a"], sort: "oldest" } });
    const row = deps.db
      .prepare("SELECT revision FROM widget_instances WHERE instance_id = ?")
      .get(instance.instanceId) as { revision: number };
    expect(row.revision).toBe(instance.revision);
  });

  it("refuses a stale write and returns what is committed, so the widget can show it", () => {
    const deps = makeDeps();
    const { instanceId } = makeInstance(deps);
    write(deps, instanceId, 0, { items: ["from another surface"] });

    const outcome = write(deps, instanceId, 0, { items: ["mine"] });

    expect(outcome).toMatchObject({
      ok: false,
      code: "STATE_REVISION_STALE",
      stateRevision: 1,
      state: { items: ["from another surface"] },
    });
    expect(readInstanceState(deps, instanceId)?.body).toEqual({ items: ["from another surface"] });
  });

  it("refuses state the definition's own schema says is impossible", () => {
    const deps = makeDeps();
    const { instanceId } = makeInstance(deps);

    const outcome = write(deps, instanceId, 0, { items: "not a list", colour: "red" });

    if (outcome.ok || outcome.code !== "STATE_SCHEMA_INVALID") throw new Error(JSON.stringify(outcome));
    expect(outcome.message).toContain("state.items: expected array");
    expect(outcome.message).toContain("state.colour: not a declared property");
    expect(readInstanceState(deps, instanceId)).toBeUndefined();
  });

  it("refuses a document larger than the node stores for one instance", () => {
    const deps = makeDeps();
    const open: WidgetDefinition = { ...DEF, stateSchema: { type: "object" } };
    const { instanceId } = makeInstance(deps, open);

    const outcome = applyWidgetStatePatch(deps, {
      instanceId,
      principalId: OWNER,
      definition: open,
      expectedRevision: 0,
      patch: { blob: "x".repeat(WIDGET_STATE_MAX_BYTES) },
    });

    expect(outcome).toMatchObject({ ok: false, code: "STATE_TOO_LARGE", stateRevision: 0, state: {} });
  });

  it("refuses a write from another principal", () => {
    const deps = makeDeps();
    const { instanceId } = makeInstance(deps);

    const outcome = applyWidgetStatePatch(deps, {
      instanceId,
      principalId: "prin_intruder",
      definition: DEF,
      expectedRevision: 0,
      patch: { items: [] },
    });

    expect(outcome).toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
  });

  it("keeps the state of an uninstalled package but refuses to change it", () => {
    const deps = makeDeps();
    const { instanceId } = makeInstance(deps);
    write(deps, instanceId, 0, { items: ["kept"] });
    disablePackage(deps, { packageDigest: "digest_board_v2", reason: "uninstalled" });

    expect(write(deps, instanceId, 1, { items: [] })).toMatchObject({ ok: false, code: "INSTANCE_OFFLINE" });
    expect(readInstanceState(deps, instanceId)?.body).toEqual({ items: ["kept"] });
    expect(prepareFrameState(deps, { instanceId, definition: DEF }).status.kind).toBe("offline");
  });

  it("refuses to overwrite state written by a newer version of the widget", () => {
    const deps = makeDeps();
    const { instanceId } = makeInstance(deps);
    initialiseState(deps, { instanceId, body: { items: ["v3 shape"] }, stateVersion: 3 });

    expect(write(deps, instanceId, 1, { items: [] })).toMatchObject({
      ok: false,
      code: "STATE_READ_ONLY",
      state: { items: ["v3 shape"] },
    });
    expect(prepareFrameState(deps, { instanceId, definition: DEF }).status).toEqual({
      kind: "newer-than-definition",
      storedVersion: 3,
      definitionVersion: 2,
    });
  });
});

describe("mounting a frame on older state", () => {
  it("starts an instance with no stored state at revision 0", () => {
    const deps = makeDeps();
    const { instanceId } = makeInstance(deps);

    expect(prepareFrameState(deps, { instanceId, definition: DEF })).toEqual({
      stateRevision: 0,
      stateVersion: 2,
      state: {},
      status: { kind: "writable" },
    });
  });

  it("migrates stored state to the definition's version before the frame sees it", () => {
    const deps = makeDeps();
    const { instanceId } = makeInstance(deps);
    initialiseState(deps, { instanceId, body: { todos: ["a", "b"], sort: "old" }, stateVersion: 1 });

    const view = prepareFrameState(deps, { instanceId, definition: DEF });

    expect(view).toEqual({
      stateRevision: 1,
      stateVersion: 2,
      state: { items: ["a", "b"], sort: "oldest" },
      status: { kind: "writable" },
    });
    expect(write(deps, instanceId, 1, { items: ["a"] })).toMatchObject({ ok: true, stateRevision: 2 });
  });

  it("leaves the state untouched and read-only when a migration step fails", () => {
    const deps = makeDeps();
    const { instanceId } = makeInstance(deps);
    // A rename onto a key that already holds a value is refused rather than dropping one of them.
    initialiseState(deps, { instanceId, body: { todos: ["a"], items: ["b"] }, stateVersion: 1 });

    const view = prepareFrameState(deps, { instanceId, definition: DEF });

    expect(view.status).toMatchObject({ kind: "migration-failed", fromVersion: 1, toVersion: 2 });
    expect(view.stateVersion).toBe(1);
    expect(readInstanceState(deps, instanceId)?.body).toEqual({ todos: ["a"], items: ["b"] });
    expect(write(deps, instanceId, 1, { items: [] })).toMatchObject({ ok: false, code: "STATE_READ_ONLY" });
  });

  it("rolls back a migration whose output does not match the current schema", () => {
    const deps = makeDeps();
    const { instanceId } = makeInstance(deps);
    initialiseState(deps, { instanceId, body: { todos: "not a list" }, stateVersion: 1 });

    const view = prepareFrameState(deps, { instanceId, definition: DEF });

    if (view.status.kind !== "migration-failed") throw new Error(JSON.stringify(view.status));
    expect(view.status.reason).toContain("does not match stateSchema");
    expect(readInstanceState(deps, instanceId)?.stateVersion).toBe(1);
    expect(readInstanceState(deps, instanceId)?.body).toEqual({ todos: "not a list" });
  });

  it("reports a missing migration step instead of guessing", () => {
    const deps = makeDeps();
    const { instanceId } = makeInstance(deps);
    initialiseState(deps, { instanceId, body: { todos: [] }, stateVersion: 0 });

    const view = prepareFrameState(deps, { instanceId, definition: DEF });

    expect(view.status).toMatchObject({ kind: "migration-failed", fromVersion: 0, toVersion: 2 });
    expect(readInstanceState(deps, instanceId)?.stateVersion).toBe(0);
  });
});
