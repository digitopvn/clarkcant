import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type FormField, FIELD_KINDS, checkFieldValue } from "@clarkcant/contracts";
import { CHOICE, FORM, INPUT, LIST, SEARCH } from "@clarkcant/data-canvas";
import { describe, expect, it } from "vitest";

import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { RENDERER_IDS, fieldProblemText } from "../src/renderers.tsx";

/**
 * The things a person fills in or picks from, checked where a Node suite can see them.
 *
 * The repo has no DOM test environment, so typing, pressing and sending are asserted in the browser journey. What is
 * asserted here is what a later edit could quietly break: every definition has a renderer, every kind of field has a
 * control, and every rule a field's value is held to is explained in both languages rather than shown as the English
 * sentence the contract returns.
 */

const SOURCE = join(import.meta.dirname, "..", "src");

/** The body of one top-level function, from its declaration to the next top-level declaration or comment block. */
function functionBody(file: string, name: string): string {
  const text = readFileSync(join(SOURCE, file), "utf8");
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is not in ${file}`);
  const rest = text.slice(start);
  const end = rest.search(/\n(?:\/\*|function |export |const [A-Z_]+ =)/u);
  return end < 0 ? rest : rest.slice(0, end);
}

const field = (overrides: Partial<FormField> & Pick<FormField, "kind">): FormField => ({ name: "value", label: "Value", ...overrides });
const options = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
];

/** One value per rule sentence `checkFieldValue` can return. */
const BROKEN: [FormField, unknown][] = [
  [field({ kind: "text", required: true }), ""],
  [field({ kind: "text" }), 3],
  [field({ kind: "text", maxLength: 2 }), "abc"],
  [field({ kind: "text", minLength: 5 }), "abc"],
  [field({ kind: "number" }), "3"],
  [field({ kind: "number", min: 2 }), 1],
  [field({ kind: "number", max: 2 }), 3],
  [field({ kind: "slider", min: 0, max: 10, step: 5 }), 3],
  [field({ kind: "date" }), "2026-02-30"],
  [field({ kind: "time" }), "25:00"],
  [field({ kind: "date-range" }), { start: "2026-10-01" }],
  [field({ kind: "date-range" }), { start: "2026-10-01", end: "2026-10-02", extra: "x" }],
  [field({ kind: "date-range" }), { start: "2026-10-03", end: "2026-10-01" }],
  [field({ kind: "select", options }), "c"],
  [field({ kind: "multiselect", options }), ["c"]],
  [field({ kind: "chips", options }), ["a", "a"]],
  [field({ kind: "toggle" }), "on"],
];

describe("inputs, forms, search and lists", () => {
  it("has a renderer for every definition, so none falls back to its text alternative", () => {
    for (const definition of [CHOICE, INPUT, SEARCH, FORM, LIST]) expect(RENDERER_IDS).toContain(definition.id);
  });

  it("draws a control for every kind of field the contract describes", () => {
    const control = functionBody("renderers.tsx", "FieldControl");
    for (const kind of FIELD_KINDS) expect(control, kind).toContain(`case "${kind}":`);
  });

  it("offers a choice and an input exactly the kinds their widgets accept", () => {
    const kinds = (definition: typeof CHOICE): unknown => (definition.propsSchema.properties as { kind: { enum: unknown } }).kind.enum;
    expect([...(kinds(CHOICE) as string[]), ...(kinds(INPUT) as string[])].sort()).toEqual([...FIELD_KINDS].sort());
  });

  it("explains every rule a value is held to in both languages", () => {
    for (const messages of [MESSAGES_EN, MESSAGES_VI]) {
      const t = (key: MessageKey): string => messages[key];
      for (const [described, value] of BROKEN) {
        const problem = checkFieldValue(described, value);
        expect(problem, JSON.stringify(value)).toBeDefined();
        const said = fieldProblemText(t, problem as string);
        // A translated sentence, with any number it names filled in, never the contract's own English.
        expect(said, problem).not.toBe(problem);
        expect(said).not.toContain("{n}");
      }
    }
    expect(fieldProblemText((key) => MESSAGES_EN[key], "at most 120 characters")).toBe("At most 120 characters.");
    // A rule this page does not know yet is shown as the node wrote it, not dropped.
    expect(fieldProblemText((key) => MESSAGES_EN[key], "a brand new rule")).toBe("a brand new rule");
  });

  it("says everything they show in both languages", () => {
    const prefixes = ["widgets.field.", "widgets.form.", "widgets.list.", "widgets.search."];
    const keys = Object.keys(MESSAGES_VI).filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) expect(MESSAGES_EN[key as MessageKey], key).toBeTruthy();
  });

  it("sends what a form and a list item carry through the one action route, without reading the binding's kind", () => {
    const hook = readFileSync(join(SOURCE, "use-surface-renderer.tsx"), "utf8");
    const wiring = hook.slice(hook.indexOf("const [actionRuns, setActionRuns]"));
    expect(wiring).toContain('isForm && action === "submit"');
    expect(wiring).toContain('isList && action === "item.activate"');
    expect(wiring).toContain("boundAction.inputKeys?.[0]");
    expect(wiring).not.toMatch(/\bkind\b|"invoke"|"agent"|"workflow"|capabilityRef/u);
  });

  it("keeps a search query, a list selection and a calendar's view on the page inside a composed surface", () => {
    const surface = readFileSync(join(SOURCE, "mini-app-surface.tsx"), "utf8");
    expect(surface).toContain('const VIEW_EVENTS: ReadonlySet<string> = new Set(["query.change", "selection.change", "calendar.view", "timeline.select"]);');
    expect(surface).toContain("if (VIEW_EVENTS.has(action)) return;");
  });
});
