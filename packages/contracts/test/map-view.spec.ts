import { describe, expect, it } from "vitest";

import {
  type CompositionGraph,
  MAP_ID,
  MAP_SELECT_OPERATION,
  MAX_MAP_FEATURES,
  MAX_MAP_LABEL,
  MAX_MAP_VERTICES,
  SEMANTIC_LIMITS,
  applyGraphEvent,
  checkCompositionGraph,
  fitMapCamera,
  graphValues,
  isPersonOnlyRoute,
  mapCamera,
  mapProblems,
  mapSelectProblems,
  mapSemantic,
  mapText,
  mapTilePolicySchema,
  mapTilePolicyView,
  mapTileProblem,
  mapTileTemplateProblem,
  mapViewProblems,
  projectPosition,
  readMap,
  readMapState,
  unprojectPoint,
  visibleMapBounds,
} from "../src/index.ts";

const PROPS = {
  title: "Delivery leg",
  features: [
    { id: "hanoi", label: "Hà Nội", description: "Depot", geometry: { type: "Point", coordinates: [105.8342, 21.0278] } },
    { id: "hcm", label: "TP. Hồ Chí Minh", geometry: { type: "Point", coordinates: [106.6297, 10.8231] } },
    { id: "route", label: "Route", geometry: { type: "LineString", coordinates: [[105.8342, 21.0278], [107.5909, 16.4637], [106.6297, 10.8231]] } },
    {
      id: "bay",
      label: "Hạ Long",
      geometry: { type: "Polygon", coordinates: [[[106.95, 20.75], [107.35, 20.75], [107.35, 21.05], [106.95, 21.05], [106.95, 20.75]]] },
    },
  ],
};

const point = (id: string, lon = 0, lat = 0) => ({ id, label: id, geometry: { type: "Point", coordinates: [lon, lat] } });

