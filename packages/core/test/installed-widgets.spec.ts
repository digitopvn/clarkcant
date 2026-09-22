import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { installedWidgets } from "../src/installed-widgets.ts";

/**
 * What an installed package can contribute to the library.
 *
 * The interesting cases are the refusals. "This node cannot read that package" and "that package declares no
 * widgets" are different facts, and a library that showed the second when it meant the first would be claiming a
 * package is empty when it simply has no bytes here.
 */

function writePackage(
  options: { facets?: number; omitManifest?: boolean; brokenSecondFacet?: boolean; dataset?: "valid" | "broken" | "none" } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "cc-installed-widgets-"));
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  mkdirSync(join(root, "fixtures"), { recursive: true });

  const facetCount = options.facets ?? 1;
  const facets = Array.from({ length: facetCount }, (_, index) => ({
    kind: "widget",
    // The facet id and the definition id are two places to say the same thing, and `readPackage` refuses a
    // package where they disagree, so the fixture keeps them equal rather than tripping its own check.
    id: index === 0 ? "canvas.note@1" : "com.example.panel.extra@1",
    entry: `widgets/main/index.html`,
    definition: `widgets/main/widget-${String(index)}.json`,
    isolation: "isolated-ui",
  }));

  if (options.omitManifest !== true) {
    writeFileSync(
      join(root, "clarkcant.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "com.example.panel",
        version: "1.0.0",
        displayName: "Example panel",
        description: "A widget a package declares.",
        hostApi: { min: 1, max: 1 },
        facets,
        requestedCapabilities: [],
        permissions: {
          networkOrigins: [],
          filesystem: [],
          microphone: false,
          camera: false,
          lifecycleScripts: [],
        },
        platforms: ["linux-x64"],
        publisher: { id: "com.example", sourceUrl: "https://example.invalid", license: "Apache-2.0" },
      }),
    );
  }

  for (let index = 0; index < facetCount; index += 1) {
    if (options.brokenSecondFacet === true && index > 0) {
      // Parses as JSON, fails as a definition: a facet that is there but unusable.
      writeFileSync(join(root, "widgets", "main", `widget-${String(index)}.json`), JSON.stringify({ id: "x" }));
      continue;
    }
    writeFileSync(
      join(root, "widgets", "main", `widget-${String(index)}.json`),
      JSON.stringify({
        id: index === 0 ? "canvas.note@1" : `com.example.panel.extra@1`,
        version: "1.0.0",
        renderer: "catalog",
        propsSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        eventSchemas: {},
        semanticDescription: "A panel a package declares",
        requestedCapabilities: [],
        sizing: { compact: true, expanded: true },
        textFallback: "Example panel. Shown as text when it cannot be mounted.",
        effectCategories: ["read"],
        datasetRefs: [],
      }),
    );
  }

  // Deliberately out of alphabetical order on disk, so the ordering assertion is about the code and not the filesystem.
  writeFileSync(join(root, "fixtures", "empty.json"), JSON.stringify({ title: "" }));
  writeFileSync(join(root, "fixtures", "default.json"), JSON.stringify({ title: "Xin chào" }));

  const dataset = options.dataset ?? "valid";
  if (dataset !== "none") {
    writeFileSync(
      join(root, "fixtures", "default.dataset.json"),
      dataset === "broken"
        ? JSON.stringify({ datasetId: "fixture_panel" })
        : JSON.stringify({
            datasetId: "fixture_panel",
            source: "sample",
            columns: ["week", "runs"],
            rows: [{ week: "W36", runs: 3 }],
          }),
    );
  }

  return root;
}

