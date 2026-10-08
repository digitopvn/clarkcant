import { describe, expect, it } from "vitest";

import { readNodeView, widgetDevSessionCreateSchema, widgetDevSessionViewSchema } from "../src/index.ts";

/**
 * A client reads a node's view tolerantly: an older desktop app talking to a newer node on another machine keeps the
 * session when the view gained a top-level field, says what it left out, and still refuses anything new inside the
 * objects that carry approval, reach or activation state. Requests and what the node writes stay strict.
 */

const AT = "2026-10-08T10:00:00.000Z";
const empty = { added: [], removed: [] };
const generation = {
  generation: 1,
  packageId: "com.example.timer",
  version: "0.1.0",
  digest: `sha256:${"0".repeat(64)}`,
  builtAt: AT,
  trigger: "start",
  widgetIds: ["com.example.timer.main@1"],
  delta: { verdict: "initial", capabilities: empty, frameOrigins: empty, permissions: empty, facets: empty },
  warnings: [],
};
const view = {
  sessionId: "wdev_1",
  status: "live",
  root: "/home/me/timer",
  startedAt: AT,
  latest: generation,
  running: generation,
  activation: { state: "active", generation: 1, generationId: "gen_1" },
  showingLastKnownGood: false,
};

describe("reading a node's widget dev session view", () => {
  it("keeps the session when a newer node adds a top-level field, and says what was left out", () => {
    const read = readNodeView(widgetDevSessionViewSchema, { ...view, fooCode: "FOO_NEW" });
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(read.data).toEqual(view);
    // Never passed on: nothing downstream carries a value nobody validated.
    expect(read.data).not.toHaveProperty("fooCode");
    expect(read.unreadFields).toEqual({ count: 1, names: ["fooCode"] });
  });

  it("says nothing was left out when the view has only known fields", () => {
    const read = readNodeView(widgetDevSessionViewSchema, view);
    expect(read).toEqual({ success: true, data: view, unreadFields: undefined });
  });

  it("counts a field name that is not a plain identifier without naming it", () => {
    const read = readNodeView(widgetDevSessionViewSchema, { ...view, "a b‮": 1, "x.y": 2, later: true });
    expect(read.success && read.unreadFields).toEqual({ count: 3, names: ["later"] });
  });

  it("keeps every known field's bounds", () => {
    expect(readNodeView(widgetDevSessionViewSchema, { ...view, status: "paused", fooCode: "x" }).success).toBe(false);
    expect(readNodeView(widgetDevSessionViewSchema, { ...view, stopCode: "", fooCode: "x" }).success).toBe(false);
    const { root: _root, ...rootless } = view;
    expect(readNodeView(widgetDevSessionViewSchema, rootless).success).toBe(false);
    expect(readNodeView(widgetDevSessionViewSchema, "not a view").success).toBe(false);
  });

  it("still refuses an unknown field inside an object that carries activation, approval or reach state", () => {
    const activation = { ...view.activation, grantedBy: "someone" };
    expect(readNodeView(widgetDevSessionViewSchema, { ...view, activation }).success).toBe(false);
    const awaiting = { state: "awaiting-approval", generation: 1, approvalId: "appr_1", autoApprove: true };
    expect(readNodeView(widgetDevSessionViewSchema, { ...view, activation: awaiting }).success).toBe(false);
    const running = { ...generation, delta: { ...generation.delta, devices: empty } };
    expect(readNodeView(widgetDevSessionViewSchema, { ...view, running }).success).toBe(false);
  });

  it("leaves what the node writes, and a request to it, strict", () => {
    expect(widgetDevSessionViewSchema.safeParse({ ...view, fooCode: "FOO_NEW" }).success).toBe(false);
    expect(widgetDevSessionCreateSchema.safeParse({ root: "/home/me/timer", fooCode: "FOO_NEW" }).success).toBe(false);
  });
});
