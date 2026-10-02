import { describe, expect, it } from "vitest";

import { MAP_ID, mapProblems } from "@clarkcant/contracts";
import { MAP } from "@clarkcant/data-canvas";

import { fixturesFor } from "../src/fixtures.ts";
import { catalogEntry, libraryEntries } from "../src/registry.ts";
import { validateProps } from "../src/validate-props.ts";

describe("map catalog descriptor and fixtures", () => {
  it("registers the host-rendered definition with fixtures that pass both validators", () => {
    expect(MAP.id).toBe(MAP_ID);
    const fixtures = fixturesFor(MAP_ID);
    expect(fixtures.map((fixture) => fixture.id)).toEqual(["map.normal", "map.empty"]);
    for (const fixture of fixtures) {
      expect(validateProps(MAP, fixture.props), fixture.id).toMatchObject({ ok: true });
      expect(mapProblems(fixture.props), fixture.id).toEqual([]);
    }
  });

  it("is findable as a map in both languages", () => {
    const entry = catalogEntry(MAP_ID);
    expect(libraryEntries().some((candidate) => candidate.cardId === MAP_ID)).toBe(true);
    expect(entry).toMatchObject({ displayName: "Bản đồ", status: "stable" });
    expect(entry?.aliases).toEqual(expect.arrayContaining(["map", "bản đồ"]));
  });

  it("refuses at the model schema what the runtime refuses: unknown geometry, too many features and URL fields", () => {
    const point = (id: string) => ({ id, label: id, geometry: { type: "Point", coordinates: [0, 0] } });
    expect(validateProps(MAP, { features: [{ id: "c", label: "C", geometry: { type: "Circle", coordinates: [0, 0] } }] })).toMatchObject({ ok: false });
    expect(validateProps(MAP, { features: Array.from({ length: 201 }, (_, index) => point(`p${String(index)}`)) })).toMatchObject({ ok: false });
    expect(validateProps(MAP, { features: [point("a")], tileUrl: "https://tiles.example/{z}/{x}/{y}.png" })).toMatchObject({ ok: false });
    expect(mapProblems({ features: [point("a")], tileUrl: "https://tiles.example/" })).not.toEqual([]);
  });
});