describe("installed package widgets", () => {
  it("reads a local package and builds its fixtures from the props it wrote", () => {
    const outcome = installedWidgets({
      packageId: "com.example.panel",
      version: "1.0.0",
      source: { kind: "local", path: writePackage() },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.widgets).toHaveLength(1);
    const [widget] = outcome.widgets;
    expect(widget?.facetId).toBe("canvas.note@1");
    expect(widget?.definition.id).toBe("canvas.note@1");
    expect(widget?.packageId).toBe("com.example.panel");
    expect(widget?.version).toBe("1.0.0");

    // The package's fixtures are raw props; the id and the label are the file name rather than an invented prettier one.
    expect(widget?.fixtures.map((fixture) => fixture.id)).toEqual(["default", "empty"]);
    expect(widget?.fixtures[0]?.label).toBe("default");
    expect(widget?.fixtures[0]?.props).toEqual({ title: "Xin chào" });
  });

  it("refuses a git package by naming the reason, rather than reporting it as empty", () => {
    const outcome = installedWidgets({
      packageId: "com.example.panel",
      version: "1.0.0",
      source: { kind: "git", url: "https://example.invalid/p.git", ref: "v1.0.0" },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("NOT_LOCAL");
    expect(outcome.message).toContain("git");
  });

  it("refuses an npm package the same way", () => {
    const outcome = installedWidgets({
      packageId: "com.example.panel",
      version: "1.0.0",
      source: { kind: "npm", name: "example-panel", version: "1.0.0" },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("NOT_LOCAL");
  });

  it("reports a local directory it cannot read as unreadable, not as a package with no widgets", () => {
    const outcome = installedWidgets({
      packageId: "com.example.panel",
      version: "1.0.0",
      source: { kind: "local", path: writePackage({ omitManifest: true }) },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("UNREADABLE");
  });

  it("keeps a facet that did not parse out of the widgets and names it instead of dropping it silently", () => {
    const outcome = installedWidgets({
      packageId: "com.example.panel",
      version: "1.0.0",
      source: { kind: "local", path: writePackage({ facets: 2, brokenSecondFacet: true }) },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The readable facet still arrives: one broken facet must not hide a working one.
    expect(outcome.widgets.map((widget) => widget.facetId)).toEqual(["canvas.note@1"]);
    expect(outcome.problems).toHaveLength(1);
    expect(outcome.problems[0]).toContain("widget-1.json");
  });

  it("carries the dataset a package shipped beside its fixture", () => {
    // Props cannot carry a dataset: the renderers read one from the fixture, so a data-backed widget would draw
    // "no data" forever without this.
    const outcome = installedWidgets({
      packageId: "com.example.panel",
      version: "1.0.0",
      source: { kind: "local", path: writePackage() },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const byId = new Map(outcome.widgets[0]?.fixtures.map((fixture) => [fixture.id, fixture]));
    expect(byId.get("default")?.dataset?.datasetId).toBe("fixture_panel");
    expect(byId.get("default")?.dataset?.rows).toEqual([{ week: "W36", runs: 3 }]);
    // A fixture the package shipped no dataset for renders from none, which is a fact about the package.
    expect(byId.get("empty")?.dataset).toBeUndefined();
  });

  it("names a dataset file that does not match the schema instead of attaching it", () => {
    const outcome = installedWidgets({
      packageId: "com.example.panel",
      version: "1.0.0",
      source: { kind: "local", path: writePackage({ dataset: "broken" }) },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.problems.some((problem) => problem.includes("default.dataset.json"))).toBe(true);
    expect(outcome.widgets[0]?.fixtures.find((fixture) => fixture.id === "default")?.dataset).toBeUndefined();
  });

  it("does not turn a dataset file into a fixture nobody declared", () => {
    // `default.dataset.json` stripped of only `.json` would be a fixture called "default.dataset".
    const outcome = installedWidgets({
      packageId: "com.example.panel",
      version: "1.0.0",
      source: { kind: "local", path: writePackage() },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.widgets[0]?.fixtures.map((fixture) => fixture.id)).toEqual(["default", "empty"]);
  });

  it("returns a definition whose id nobody renders, because whether it can be shown is the caller's gate", () => {
    // The renderer gate belongs where the renderers are. Deciding it here would be a second opinion about what the
    // client can draw, and the two would drift.
    const outcome = installedWidgets({
      packageId: "com.example.panel",
      version: "1.0.0",
      source: { kind: "local", path: writePackage() },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.widgets[0]?.definition.renderer).toBe("catalog");
  });

  it("carries no filesystem path or source metadata out of the read", () => {
    const root = writePackage();
    const outcome = installedWidgets({
      packageId: "com.example.panel",
      version: "1.0.0",
      source: { kind: "local", path: root },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(JSON.stringify(outcome)).not.toContain(root);
  });
});