describe("map props", () => {
  it("reads a valid map with its counts, vertices and extent", () => {
    expect(mapProblems(PROPS)).toEqual([]);
    const map = readMap(PROPS);
    expect(map?.counts).toEqual({ points: 2, lines: 1, areas: 1 });
    expect(map?.vertexCount).toBe(10);
    expect(map?.bounds).toEqual({ west: 105.8342, south: 10.8231, east: 107.5909, north: 21.05 });
  });

  it("refuses coordinates outside the globe, with the reason", () => {
    expect(mapProblems({ features: [point("a", 181, 0)] }).join(" ")).toContain("longitude must be a number from -180 to 180");
    expect(mapProblems({ features: [point("a", 0, -91)] }).join(" ")).toContain("latitude must be a number from -90 to 90");
    expect(mapProblems({ features: [{ id: "a", label: "A", geometry: { type: "Point", coordinates: [Number.NaN, 0] } }] })).not.toEqual([]);
    expect(mapProblems({ features: [], view: { center: [0, 89], zoom: 3 } }).join(" ")).toContain("Web Mercator");
    expect(mapProblems({ features: [], view: { center: [0, 0], zoom: 2.5 } }).join(" ")).toContain("zoom must be a whole number");
    const open = { id: "a", label: "A", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] } };
    expect(mapProblems({ features: [open] }).join(" ")).toContain("must end where it starts");
  });

  it("refuses unknown geometry types by name", () => {
    const problems = mapProblems({ features: [{ id: "c", label: "C", geometry: { type: "Circle", coordinates: [0, 0] } }] });
    expect(problems.join(" ")).toContain('features.0.geometry.type "Circle" is not one of Point, LineString, Polygon');
    expect(mapProblems({ features: [{ id: "m", label: "M", geometry: { type: "MultiPoint", coordinates: [[0, 0]] } }] })).not.toEqual([]);
  });

  it("refuses oversized feature sets: features, total positions and label length", () => {
    const many = Array.from({ length: MAX_MAP_FEATURES + 1 }, (_, index) => point(`p${String(index)}`));
    expect(mapProblems({ features: many }).join(" ")).toContain(`at most ${String(MAX_MAP_FEATURES)} features`);
    const line = Array.from({ length: MAX_MAP_VERTICES + 1 }, (_, index) => [(index % 300) / 10, 0]);
    expect(mapProblems({ features: [{ id: "l", label: "L", geometry: { type: "LineString", coordinates: line } }] }).join(" ")).toContain(
      `at most ${String(MAX_MAP_VERTICES)} positions`,
    );
    expect(mapProblems({ features: [{ ...point("a"), label: "x".repeat(MAX_MAP_LABEL + 1) }] })).not.toEqual([]);
    expect(mapProblems({ features: [point("a"), point("a")] }).join(" ")).toContain("feature ids repeat: a");
  });

  it("refuses hidden characters in labels and ids", () => {
    expect(mapProblems({ features: [{ ...point("a"), label: "Hà‮Nội" }] })).not.toEqual([]);
    expect(mapProblems({ features: [{ ...point("a​"), label: "A" }] })).not.toEqual([]);
  });

  it("refuses any URL field or URL value, so props can never name a host", () => {
    const keyed = mapProblems({ ...PROPS, tileUrl: "https://tiles.example/{z}/{x}/{y}.png" });
    expect(keyed.join(" ")).toContain("map props carry no URLs (tileUrl)");
    expect(mapProblems({ features: [{ ...point("a"), href: "x" }] }).join(" ")).toContain("features.0.href");
    expect(mapProblems({ features: [{ ...point("a"), description: "https://evil.example/" }] }).join(" ")).toContain("features.0.description");
    expect(mapProblems({ features: [{ ...point("a"), label: "javascript:alert(1)" }] })).not.toEqual([]);
    expect(mapProblems({ features: [], style: { tiles: ["//cdn.example"] } }).join(" ")).toContain("no URLs");
    expect(readMap({ ...PROPS, tileUrl: "https://tiles.example/" })).toBeUndefined();
  });

  it("writes a bounded text alternative", () => {
    const map = readMap(PROPS);
    if (map === undefined) throw new Error("unreadable");
    const text = mapText(map);
    expect(text).toContain("Delivery leg:");
    expect(text).toContain("- Hà Nội (point) — lat 21.0278, lon 105.8342 — Depot");
    expect(text).toContain("- Route (line) — 3 positions from");
    expect(text).toContain("- Hạ Long (area) — 4 corners around lat 20.9000, lon 107.1500");
    expect(mapText(map, 60).length).toBeLessThanOrEqual(60);
  });
});

describe("projection and view", () => {
  it("round-trips positions and fits every feature into the padded viewport", () => {
    const [x, y] = projectPosition([105.8342, 21.0278], 6);
    const [lon, lat] = unprojectPoint(x, y, 6);
    expect(lon).toBeCloseTo(105.8342, 6);
    expect(lat).toBeCloseTo(21.0278, 6);
    const map = readMap(PROPS);
    const camera = fitMapCamera(map?.bounds);
    expect(camera.zoom).toBe(5);
    const visible = visibleMapBounds(camera);
    expect(visible.west).toBeLessThan(105.8342);
    expect(visible.east).toBeGreaterThan(107.5909);
    expect(visible.south).toBeLessThan(10.8231);
    expect(visible.north).toBeGreaterThan(21.05);
    expect(fitMapCamera({ west: 1, east: 1, south: 2, north: 2 })).toEqual({ center: [1, 2], zoom: 12 });
    expect(fitMapCamera(undefined)).toEqual({ center: [0, 20], zoom: 1 });
  });

  it("prefers where the person left the map, then the props' view, then the fit", () => {
    const map = readMap({ ...PROPS, view: { center: [106, 16], zoom: 4 } });
    if (map === undefined) throw new Error("unreadable");
    expect(mapCamera(map, {})).toEqual({ center: [106, 16], zoom: 4 });
    const state = readMapState({ selectedId: "hcm", center: [100, 10], zoom: 7 }, map);
    expect(state).toEqual({ selectedId: "hcm", camera: { center: [100, 10], zoom: 7 } });
    expect(mapCamera(map, state)).toEqual({ center: [100, 10], zoom: 7 });
    expect(readMapState({ selectedId: "gone", center: [0, 89], zoom: 3 }, map)).toEqual({});
  });

  it("checks select and view inputs", () => {
    const map = readMap(PROPS);
    if (map === undefined) throw new Error("unreadable");
    expect(mapSelectProblems(map, { selectedId: "hcm" })).toEqual([]);
    expect(mapSelectProblems(map, { selectedId: "" })).toEqual([]);
    expect(mapSelectProblems(map, { selectedId: "missing" })).not.toEqual([]);
    expect(mapSelectProblems(map, { selectedId: "hcm", url: "x" })).not.toEqual([]);
    expect(mapViewProblems({ center: [106, 16], zoom: 8 })).toEqual([]);
    expect(mapViewProblems({ center: [106, 16], zoom: 19 })).not.toEqual([]);
    expect(mapViewProblems({ center: [200, 16], zoom: 3 })).not.toEqual([]);
    expect(mapViewProblems({ center: [106, 16], zoom: 3, tiles: "x" })).not.toEqual([]);
  });
});

