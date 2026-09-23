import { describe, expect, it } from "vitest";

import { CATALOG_ENTRIES, libraryEntries, type WidgetCatalogEntry } from "../src/registry.ts";
import { validateProps } from "../src/validate-props.ts";

/**
 * Fixtures, checked the way a preview would use them.
 *
 * The bind check is the important one. A renderer reads rows from the `dataset` prop, not from the
 * `datasetRef` string, so a fixture whose `props.datasetRef` disagrees with its dataset renders the
 * "unavailable" state while looking complete - and an end-to-end test asserting "the real renderer
 * appeared" would then be asserting something false.
 */

/** Problems that make a fixture unusable in a preview. */
function fixtureProblems(entry: WidgetCatalogEntry): string[] {
  const problems: string[] = [];
  for (const fixture of entry.fixtures) {
    if (fixture.dataset !== undefined && fixture.props.datasetRef !== fixture.dataset.datasetId) {
      problems.push(`${entry.definition.id}/${fixture.id}: datasetRef does not match dataset.datasetId`);
    }
    if (fixture.mode === "interactive" && entry.definition.effectCategories.some((kind) => kind !== "read")) {
      problems.push(`${entry.definition.id}/${fixture.id}: interactive fixture on a widget with effects`);
    }
  }
  return problems;
}

describe("catalog fixtures", () => {
  it("gives every library-visible entry at least one fixture", () => {
    const missing = libraryEntries()
      .filter((entry) => entry.fixtures.length === 0)
      .map((entry) => entry.definition.id);
    expect(missing).toEqual([]);
  });

  it("gives every fixture an id, a label and props", () => {
    for (const entry of CATALOG_ENTRIES) {
      for (const fixture of entry.fixtures) {
        expect(fixture.id).not.toBe("");
        expect(fixture.label).not.toBe("");
        expect(typeof fixture.props).toBe("object");
      }
    }
  });

  it("validates every fixture's props against its own definition schema", () => {
    const invalid: string[] = [];
    for (const entry of libraryEntries()) {
      for (const fixture of entry.fixtures) {
        const result = validateProps(entry.definition, fixture.props);
        if (!result.ok) invalid.push(`${entry.definition.id}/${fixture.id}: ${result.problems.join(", ")}`);
      }
    }
    expect(invalid).toEqual([]);
  });

  it("binds every dataset-backed fixture to its own dataset", () => {
    expect(fixtureProblems(CATALOG_ENTRIES[0] as WidgetCatalogEntry)).toEqual([]);
    const offenders = libraryEntries().flatMap(fixtureProblems);
    expect(offenders).toEqual([]);
  });

  it("catches a fixture whose datasetRef does not match its dataset", () => {
    // The negative case, so the check above cannot pass by being vacuous.
    const entry = libraryEntries().find((candidate) => candidate.definition.id === "canvas.table@1");
    expect(entry).toBeDefined();
    const broken: WidgetCatalogEntry = {
      ...(entry as WidgetCatalogEntry),
      fixtures: [
        {
          id: "broken",
          label: "Sai bind",
          props: { title: "Sai bind", datasetRef: "wrong_id" },
          dataset: { datasetId: "fixture_usage", source: "sample", columns: ["week"], rows: [] },
        },
      ],
    };
    expect(fixtureProblems(broken)).toEqual([
      "canvas.table@1/broken: datasetRef does not match dataset.datasetId",
    ]);
  });

  it("covers the states a widget can be in, at minimum a normal one", () => {
    for (const entry of libraryEntries()) {
      expect(entry.fixtures.some((fixture) => fixture.id.endsWith("normal"))).toBe(true);
    }
  });

  it("uses a picture reference the preview can actually resolve", async () => {
    const { FIXTURE_PICTURES } = await import("../src/fixtures.ts");
    const image = libraryEntries().find((entry) => entry.definition.id === "canvas.image@1");
    const ref = image?.fixtures[0]?.props.imageRef;
    expect(typeof ref).toBe("string");
    expect(FIXTURE_PICTURES[ref as string]).toMatch(/^data:image\//);
  });
});
