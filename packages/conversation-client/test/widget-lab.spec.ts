import { describe, expect, it } from "vitest";

import { libraryEntries } from "@clarkcant/widget-catalog";

import {
  fixtureById,
  fixtureIds,
  inspectorPanels,
  isActionExecutable,
  propFields,
  requiresApproval,
  themeAttributeFor,
} from "../src/widget-library/widget-lab.ts";

/**
 * The lab's derivations, asserted directly.
 *
 * These are pure functions on purpose: the repo has no DOM test environment, so anything that can be
 * decided without rendering is decided here, and the rendered behaviour (a viewport control actually
 * resizing the preview frame, reduced motion actually suppressing an animation) is asserted in the
 * browser journeys instead.
 */

const entries = libraryEntries();
const entry = (id: string): (typeof entries)[number] => {
  const found = entries.find((candidate) => candidate.definition.id === id);
  if (found === undefined) throw new Error(`missing catalog entry ${id}`);
  return found;
};

describe("widget lab derivations", () => {
  it("lists a props schema's fields with type, requirement and length limit", () => {
    const fields = propFields(entry("canvas.table@1").definition);
    const keys = fields.map((field) => field.key);
    expect(keys).toContain("datasetRef");
    expect(keys).toContain("title");

    const datasetRef = fields.find((field) => field.key === "datasetRef");
    expect(datasetRef?.type).toBe("string");
    expect(datasetRef?.required).toBe(true);
  });

  it("marks optional fields as optional", () => {
    const title = propFields(entry("canvas.table@1").definition).find((field) => field.key === "title");
    expect(title?.required).toBe(false);
    expect(title?.maxLength).toBe(200);
  });

  it("treats an action as drivable only when the widget is read-only", () => {
    expect(isActionExecutable(entry("canvas.table@1").definition)).toBe(true);
    // The call-to-action widget has a local-write effect, so a preview must not offer to run it.
    expect(isActionExecutable(entry("canvas.cta@1").definition)).toBe(false);
  });

  it("flags approval only for effects beyond a local write", () => {
    expect(requiresApproval(entry("canvas.cta@1").definition)).toBe(false);
    expect(requiresApproval(entry("canvas.table@1").definition)).toBe(false);
  });

  it("maps a concrete theme to an attribute and leaves system undefined", () => {
    expect(themeAttributeFor("dark")).toBe("dark");
    expect(themeAttributeFor("light")).toBe("light");
    expect(themeAttributeFor("system")).toBeUndefined();
  });

  it("exposes the fixture ids a widget offers", () => {
    expect(fixtureIds(entry("canvas.line@1"))).toEqual(["line.normal", "line.empty", "line.cached"]);
  });

  it("resolves a fixture by id and reports an unknown id honestly", () => {
    expect(fixtureById(entry("canvas.line@1"), "line.empty")?.label).toBe("Chưa có dữ liệu");
    expect(fixtureById(entry("canvas.line@1"), "nope")).toBeUndefined();
  });

  it("renders every panel the developer standard names", () => {
    const fixture = entry("canvas.table@1").fixtures[0];
    const ids = inspectorPanels(entry("canvas.table@1"), fixture).map((panel) => panel.id);
    expect(ids).toEqual([
      "props",
      "state",
      "events",
      "actions",
      "semantic",
      "sizing",
      "capabilities",
      "fallback",
    ]);
  });

  it("reports the state a fixture actually carries", () => {
    const note = entry("canvas.note@1");
    const fixture = fixtureById(note, "note.normal");
    const state = inspectorPanels(note, fixture).find((panel) => panel.id === "state");
    expect(state?.rows[0]?.value).toContain("revision");
    expect(state?.rows[2]?.value).toBe("1");
  });

  it("says a fixture has no state rather than inventing one", () => {
    const table = entry("canvas.table@1");
    const state = inspectorPanels(table, fixtureById(table, "table.normal")).find(
      (panel) => panel.id === "state",
    );
    expect(state?.rows[0]?.value).toBe("fixture này không khai báo state");
  });

  it("shows the text fallback a reader would get", () => {
    const table = entry("canvas.table@1");
    const fallback = inspectorPanels(table, undefined).find((panel) => panel.id === "fallback");
    expect(fallback?.rows[1]?.value).toBe(table.definition.textFallback);
  });

  it("reports sizing from the definition, not from the preview", () => {
    const sizing = inspectorPanels(entry("canvas.calendar@1"), undefined).find((panel) => panel.id === "sizing");
    expect(sizing?.rows[2]?.value).toBe("260px");
  });

  it("says when a widget requests no capabilities at all", () => {
    const capabilities = inspectorPanels(entry("canvas.table@1"), undefined).find(
      (panel) => panel.id === "capabilities",
    );
    expect(capabilities?.rows[0]?.value).toBe("không yêu cầu capability nào");
  });

  it("never exposes a secret while describing capabilities", () => {
    for (const candidate of entries) {
      for (const panel of inspectorPanels(candidate, candidate.fixtures[0])) {
        for (const row of panel.rows) {
          expect(row.value.toLowerCase()).not.toContain("bearer ");
          expect(row.value.toLowerCase()).not.toContain("authorization:");
        }
      }
    }
  });
});