describe("map meaning", () => {
  it("describes visible bounds, feature count, the selection and the tiles within the semantic limits", () => {
    const map = readMap(PROPS);
    if (map === undefined) throw new Error("unreadable");
    const offline = mapSemantic(map, { selectedId: "hanoi" }, { kind: "offline" });
    expect(offline.summary).toMatch(/^Map: 4 features \(2 points, 1 line, 1 area\); showing .* at zoom 5; selected Hà Nội at lat 21\.0278, lon 105\.8342; offline basemap, no tiles$/u);
    expect(offline.values).toMatchObject({ featureCount: 4, zoom: 5, tiles: "offline", selectedLabel: "Hà Nội", selectedLatitude: 21.0278, selectedLongitude: 105.8342 });
    expect(offline.selectedIds).toEqual(["hanoi"]);
    expect(offline.summary.length).toBeLessThanOrEqual(SEMANTIC_LIMITS.summary);
    expect(Object.keys(offline.values).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.values);
    const provider = mapSemantic(map, {}, { kind: "provider", origin: "https://tiles.example" });
    expect(provider.summary).toContain("tiles from https://tiles.example");
    expect(provider.values.tiles).toBe("https://tiles.example");
    expect(provider.selectedIds).toEqual([]);
  });
});

describe("tile policy", () => {
  const PROVIDER = {
    origin: "https://tiles.example",
    template: "/styles/basic/{z}/{x}/{y}.png",
    attribution: "© Example contributors",
    maxZoom: 17,
    credential: { secret: "tiles-key", header: "x-api-key" },
  };

  it("is off by default and accepts one provider with a path template on its origin", () => {
    expect(mapTilePolicySchema.safeParse(null).success).toBe(true);
    expect(mapTilePolicySchema.safeParse(PROVIDER).success).toBe(true);
    expect(mapTilePolicySchema.safeParse({ ...PROVIDER, origin: "http://tiles.example" }).success).toBe(false);
    expect(mapTilePolicySchema.safeParse({ ...PROVIDER, origin: "https://tiles.example/path" }).success).toBe(false);
    expect(mapTilePolicySchema.safeParse({ ...PROVIDER, origin: "wss://tiles.example" }).success).toBe(false);
    expect(mapTilePolicySchema.safeParse({ ...PROVIDER, origin: "http://127.0.0.1:9000" }).success).toBe(true);
    expect(mapTilePolicySchema.safeParse({ ...PROVIDER, credential: { secret: "k", header: "x", query: "key" } }).success).toBe(false);
    expect(mapTilePolicySchema.safeParse({ ...PROVIDER, credential: { secret: "k" } }).success).toBe(false);
    expect(mapTilePolicySchema.safeParse({ ...PROVIDER, maxZoom: 20 }).success).toBe(false);
  });

  it("refuses templates that could name another host or a placeholder it does not fill", () => {
    expect(mapTileTemplateProblem("/{z}/{x}/{y}.png")).toBeUndefined();
    expect(mapTileTemplateProblem("/{z}/{x}/{y}.png?style=dark")).toBeUndefined();
    expect(mapTileTemplateProblem("https://other.example/{z}/{x}/{y}")).toBeDefined();
    expect(mapTileTemplateProblem("//other.example/{z}/{x}/{y}")).toBeDefined();
    expect(mapTileTemplateProblem("/{z}/{x}.png")).toBe("must hold {y} exactly once");
    expect(mapTileTemplateProblem("/{z}/{x}/{y}/{s}.png")).toBe("may hold no placeholder but {z}, {x} and {y}");
    expect(mapTileTemplateProblem("/@evil/{z}/{x}/{y}")).toBeDefined();
  });

  it("tells the page whose tiles and the attribution, never the path or the key", () => {
    expect(mapTilePolicyView(null)).toEqual({ provider: null, offline: "no-provider" });
    const view = mapTilePolicyView(mapTilePolicySchema.parse(PROVIDER));
    expect(view).toEqual({ provider: { origin: "https://tiles.example", attribution: "© Example contributors", maxZoom: 17 } });
    expect(JSON.stringify(view)).not.toContain("tiles-key");
    expect(JSON.stringify(view)).not.toContain("styles/basic");
  });

  it("says why the maps are offline when the provider's key is not usable, without naming the provider or key", () => {
    const view = mapTilePolicyView(mapTilePolicySchema.parse(PROVIDER), false);
    expect(view).toEqual({ provider: null, offline: "key-unavailable" });
  });

  it("bounds tile addresses by zoom and grid", () => {
    expect(mapTileProblem({ maxZoom: 17 }, 0, 0, 0)).toBeUndefined();
    expect(mapTileProblem({ maxZoom: 17 }, 3, 7, 7)).toBeUndefined();
    expect(mapTileProblem({ maxZoom: 17 }, 3, 8, 0)).toBeDefined();
    expect(mapTileProblem({ maxZoom: 17 }, 18, 0, 0)).toBe("zoom must be a whole number from 0 to 17");
    expect(mapTileProblem({ maxZoom: 17 }, 1.5, 0, 0)).toBeDefined();
    expect(mapTileProblem({ maxZoom: 17 }, 2, -1, 0)).toBeDefined();
  });

  it("lets only a person set or undo the policy", () => {
    expect(isPersonOnlyRoute("PUT", "/preferences/maps.tilePolicy")).toBe(true);
    expect(isPersonOnlyRoute("PUT", "//preferences//maps.tilePolicy/")).toBe(true);
    expect(isPersonOnlyRoute("POST", "/preferences/maps.tilePolicy/undo")).toBe(true);
    expect(isPersonOnlyRoute("GET", "/preferences/maps.tilePolicy")).toBe(false);
  });
});

describe("map composition event", () => {
  it("carries map.select's selected id into the graph", () => {
    const sections = [{ sectionId: "map-1", definitionId: MAP_ID }];
    const graph: CompositionGraph = {
      state: { place: { type: "string", initial: "" } },
      on: [{ sectionId: "map-1", event: MAP_SELECT_OPERATION, steps: [{ op: "select-field", key: "place", field: "selectedId" }] }],
      feed: [],
    };
    expect(checkCompositionGraph(graph, sections)).toEqual([]);
    const result = applyGraphEvent(graph, graphValues(graph), { sectionId: "map-1", definitionId: MAP_ID, event: MAP_SELECT_OPERATION, payload: { selectedId: "hanoi" } });
    expect(result).toMatchObject({ ok: true, values: { place: "hanoi" } });
    const unknown: CompositionGraph = { ...graph, on: [{ sectionId: "map-1", event: "map.pan", steps: [{ op: "select-field", key: "place", field: "selectedId" }] }] };
    expect(checkCompositionGraph(unknown, sections)).not.toEqual([]);
  });
});

