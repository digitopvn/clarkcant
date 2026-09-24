import { describe, expect, it } from "vitest";

import {
  applyStateMigrationOps,
  durableState,
  stateMigrationGaps,
  stateMigrationStepSchema,
  validateStateAgainstSchema,
} from "@clarkcant/contracts";

/**
 * The rules a widget's durable state is held to, as the node and `clark widget test` both apply them.
 *
 * Pure functions, tested directly: the node's commit path and the conformance suite call these same functions, so a
 * rule proven here is the rule both of them enforce.
 */

describe("declarative migration operations", () => {
  it("renames, defaults, removes and maps, in order, on a copy", () => {
    const before = { todos: ["a"], sort: "new", legacy: true };

    const after = applyStateMigrationOps(before, [
      { op: "rename", from: "todos", to: "items" },
      { op: "default", key: "view", value: "list" },
      { op: "remove", key: "legacy" },
      { op: "map", key: "sort", values: { new: "newest" } },
    ]);

    expect(after).toEqual({ items: ["a"], view: "list", sort: "newest" });
    expect(before).toEqual({ todos: ["a"], sort: "new", legacy: true });
  });

  it("never overwrites a value with a default, and leaves a value the map does not name", () => {
    expect(
      applyStateMigrationOps({ view: "grid", sort: "custom" }, [
        { op: "default", key: "view", value: "list" },
        { op: "map", key: "sort", values: { new: "newest" } },
      ]),
    ).toEqual({ view: "grid", sort: "custom" });
  });

  it("refuses a rename onto a key that already holds a value rather than drop one of them", () => {
    expect(() => applyStateMigrationOps({ a: 1, b: 2 }, [{ op: "rename", from: "a", to: "b" }])).toThrow(/already holds/);
  });

  it("accepts only single-version steps", () => {
    expect(stateMigrationStepSchema.safeParse({ from: 1, to: 2, ops: [{ op: "remove", key: "x" }] }).success).toBe(true);
    expect(stateMigrationStepSchema.safeParse({ from: 1, to: 3, ops: [{ op: "remove", key: "x" }] }).success).toBe(false);
    expect(stateMigrationStepSchema.safeParse({ from: 1, to: 2, ops: [] }).success).toBe(false);
  });
});

describe("a migration chain", () => {
  it("has no gaps when every version up to the current one has a step", () => {
    expect(
      stateMigrationGaps({
        stateVersion: 3,
        stateMigrations: [
          { from: 1, to: 2, ops: [{ op: "remove", key: "x" }] },
          { from: 2, to: 3, ops: [{ op: "remove", key: "y" }] },
        ],
      }),
    ).toEqual([]);
  });

  it("names a missing step, a duplicate and a step past the declared version", () => {
    const gaps = stateMigrationGaps({
      stateVersion: 3,
      stateMigrations: [
        { from: 0, to: 1, ops: [{ op: "remove", key: "x" }] },
        { from: 0, to: 1, ops: [{ op: "remove", key: "x" }] },
        { from: 3, to: 4, ops: [{ op: "remove", key: "x" }] },
      ],
    });

    expect(gaps).toContain("two migration steps start at stateVersion 0");
    expect(gaps).toContain("no migration step from stateVersion 1 to 2");
    expect(gaps).toContain("a migration step reaches stateVersion 4, past the declared 3");
  });
});

describe("the state schema subset", () => {
  const SCHEMA = {
    type: "object",
    required: ["items"],
    properties: {
      items: { type: "array", maxItems: 2, items: { type: "string", maxLength: 3 } },
      count: { type: "integer", minimum: 0 },
      mode: { enum: ["a", "b"] },
    },
    additionalProperties: false,
  };

  it("accepts a document that matches", () => {
    expect(validateStateAgainstSchema(SCHEMA, { items: ["ab"], count: 2, mode: "a" })).toEqual({ ok: true });
  });

  it("reports every problem with its path", () => {
    const outcome = validateStateAgainstSchema(SCHEMA, { items: ["abcd", "x", "y"], count: -1, mode: "c", extra: 1 });

    if (outcome.ok) throw new Error("expected problems");
    expect(outcome.problems).toEqual(
      expect.arrayContaining([
        "state.items: more than 2 items",
        "state.items[0]: longer than 3 characters",
        "state.count: below 0",
        "state.mode: not one of the allowed values",
        "state.extra: not a declared property",
      ]),
    );
  });

  it("reports a keyword it does not enforce instead of pretending to", () => {
    const outcome = validateStateAgainstSchema({ type: "object", pattern: "^x" }, {});

    expect(outcome).toEqual({ ok: false, problems: ['state: schema keyword "pattern" is not supported'] });
  });

  it("keeps view state out of what is stored", () => {
    expect(durableState({ ephemeralStateKeys: ["filter"] }, { items: [], filter: "open" })).toEqual({ items: [] });
    expect(durableState({}, { filter: "open" })).toEqual({ filter: "open" });
  });
});
