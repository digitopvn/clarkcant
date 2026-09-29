import { describe, expect, it } from "vitest";

import { validateProps } from "../src/widget-props.ts";
import type { WidgetDefinition } from "../src/widgets.ts";

function definition(propsSchema: Record<string, unknown>): WidgetDefinition {
  return {
    id: "test.widget@1",
    version: "1.0.0",
    renderer: "catalog",
    propsSchema,
    eventSchemas: {},
    semanticDescription: "a widget under test",
    requestedCapabilities: [],
    sizing: { compact: false, expanded: true },
    textFallback: "The widget is shown as text.",
    effectCategories: ["read"],
    datasetRefs: [],
  };
}

const TABLE = definition({
  type: "object",
  additionalProperties: false,
  required: ["datasetRef"],
  properties: {
    datasetRef: { type: "string", maxLength: 10 },
    pageSize: { type: "number", minimum: 5, maximum: 200, multipleOf: 1 },
    selection: { type: "string", enum: ["none", "single", "multi"] },
    columns: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key"],
        properties: { key: { type: "string" }, kind: { type: "string", enum: ["text", "number"] } },
      },
    },
    total: { oneOf: [{ type: "string", enum: ["sum", "avg"] }, { type: "boolean" }] },
    options: { type: "object", additionalProperties: false, properties: { dense: { type: "boolean" } } },
  },
});

function problemsOf(props: Record<string, unknown>): string[] {
  const result = validateProps(TABLE, props);
  return result.ok ? [] : result.problems;
}

describe("validateProps", () => {
  it("accepts props that fit the whole schema and returns them unchanged", () => {
    const props = {
      datasetRef: "ds_1",
      pageSize: 200,
      selection: "multi",
      columns: [{ key: "week", kind: "text" }],
      total: "sum",
      options: { dense: true },
    };
    expect(validateProps(TABLE, props)).toEqual({ ok: true, props });
  });

  it("keeps the plain structural problems and falls back to the text alternative", () => {
    const result = validateProps(TABLE, { datasetRef: 4, injected: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(['unknown property "injected"', 'property "datasetRef" must be a string']);
    expect(result.fallback).toEqual({ type: "text", format: "plain", content: TABLE.textFallback, streaming: false });

    expect(problemsOf({})).toEqual(['required property "datasetRef" is missing']);
    expect(problemsOf({ datasetRef: "way-too-long-a-reference" })).toEqual([
      'property "datasetRef" exceeds its maximum length of 10',
    ]);
  });

  it("enforces numeric ranges and multiples", () => {
    expect(problemsOf({ datasetRef: "ds_1", pageSize: 1000 }).join(" ")).toMatch(/property "pageSize": .*200/);
    expect(problemsOf({ datasetRef: "ds_1", pageSize: 2 }).join(" ")).toMatch(/property "pageSize": .*5/);
    expect(problemsOf({ datasetRef: "ds_1", pageSize: 12.5 })).toHaveLength(1);
  });

  it("enforces enums, array items and item counts", () => {
    expect(problemsOf({ datasetRef: "ds_1", selection: "all" })[0]).toMatch(/^property "selection": /);
    expect(problemsOf({ datasetRef: "ds_1", columns: [{ key: "a" }, { key: "b" }, { key: "c" }] })[0]).toMatch(
      /^property "columns": /,
    );
    expect(problemsOf({ datasetRef: "ds_1", columns: [{ kind: "text" }] })[0]).toMatch(/^property "columns\.0\.key": /);
    expect(problemsOf({ datasetRef: "ds_1", columns: [{ key: "a", kind: "chart" }] })[0]).toMatch(/^property "columns\.0\.kind": /);
    expect(problemsOf({ datasetRef: "ds_1", columns: [{ key: "a", onClick: "run()" }] })).toHaveLength(1);
  });

  it("enforces oneOf and nested objects", () => {
    expect(problemsOf({ datasetRef: "ds_1", total: true })).toEqual([]);
    expect(problemsOf({ datasetRef: "ds_1", total: "median" })[0]).toMatch(/^property "total": /);
    expect(problemsOf({ datasetRef: "ds_1", options: { dense: "yes" } })[0]).toMatch(/^property "options\.dense": /);
    expect(problemsOf({ datasetRef: "ds_1", options: { colour: "red" } })).toHaveLength(1);
  });

  it("names a key the structural pass already refused only once", () => {
    expect(problemsOf({ pageSize: 1000, extra: 1 })).toEqual([
      'unknown property "extra"',
      'required property "datasetRef" is missing',
      expect.stringMatching(/^property "pageSize": /),
    ]);
  });

  it("refuses every props object when the schema cannot be read", () => {
    const unreadable = definition({ type: "object", properties: { a: { $ref: "#/nowhere" } } });
    const result = validateProps(unreadable, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("could not be read");
  });
});
