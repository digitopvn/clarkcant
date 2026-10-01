import { describe, expect, it } from "vitest";

import { declaredWidgetEvents, validateCompositionEvent, validateDeclaredWidgetEvent } from "../src/dev-composition.ts";

describe("the composition event simulator", () => {
  it("validates and applies a declared catalog event through the shared composition graph", () => {
    expect(validateCompositionEvent("canvas.list@1", "selection.change", { selected: ["row-a"] })).toEqual({
      ok: true,
      event: {
        name: "selection.change",
        payload: { selected: ["row-a"] },
        values: { field0: ["row-a"] },
      },
    });
  });

  it("refuses undeclared events, extra fields, and fields with the wrong type", () => {
    expect(validateCompositionEvent("canvas.list@1", "selection.delete", { selected: [] })).toMatchObject({
      ok: false,
      problem: "canvas.list@1 does not declare event selection.delete",
    });
    expect(validateCompositionEvent("canvas.list@1", "selection.change", { selected: [], injected: true })).toMatchObject({
      ok: false,
    });
    expect(validateCompositionEvent("canvas.list@1", "selection.change", { selected: "row-a" })).toMatchObject({
      ok: false,
    });
  });

  it("shows package-declared events and validates their payload with the declared JSON schema", () => {
    const eventSchemas = {
      "selection.change": {
        type: "object",
        properties: { selected: { type: "array", items: { type: "string" } } },
        required: ["selected"],
        additionalProperties: false,
      },
    };
    expect(declaredWidgetEvents("example.notes", eventSchemas)).toEqual([
      { name: "selection.change", fields: ["selected"], example: { selected: [] } },
    ]);
    expect(validateDeclaredWidgetEvent(eventSchemas["selection.change"], { selected: ["note-1"] })).toEqual({
      ok: true,
      payload: { selected: ["note-1"] },
    });
    expect(validateDeclaredWidgetEvent(eventSchemas["selection.change"], { selected: 42 })).toMatchObject({
      ok: false,
    });
    expect(validateDeclaredWidgetEvent(undefined, { selected: [] })).toMatchObject({ ok: false });
  });
});
