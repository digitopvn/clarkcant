import { describe, expect, it } from "vitest";

import {
  type FormField,
  checkField,
  checkFieldValue,
  checkFields,
  checkFormValues,
  checkListItems,
  describeFieldValue,
  fieldFromProps,
  formInputSchema,
  listPage,
  parseFields,
} from "../src/index.ts";

/**
 * The rules a field's value is held to, which the page runs as a person types and the node runs again on what is sent.
 * One function for both is the point: the cases here are the ones the two sides must never disagree on.
 */

const field = (overrides: Partial<FormField> & Pick<FormField, "kind">): FormField => ({ name: "value", label: "Giá trị", ...overrides });

describe("describing a field", () => {
  it("refuses a field that asks for a secret, by name or by label, in English or Vietnamese", () => {
    for (const described of [
      field({ kind: "text", name: "password" }),
      field({ kind: "text", name: "apiKey" }),
      field({ kind: "text", label: "Your API key" }),
      field({ kind: "text", label: "Mật khẩu email" }),
      field({ kind: "text", label: "Mã PIN" }),
      field({ kind: "number", name: "cvv" }),
    ]) {
      expect(checkField(described).join(" ")).toContain("asks for a secret");
    }
    // A short word matched only whole: a pinned note or a spinner is not a PIN.
    expect(checkField(field({ kind: "text", name: "spinner", label: "Pinned note" }))).toEqual([]);
  });

  it("gives a choice options and nothing else any, and a slider a range", () => {
    expect(checkField(field({ kind: "select" }))).toContain('field "value" (select) needs options');
    expect(
      checkField(field({ kind: "radio", options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] })),
    ).toContain('field "value" has two options with the same value');
    expect(checkField(field({ kind: "toggle", options: [{ value: "a", label: "A" }] }))).toContain('field "value" (toggle) takes no options');
    expect(checkField(field({ kind: "slider", min: 0 }))).toContain('field "value" (slider) needs min and max');
    expect(checkField(field({ kind: "number", min: 5, max: 1 }))).toContain('field "value" has a min above its max');
    expect(checkField(field({ kind: "date", maxLength: 3 }))).toContain('field "value" (date) takes no minLength, maxLength or multiline');
  });

  it("needs at least one field, names that do not repeat, and no more than twenty", () => {
    expect(checkFields([])).toContain("a form needs at least one field");
    expect(checkFields([field({ kind: "text" }), field({ kind: "text" })])).toContain('two fields are named "value"');
    const many = Array.from({ length: 21 }, (_, index) => field({ kind: "text", name: `f${String(index)}` }));
    expect(checkFields(many)).toContain("a form has 21 fields; at most 20");
  });

  it("reads a single choice or input from a widget's props, leaving its starting value out", () => {
    expect(fieldFromProps({ label: "Bật", kind: "toggle", value: true })).toEqual({ name: "value", label: "Bật", kind: "toggle" });
    expect(fieldFromProps({ label: "Bật", kind: "sparkle" })).toBeUndefined();
    expect(parseFields([{ name: "a", label: "A", kind: "text", extra: 1 }])).toBeUndefined();
  });
});

describe("checking a value", () => {
  it.each<[string, FormField, unknown, string | undefined]>([
    ["an empty required field", field({ kind: "text", required: true }), "", "required"],
    ["an empty optional field", field({ kind: "text" }), undefined, undefined],
    ["text past its limit", field({ kind: "text", maxLength: 3 }), "abcd", "at most 3 characters"],
    ["text counted by characters, not UTF-16 units", field({ kind: "text", maxLength: 2 }), "😀😀", undefined],
    ["a number below its minimum", field({ kind: "number", min: 1 }), 0, "at least 1"],
    ["a decimal step with no floating-point noise", field({ kind: "number", step: 0.1 }), 0.3, undefined],
    ["a slider off its step", field({ kind: "slider", min: 15, max: 120, step: 15 }), 50, "in steps of 15"],
    ["a number sent as text", field({ kind: "number" }), "3", "expected a number"],
    ["a date that does not exist", field({ kind: "date" }), "2026-02-30", "expected a date (YYYY-MM-DD)"],
    ["a time past midnight", field({ kind: "time" }), "24:00", "expected a time (HH:MM)"],
    ["a range that ends first", field({ kind: "date-range" }), { start: "2026-10-03", end: "2026-10-01" }, "the end comes before the start"],
    ["a range with an extra key", field({ kind: "date-range" }), { start: "2026-10-01", end: "2026-10-02", note: "x" }, "expected only a start and an end date"],
    ["a select value it does not offer", field({ kind: "select", options: [{ value: "a", label: "A" }] }), "b", "expected one of the options"],
    ["chips picking one twice", field({ kind: "chips", options: [{ value: "a", label: "A" }] }), ["a", "a"], "an option is chosen twice"],
    ["a required checkbox left unticked", field({ kind: "checkbox", required: true }), false, "required"],
    ["a toggle sent as text", field({ kind: "toggle" }), "on", "expected on or off"],
  ])("%s", (_case, described, value, problem) => {
    expect(checkFieldValue(described, value)).toBe(problem);
  });

  it("refuses a value that names no field instead of dropping it", () => {
    expect(checkFormValues([field({ kind: "text", name: "topic" })], { topic: "A", role: "admin" })).toEqual({
      role: "not a field of this form",
    });
  });

  it("says a value in a person's words", () => {
    const people = field({ kind: "chips", options: [{ value: "an", label: "An" }, { value: "binh", label: "Bình" }] });
    expect(describeFieldValue(people, ["binh", "an"])).toBe("Bình, An");
    expect(describeFieldValue(field({ kind: "date-range" }), { start: "2026-10-01", end: "2026-10-02" })).toBe("2026-10-01 – 2026-10-02");
    expect(describeFieldValue(field({ kind: "text" }), "")).toBe("—");
  });
});

describe("the input an action records", () => {
  it("is exactly the form's fields, the required ones required and a required box one that must be ticked", () => {
    const schema = formInputSchema([
      field({ kind: "text", name: "topic", required: true, maxLength: 40 }),
      field({ kind: "checkbox", name: "agree", required: true }),
      field({ kind: "multiselect", name: "tags", options: [{ value: "a", label: "A" }] }),
    ]);
    expect(schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["topic", "agree"],
      properties: {
        topic: { title: "Giá trị", type: "string", maxLength: 40 },
        agree: { title: "Giá trị", type: "boolean", enum: [true] },
        tags: { title: "Giá trị", type: "array", items: { type: "string", enum: ["a"] }, uniqueItems: true, maxItems: 1 },
      },
    });
  });
});

describe("lists", () => {
  it("refuses items that share an id", () => {
    expect(checkListItems([{ id: "a", title: "A" }, { id: "a", title: "B" }])).toEqual([
      "item ids repeat: a; each item needs its own id",
    ]);
  });

  it("pages within bounds, showing the last page for one past the end", () => {
    const items = Array.from({ length: 12 }, (_, index) => index);
    expect(listPage(items, 3, 5)).toEqual({ rows: [10, 11], page: 3, pageCount: 3, total: 12 });
    expect(listPage(items, 9, 5).page).toBe(3);
    expect(listPage([], 1, 5)).toEqual({ rows: [], page: 1, pageCount: 1, total: 0 });
    // A page size outside the bounds is held to them rather than trusted.
    expect(listPage(items, 1, 1).rows).toHaveLength(5);
  });
});
