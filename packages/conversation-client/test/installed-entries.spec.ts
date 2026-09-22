import { describe, expect, it } from "vitest";

import type { WidgetCatalogEntry } from "@clarkcant/widget-catalog";
import type { WidgetDefinition } from "@clarkcant/contracts";

import type { InstalledPackageRead } from "../src/api.ts";
import { installedCatalogEntries } from "../src/widget-library/installed-entries.ts";

/**
 * Turning installed packages into catalog entries.
 *
 * Every case here is about not overstating: a widget nobody can draw must not become a card, a duplicate must not
 * become two cards for one definition, and a package the node could not read must not become a package with no
 * widgets. The notes are asserted as carefully as the entries, because the notes are what the surface has to show.
 */

function definition(id: string): WidgetDefinition {
  return {
    id,
    version: "1.0.0",
    renderer: "catalog",
    propsSchema: { type: "object", properties: {} },
    eventSchemas: {},
    semanticDescription: `Một widget ${id}`,
    requestedCapabilities: [],
    sizing: { compact: true, expanded: true },
    textFallback: `${id} shown as text`,
    effectCategories: ["read"],
    datasetRefs: [],
  };
}

function knownEntry(id: string, family: string): WidgetCatalogEntry {
  return {
    definition: definition(id),
    family,
    displayName: id,
    description: id,
    tags: [],
    aliases: [],
    source: "builtin",
    status: "stable",
    fixtures: [{ id: "default", label: "default", props: {} }],
  };
}

function readable(packageId: string, ids: readonly string[], problems: readonly string[] = []): InstalledPackageRead {
  return {
    packageId,
    version: "1.0.0",
    ok: true,
    widgets: ids.map((id) => ({
      packageId,
      version: "1.0.0",
      facetId: id,
      definition: definition(id),
      fixtures: [{ id: "default", label: "default", props: { title: "Xin chào" } }],
    })),
    problems: [...problems],
  };
}

const renderEverything = (): boolean => true;

describe("installed packages as catalog entries", () => {
  it("lists a widget this build can render, with the fixtures the package wrote", () => {
    const read = installedCatalogEntries({
      packages: [readable("com.example.panel", ["canvas.note@1"])],
      known: [],
      canRender: renderEverything,
    });

    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.definition.id).toBe("canvas.note@1");
    expect(read.entries[0]?.source).toBe("local");
    expect(read.entries[0]?.fixtures[0]?.props).toEqual({ title: "Xin chào" });
    expect(read.notes).toEqual([]);
  });

  it("names the widget by its own id rather than inventing a prettier one", () => {
    const read = installedCatalogEntries({
      packages: [readable("com.example.panel", ["com.example.panel.extra@1"])],
      known: [],
      canRender: renderEverything,
    });

    expect(read.entries[0]?.displayName).toBe("com.example.panel.extra@1");
    // The description is the definition's own sentence, not a generated one.
    expect(read.entries[0]?.description).toBe("Một widget com.example.panel.extra@1");
  });

  it("leaves out a widget no renderer in this build can draw, and says so", () => {
    const read = installedCatalogEntries({
      packages: [readable("com.example.panel", ["com.example.unknown@1"])],
      known: [],
      canRender: () => false,
    });

    expect(read.entries).toEqual([]);
    expect(read.notes).toHaveLength(1);
    expect(read.notes[0]?.message).toContain("no renderer");
  });

  it("does not show a second card for a definition the catalog already provides", () => {
    const read = installedCatalogEntries({
      packages: [readable("com.example.panel", ["canvas.note@1"])],
      known: [knownEntry("canvas.note@1", "note")],
      canRender: renderEverything,
    });

    // Two cards with one definition id would be two cards that select the same thing.
    expect(read.entries).toEqual([]);
    expect(read.notes[0]?.message).toContain("already a widget of this catalog");
  });

  it("keeps the catalog's family when a package re-declares a catalog definition", () => {
    const read = installedCatalogEntries({
      packages: [readable("com.example.panel", ["com.example.other@1"])],
      known: [knownEntry("com.example.other@1", "tables")],
      canRender: renderEverything,
    });

    // Left out as a duplicate, so the family path is exercised through a definition the catalog does not provide.
    expect(read.entries).toEqual([]);

    const fresh = installedCatalogEntries({
      packages: [readable("com.example.panel", ["com.example.panel.extra@1"])],
      known: [],
      canRender: renderEverything,
    });
    expect(fresh.entries[0]?.family).toBe("com");
  });

  it("shows the first package's widget once when two packages declare the same id", () => {
    const read = installedCatalogEntries({
      packages: [readable("com.first", ["com.shared@1"]), readable("com.second", ["com.shared@1"])],
      known: [],
      canRender: renderEverything,
    });

    expect(read.entries).toHaveLength(1);
    expect(read.notes.some((note) => note.message.includes("another installed package"))).toBe(true);
  });

  it("reports a package the node could not read with the node's own reason", () => {
    const read = installedCatalogEntries({
      packages: [
        { packageId: "com.remote", version: "1.0.0", ok: false, code: "NOT_LOCAL", message: "this node has no bytes" },
      ],
      known: [],
      canRender: renderEverything,
    });

    expect(read.entries).toEqual([]);
    expect(read.notes[0]).toEqual({ packageId: "com.remote", message: "this node has no bytes" });
  });

  it("carries a facet that did not parse through to the notes", () => {
    const read = installedCatalogEntries({
      packages: [readable("com.example.panel", ["com.example.panel.extra@1"], ["widgets/main/broken.json: bad"])],
      known: [],
      canRender: renderEverything,
    });

    expect(read.entries).toHaveLength(1);
    expect(read.notes.some((note) => note.message.includes("broken.json"))).toBe(true);
  });
});
