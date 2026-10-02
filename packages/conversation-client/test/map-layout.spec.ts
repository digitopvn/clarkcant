import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAP_MAX_ZOOM, MAP_VIEWPORT, type MapFeature } from "@clarkcant/contracts";
import { BASEMAP_SOURCE, landRings } from "../src/map-basemap.ts";
import {
  MAP_PAN_STEP,
  basemapPath,
  cameraShift,
  featureShape,
  graticulePath,
  panCamera,
  sameCamera,
  stepFeature,
  toScreen,
  visibleTiles,
  zoomCamera,
} from "../src/map-layout.ts";

const FEATURES: MapFeature[] = [
  { id: "hanoi", label: "Hà Nội", geometry: { type: "Point", coordinates: [105.8342, 21.0278] } },
  { id: "route", label: "Route", geometry: { type: "LineString", coordinates: [[105.8342, 21.0278], [106.6297, 10.8231]] } },
  { id: "bay", label: "Bay", geometry: { type: "Polygon", coordinates: [[[106.95, 20.75], [107.35, 20.75], [107.35, 21.05], [106.95, 21.05], [106.95, 20.75]]] } },
];

describe("the offline basemap", () => {
  it("ships Natural Earth land with its provenance", () => {
    expect(BASEMAP_SOURCE).toEqual({ name: "Natural Earth", dataset: "1:110m Physical Vectors, Land (ne_110m_land)", version: "5.1.2", license: "Public domain" });
    const source = readFileSync(join(import.meta.dirname, "../src/map-basemap.ts"), "utf8");
    expect(source).toContain("SHA-256 9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9");
    expect(landRings().length).toBeGreaterThan(100);
    expect(landRings()).toBe(landRings());
  });

  it("leaves out the rings whose box is off screen", () => {
    const world = basemapPath({ center: [0, 20], zoom: 1 });
    const vietnam = basemapPath({ center: [106, 16], zoom: 6 });
    const ocean = basemapPath({ center: [80, -30], zoom: 9 });
    expect(world.length).toBeGreaterThan(vietnam.length);
    expect(vietnam).toMatch(/^M/u);
    // Culling is by each ring's box, so a continent's outline whose box spans the view is still drawn; most are not.
    expect(ocean.split("Z").length).toBeLessThan(world.split("Z").length / 4);
  });

  it("draws a graticule only while zoomed out", () => {
    expect(graticulePath({ center: [106, 16], zoom: 3 })).not.toBe("");
    expect(graticulePath({ center: [106, 16], zoom: 9 })).toBe("");
  });
});

describe("moving the camera", () => {
  it("puts the centre in the middle of the viewport", () => {
    const [x, y] = toScreen([106, 16], { center: [106, 16], zoom: 6 });
    expect(x).toBeCloseTo(MAP_VIEWPORT.width / 2, 6);
    expect(y).toBeCloseTo(MAP_VIEWPORT.height / 2, 6);
  });

  it("pans by pixels, wraps longitude and stops latitude at the projection's edge", () => {
    const camera = { center: [106, 16] as const, zoom: 6 };
    const east = panCamera(camera, MAP_PAN_STEP, 0);
    expect(east.center[0]).toBeGreaterThan(106);
    expect(east.center[1]).toBeCloseTo(16, 4);
    expect(toScreen(camera.center, east)[0]).toBeCloseTo(MAP_VIEWPORT.width / 2 - MAP_PAN_STEP, 3);
    expect(panCamera({ center: [179, 0], zoom: 2 }, 100, 0).center[0]).toBeLessThan(0);
    expect(panCamera({ center: [0, 80], zoom: 1 }, 0, -10_000).center[1]).toBeCloseTo(85.051_128_78, 4);
  });

  it("zooms in whole levels within bounds", () => {
    expect(zoomCamera({ center: [1, 2], zoom: 5 }, 1)).toEqual({ center: [1, 2], zoom: 6 });
    expect(zoomCamera({ center: [1, 2], zoom: MAP_MAX_ZOOM }, 1).zoom).toBe(MAP_MAX_ZOOM);
    expect(zoomCamera({ center: [1, 2], zoom: 0 }, -1).zoom).toBe(0);
  });

  it("slides the short way, and not at all across a zoom", () => {
    expect(cameraShift({ center: [0, 0], zoom: 2 }, { center: [0, 0], zoom: 3 })).toBeUndefined();
    const [dx] = cameraShift({ center: [179, 0], zoom: 2 }, { center: [-179, 0], zoom: 2 }) ?? [0, 0];
    expect(Math.abs(dx)).toBeLessThan(10);
    expect(sameCamera({ center: [1, 2], zoom: 3 }, { center: [1, 2], zoom: 3 })).toBe(true);
    expect(sameCamera({ center: [1, 2], zoom: 3 }, { center: [1, 2], zoom: 4 })).toBe(false);
  });
});

describe("features and tiles", () => {
  it("draws points as markers and lines and areas as paths", () => {
    const camera = { center: [106, 16] as const, zoom: 5 };
    expect(featureShape(FEATURES[0] as MapFeature, camera)).toMatchObject({ kind: "point" });
    expect(featureShape(FEATURES[1] as MapFeature, camera)).toMatchObject({ kind: "line", d: expect.stringMatching(/^M[\d.-]+ [\d.-]+L/u) });
    expect(featureShape(FEATURES[2] as MapFeature, camera)).toMatchObject({ kind: "area", d: expect.stringMatching(/Z$/u) });
  });

  it("steps through features in order, wrapping", () => {
    expect(stepFeature(FEATURES, undefined, 1)).toBe("hanoi");
    expect(stepFeature(FEATURES, undefined, -1)).toBe("bay");
    expect(stepFeature(FEATURES, "bay", 1)).toBe("hanoi");
    expect(stepFeature(FEATURES, "hanoi", -1)).toBe("bay");
    expect(stepFeature([], undefined, 1)).toBeUndefined();
  });

  it("covers the viewport with tiles on the grid, scaling the deepest past the provider's maximum", () => {
    const tiles = visibleTiles({ center: [106, 16], zoom: 6 }, 17);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(12);
    for (const tile of tiles) {
      expect(tile.z).toBe(6);
      expect(tile.size).toBe(256);
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(64);
      expect(tile.left + tile.size).toBeGreaterThan(0);
      expect(tile.left).toBeLessThan(MAP_VIEWPORT.width);
    }
    const deep = visibleTiles({ center: [106, 16], zoom: 12 }, 10);
    expect(deep.every((tile) => tile.z === 10 && tile.size === 1024)).toBe(true);
    const world = visibleTiles({ center: [0, 0], zoom: 0 }, 17);
    // The one zoom-0 tile appears at each wrapped column the 640-pixel view crosses, with its own placement key.
    expect(new Set(world.map((tile) => `${String(tile.z)}/${String(tile.x)}/${String(tile.y)}`))).toEqual(new Set(["0/0/0"]));
    expect(new Set(world.map((tile) => tile.key)).size).toBe(world.length);
  });
});
