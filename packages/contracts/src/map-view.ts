import { z } from "zod";

import { networkOriginProblem } from "./network-origin.ts";
import { cardSchemaProblems, clipWithMarker, hiddenCharacterProblem, oneLineText } from "./text-rules.ts";
import { SEMANTIC_LIMITS, type SemanticValue } from "./widget-semantic.ts";
import { SNAPSHOT_TEXT_LIMIT } from "./widgets.ts";

/*
 * A bounded map: points, lines and areas the model states, drawn by the host over an offline basemap.
 *
 * Coordinates are WGS84 longitude and latitude in a strict subset of GeoJSON geometry (Point, LineString, Polygon).
 * Props carry no URL of any kind: the only network tiles a map can show come from the one provider the node's own tile
 * policy names, fetched by the node. The projection, the fitted view and the visible bounds live here so the page that
 * draws a map and the node that describes it compute the same view.
 */

export const MAP_ID = "canvas.map@1";
export const MAP_SELECT_OPERATION = "map.select";
export const MAP_VIEW_OPERATION = "map.view";

export const MAX_MAP_FEATURES = 200;
/** Every position of every feature together. */
export const MAX_MAP_VERTICES = 5_000;
/** Rings in one area: its outline and the holes in it. */
export const MAX_MAP_RINGS = 16;
export const MAX_MAP_ID = 120;
export const MAX_MAP_LABEL = 120;
export const MAX_MAP_DESCRIPTION = 300;
export const MAX_MAP_TITLE = 200;
export const MAP_MIN_ZOOM = 0;
export const MAP_MAX_ZOOM = 18;
/** The zoom a single point is fitted at: a neighbourhood. */
export const MAP_POINT_ZOOM = 12;
/** The latitude a Web Mercator square ends at; beyond it the projection runs to infinity. */
export const MERCATOR_MAX_LATITUDE = 85.051_128_78;
/** One tile, and the world at zoom 0, in pixels. */
export const MAP_TILE_SIZE = 256;
/** The drawing the renderer makes and the node describes: one fixed viewport, scaled to the page's width. */
export const MAP_VIEWPORT = { width: 640, height: 400, padding: 32 } as const;
export const MAP_GEOMETRY_TYPES = ["Point", "LineString", "Polygon"] as const;
export type MapGeometryType = (typeof MAP_GEOMETRY_TYPES)[number];

export type MapPosition = readonly [longitude: number, latitude: number];

export type MapGeometry =
  | { type: "Point"; coordinates: MapPosition }
  | { type: "LineString"; coordinates: MapPosition[] }
  | { type: "Polygon"; coordinates: MapPosition[][] };

export interface MapFeature {
  id: string;
  label: string;
  description?: string | undefined;
  geometry: MapGeometry;
}

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MapCamera {
  center: MapPosition;
  zoom: number;
}

export interface MapView {
  title?: string | undefined;
  features: MapFeature[];
  /** The view the props asked for, when they asked for one; otherwise the view fits the features. */
  view?: MapCamera | undefined;
  counts: { points: number; lines: number; areas: number };
  vertexCount: number;
  /** The features' extent, or `undefined` when there are none. */
  bounds?: MapBounds | undefined;
}

const longitude = z
  .number()
  .refine((value) => Number.isFinite(value) && value >= -180 && value <= 180, "longitude must be a number from -180 to 180");
const latitude = z
  .number()
  .refine((value) => Number.isFinite(value) && value >= -90 && value <= 90, "latitude must be a number from -90 to 90");
const positionSchema = z.tuple([longitude, latitude]);

function samePosition(a: MapPosition | undefined, b: MapPosition | undefined): boolean {
  return a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1];
}

const ringSchema = z
  .array(positionSchema)
  .min(4, "an area's ring needs at least four positions, the last the same as the first")
  .refine((ring) => samePosition(ring[0], ring.at(-1)), "an area's ring must end where it starts");

const geometrySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("Point"), coordinates: positionSchema }),
  z.strictObject({ type: z.literal("LineString"), coordinates: z.array(positionSchema).min(2, "a line needs at least two positions") }),
  z.strictObject({ type: z.literal("Polygon"), coordinates: z.array(ringSchema).min(1, "an area needs an outline").max(MAX_MAP_RINGS) }),
]);

function idSchema() {
  return z.string().min(1, "is empty").max(MAX_MAP_ID, `is longer than ${String(MAX_MAP_ID)} characters`).superRefine((value, ctx) => {
    const problem = hiddenCharacterProblem(value);
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
    else if (value.trim() === "") ctx.addIssue({ code: "custom", message: "is only spaces" });
  });
}

const featureSchema = z.strictObject({
  id: idSchema(),
  label: oneLineText(MAX_MAP_LABEL, true),
  description: oneLineText(MAX_MAP_DESCRIPTION, false).optional(),
  geometry: geometrySchema,
});

const cameraSchema = z.strictObject({
  center: positionSchema.refine(
    ([, lat]) => Math.abs(lat) <= MERCATOR_MAX_LATITUDE,
    `the centre's latitude must be within ±${String(MERCATOR_MAX_LATITUDE)}, the range a Web Mercator map can show`,
  ),
  zoom: z.number().int("zoom must be a whole number").min(MAP_MIN_ZOOM).max(MAP_MAX_ZOOM),
});

const mapSchema = z.strictObject({
  title: oneLineText(MAX_MAP_TITLE, false).optional(),
  features: z.array(featureSchema).max(MAX_MAP_FEATURES),
  view: cameraSchema.optional(),
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A key that names a link, or a string that is one: props carry places and words, never an address to fetch. */
const URL_KEY = /(?:url|uri|href|src|link|tile|endpoint|origin)/iu;
const URL_VALUE = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|data:|javascript:|blob:)/iu;

/**
 * The checks that come before schema parsing: any URL in the props, an unknown geometry type, and the bounds on
 * features and positions, counted without walking more than the bounds allow.
 */
function boundedShapeProblems(value: unknown): string[] {
  if (!record(value)) return [];
  const problems: string[] = [];
  const urls = new Set<string>();
  let visited = 0;
  const scan = (node: unknown, path: string, depth: number): void => {
    if (urls.size >= 3 || depth > 6 || visited > MAX_MAP_FEATURES * 8) return;
    visited += 1;
    if (typeof node === "string") {
      if (URL_VALUE.test(node)) urls.add(path);
      return;
    }
    if (Array.isArray(node)) {
      // Coordinates are numbers; only the feature list is worth walking for strings.
      if (path === "features") node.slice(0, MAX_MAP_FEATURES + 1).forEach((entry, index) => scan(entry, `features.${String(index)}`, depth + 1));
      return;
    }
    if (!record(node)) return;
    for (const [key, entry] of Object.entries(node)) {
      const at = path === "" ? key : `${path}.${key}`;
      if (URL_KEY.test(key)) urls.add(at);
      else if (key !== "coordinates") scan(entry, at, depth + 1);
    }
  };
  scan(value, "", 0);
  if (urls.size > 0) {
    problems.push(
      `map props carry no URLs (${[...urls].slice(0, 3).join(", ")}): tiles come only from the node's own tile policy, and features are coordinates and words`,
    );
  }
  const features = value.features;
  if (!Array.isArray(features)) return problems;
  if (features.length > MAX_MAP_FEATURES) {
    problems.push(`a map shows at most ${String(MAX_MAP_FEATURES)} features, not ${String(features.length)}`);
    return problems;
  }
  let vertices = 0;
  const countPositions = (coordinates: unknown, depth: number): number => {
    if (!Array.isArray(coordinates)) return 0;
    if (depth === 0) return 1;
    let total = 0;
    for (const entry of coordinates) {
      total += countPositions(entry, depth - 1);
      if (total > MAX_MAP_VERTICES) break;
    }
    return total;
  };
  for (const [index, feature] of features.entries()) {
    if (!record(feature) || !record(feature.geometry)) continue;
    const type = feature.geometry.type;
    if (typeof type !== "string" || !(MAP_GEOMETRY_TYPES as readonly string[]).includes(type)) {
      problems.push(`features.${String(index)}.geometry.type ${JSON.stringify(type)?.slice(0, 40) ?? "is missing"} is not one of ${MAP_GEOMETRY_TYPES.join(", ")}`);
      if (problems.length >= 5) return problems;
      continue;
    }
    vertices += countPositions(feature.geometry.coordinates, type === "Point" ? 0 : type === "LineString" ? 1 : 2);
    if (vertices > MAX_MAP_VERTICES) {
      problems.push(`a map's features hold at most ${String(MAX_MAP_VERTICES)} positions together`);
      return problems;
    }
  }
  return problems;
}

/** Placement problems shared by the model schema's semantic validation and the runtime's exact refusal reason. */
export function mapProblems(input: unknown): string[] {
  const bounded = boundedShapeProblems(input);
  if (bounded.length > 0) return bounded;
  const parsed = mapSchema.safeParse(input);
  if (!parsed.success) return cardSchemaProblems(parsed.error.issues);
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const feature of parsed.data.features) {
    if (seen.has(feature.id)) repeated.add(feature.id);
    seen.add(feature.id);
  }
  return repeated.size > 0 ? [`feature ids repeat: ${[...repeated].slice(0, 5).join(", ")}; each feature needs its own id`] : [];
}

function positionsOf(geometry: MapGeometry): readonly MapPosition[] {
  switch (geometry.type) {
    case "Point": return [geometry.coordinates];
    case "LineString": return geometry.coordinates;
    case "Polygon": return geometry.coordinates.flat();
  }
}

/** Parse a map only after applying the same bounds the placement path uses. */
export function readMap(input: unknown): MapView | undefined {
  if (mapProblems(input).length > 0) return undefined;
  const parsed = mapSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const features = parsed.data.features as MapFeature[];
  const counts = { points: 0, lines: 0, areas: 0 };
  let vertexCount = 0;
  let bounds: MapBounds | undefined;
  for (const feature of features) {
    if (feature.geometry.type === "Point") counts.points += 1;
    else if (feature.geometry.type === "LineString") counts.lines += 1;
    else counts.areas += 1;
    for (const [lon, lat] of positionsOf(feature.geometry)) {
      vertexCount += 1;
      bounds = bounds === undefined
        ? { west: lon, south: lat, east: lon, north: lat }
        : { west: Math.min(bounds.west, lon), south: Math.min(bounds.south, lat), east: Math.max(bounds.east, lon), north: Math.max(bounds.north, lat) };
    }
  }
  return {
    ...(parsed.data.title === undefined || parsed.data.title === "" ? {} : { title: parsed.data.title }),
    features,
    ...(parsed.data.view === undefined ? {} : { view: parsed.data.view as MapCamera }),
    counts,
    vertexCount,
    ...(bounds === undefined ? {} : { bounds }),
  };
}

/* ------------------------------------------------------------------ *
 * Web Mercator
 * ------------------------------------------------------------------ */

/** The world's width and height in pixels at a zoom. */
export function worldSize(zoom: number): number {
  return MAP_TILE_SIZE * 2 ** zoom;
}

/** A position as world pixels at a zoom: x grows east from the antimeridian, y grows south from the top of the square. */
export function projectPosition(position: MapPosition, zoom: number): [number, number] {
  const size = worldSize(zoom);
  const lat = Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, position[1]));
  const sin = Math.sin((lat * Math.PI) / 180);
  const x = ((position[0] + 180) / 360) * size;
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size;
  return [x, y];
}

/** World pixels at a zoom back to a position. */
export function unprojectPoint(x: number, y: number, zoom: number): [number, number] {
  const size = worldSize(zoom);
  const lon = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return [lon, Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, lat))];
}

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

/**
 * The view that shows every feature: the largest whole zoom at which their extent fits inside the padded viewport,
 * centred on it. One point is shown at a neighbourhood's zoom; no features show the world.
 */
export function fitMapCamera(bounds: MapBounds | undefined): MapCamera {
  if (bounds === undefined) return { center: [0, 20], zoom: 1 };
  const width = MAP_VIEWPORT.width - 2 * MAP_VIEWPORT.padding;
  const height = MAP_VIEWPORT.height - 2 * MAP_VIEWPORT.padding;
  let zoom = MAP_MAX_ZOOM;
  const single = bounds.west === bounds.east && bounds.south === bounds.north;
  if (single) zoom = MAP_POINT_ZOOM;
  else {
    for (; zoom > MAP_MIN_ZOOM; zoom -= 1) {
      const [x0, y0] = projectPosition([bounds.west, bounds.north], zoom);
      const [x1, y1] = projectPosition([bounds.east, bounds.south], zoom);
      if (x1 - x0 <= width && y1 - y0 <= height) break;
    }
  }
  const [x0, y0] = projectPosition([bounds.west, bounds.north], zoom);
  const [x1, y1] = projectPosition([bounds.east, bounds.south], zoom);
  const [lon, lat] = unprojectPoint((x0 + x1) / 2, (y0 + y1) / 2, zoom);
  return { center: [round(lon, 6), round(lat, 6)], zoom };
}

/** The longitudes and latitudes the fixed viewport shows around a camera, cut to the world's edges. */
export function visibleMapBounds(camera: MapCamera): MapBounds {
  const [x, y] = projectPosition(camera.center, camera.zoom);
  const size = worldSize(camera.zoom);
  const left = Math.max(0, x - MAP_VIEWPORT.width / 2);
  const right = Math.min(size, x + MAP_VIEWPORT.width / 2);
  const top = Math.max(0, y - MAP_VIEWPORT.height / 2);
  const bottom = Math.min(size, y + MAP_VIEWPORT.height / 2);
  const [west, north] = unprojectPoint(left, top, camera.zoom);
  const [east, south] = unprojectPoint(right, bottom, camera.zoom);
  return { west: round(west, 4), south: round(south, 4), east: round(east, 4), north: round(north, 4) };
}

/* ------------------------------------------------------------------ *
 * View state
 * ------------------------------------------------------------------ */

export interface MapState {
  selectedId?: string;
  /** Where the person moved the map; absent while it shows the view the props give. */
  camera?: MapCamera;
}

function cameraFrom(value: unknown): MapCamera | undefined {
  const parsed = cameraSchema.safeParse(value);
  return parsed.success ? (parsed.data as MapCamera) : undefined;
}

/** Saved state with stale or malformed parts ignored, so a map whose props changed still draws. */
export function readMapState(state: unknown, map: Pick<MapView, "features">): MapState {
  const value = record(state) ? state : {};
  const ids = new Set(map.features.map((feature) => feature.id));
  const selectedId = typeof value.selectedId === "string" && ids.has(value.selectedId) ? value.selectedId : undefined;
  const camera = cameraFrom(value.center === undefined ? undefined : { center: value.center, zoom: value.zoom });
  return { ...(selectedId === undefined ? {} : { selectedId }), ...(camera === undefined ? {} : { camera }) };
}

/** The view a map shows: where the person left it, else the props' view, else one that fits every feature. */
export function mapCamera(map: Pick<MapView, "view" | "bounds">, state: MapState): MapCamera {
  return state.camera ?? map.view ?? fitMapCamera(map.bounds);
}

/** Why a `map.select` input is refused, or nothing. An empty id clears the selection. */
export function mapSelectProblems(map: Pick<MapView, "features">, input: unknown): string[] {
  if (!record(input)) return ["a map selection is an object with selectedId"];
  const extra = Object.keys(input).filter((key) => key !== "selectedId");
  if (extra.length > 0) return [`a map selection carries only selectedId, not ${extra.slice(0, 5).join(", ")}`];
  const selected = input.selectedId;
  if (typeof selected !== "string") return ["selectedId names a feature on this map or is empty to clear the selection"];
  if (selected !== "" && !map.features.some((feature) => feature.id === selected)) return ["selectedId must name a feature on this map or be empty to clear the selection"];
  return [];
}

/** Why a `map.view` input is refused, or nothing. */
export function mapViewProblems(input: unknown): string[] {
  if (!record(input)) return ["a map view is an object with center and zoom"];
  const extra = Object.keys(input).filter((key) => key !== "center" && key !== "zoom");
  if (extra.length > 0) return [`a map view carries only center and zoom, not ${extra.slice(0, 5).join(", ")}`];
  const parsed = cameraSchema.safeParse(input);
  return parsed.success ? [] : cardSchemaProblems(parsed.error.issues);
}

/* ------------------------------------------------------------------ *
 * Text and meaning
 * ------------------------------------------------------------------ */

const KIND: Record<MapGeometryType, string> = { Point: "point", LineString: "line", Polygon: "area" };

/** Latitude then longitude, to four places (about 11 m), labelled so neither is read as the other. */
export function formatMapPosition(position: MapPosition): string {
  return `lat ${position[1].toFixed(4)}, lon ${position[0].toFixed(4)}`;
}

/** Where a feature is said to be: a point's position, a line's ends, an area's middle. */
export function mapFeatureAnchor(feature: MapFeature): MapPosition {
  const positions = positionsOf(feature.geometry);
  if (feature.geometry.type === "Point") return feature.geometry.coordinates;
  if (feature.geometry.type === "LineString") return positions[0] ?? [0, 0];
  const outline = feature.geometry.coordinates[0] ?? [];
  const open = outline.slice(0, -1);
  const lon = open.reduce((sum, [x]) => sum + x, 0) / Math.max(1, open.length);
  const lat = open.reduce((sum, [, y]) => sum + y, 0) / Math.max(1, open.length);
  return [round(lon, 6), round(lat, 6)];
}

/** One feature as a line of text: its label, kind and where it is. */
export function mapFeatureText(feature: MapFeature): string {
  const geometry = feature.geometry;
  const where =
    geometry.type === "Point"
      ? formatMapPosition(geometry.coordinates)
      : geometry.type === "LineString"
        ? `${String(geometry.coordinates.length)} positions from ${formatMapPosition(geometry.coordinates[0] ?? [0, 0])} to ${formatMapPosition(geometry.coordinates.at(-1) ?? [0, 0])}`
        : `${String((geometry.coordinates[0]?.length ?? 1) - 1)} corners around ${formatMapPosition(mapFeatureAnchor(feature))}`;
  return `${feature.label} (${KIND[geometry.type]}) — ${where}${feature.description === undefined || feature.description === "" ? "" : ` — ${feature.description}`}`;
}

export function mapText(map: MapView, limit: number = SNAPSHOT_TEXT_LIMIT): string {
  const lines = map.features.map((feature) => `- ${mapFeatureText(feature)}`);
  const body = lines.length === 0 ? "no features" : lines.join("\n");
  return clipWithMarker(`${map.title ?? "Map"}:\n${body}`, limit);
}

/** What a map's tiles are, for its meaning: the offline basemap, or the provider the node's tile policy names. */
export type MapTileSource = { kind: "offline" } | { kind: "provider"; origin: string };

function formatBound(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(2)}°${value >= 0 ? positive : negative}`;
}

export function mapSemantic(map: MapView, state: MapState, tiles: MapTileSource): {
  title?: string;
  summary: string;
  values: Record<string, SemanticValue>;
  selectedIds: string[];
} {
  const camera = mapCamera(map, state);
  const visible = visibleMapBounds(camera);
  const selected = map.features.find((feature) => feature.id === state.selectedId);
  const anchor = selected === undefined ? undefined : mapFeatureAnchor(selected);
  const counts = [
    `${String(map.counts.points)} point${map.counts.points === 1 ? "" : "s"}`,
    `${String(map.counts.lines)} line${map.counts.lines === 1 ? "" : "s"}`,
    `${String(map.counts.areas)} area${map.counts.areas === 1 ? "" : "s"}`,
  ].join(", ");
  const showing =
    `${formatBound(visible.west, "E", "W")} to ${formatBound(visible.east, "E", "W")}, ` +
    `${formatBound(visible.south, "N", "S")} to ${formatBound(visible.north, "N", "S")} at zoom ${String(camera.zoom)}`;
  const tileText = tiles.kind === "offline" ? "offline basemap, no tiles" : `tiles from ${tiles.origin}`;
  const summary =
    `Map: ${String(map.features.length)} feature${map.features.length === 1 ? "" : "s"} (${counts}); showing ${showing}` +
    `${selected === undefined || anchor === undefined ? "" : `; selected ${selected.label} at ${formatMapPosition(anchor)}`}; ${tileText}`;
  const values: Record<string, SemanticValue> = {
    featureCount: map.features.length,
    points: map.counts.points,
    lines: map.counts.lines,
    areas: map.counts.areas,
    zoom: camera.zoom,
    west: visible.west,
    south: visible.south,
    east: visible.east,
    north: visible.north,
    tiles: tiles.kind === "offline" ? "offline" : tiles.origin,
    ...(selected === undefined || anchor === undefined
      ? {}
      : { selectedLabel: selected.label, selectedLatitude: round(anchor[1], 6), selectedLongitude: round(anchor[0], 6) }),
  };
  return {
    ...(map.title === undefined ? {} : { title: map.title }),
    summary: clipWithMarker(summary, SEMANTIC_LIMITS.summary),
    values: Object.fromEntries(Object.entries(values).slice(0, SEMANTIC_LIMITS.values)),
    selectedIds: selected === undefined ? [] : [selected.id],
  };
}

/* ------------------------------------------------------------------ *
 * Tile policy
 * ------------------------------------------------------------------ */

/** The registered preference that holds the node's tile policy. Person-only to write: see `isPersonOnlyRoute`. */
export const MAP_TILE_POLICY_PREFERENCE = "maps.tilePolicy";
/** The consumer a tile provider's secret must name for the node to send it. */
export const MAP_TILE_SECRET_CONSUMER = "maps:tiles";
/** The highest zoom any provider is asked for, whatever its own maximum says. */
export const MAP_TILE_MAX_ZOOM = 19;
export const MAP_TILE_CONTENT_TYPES = ["image/png", "image/webp"] as const;

const TEMPLATE_CHARACTERS = /^\/[A-Za-z0-9/._~{}=&?-]*$/u;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/u;
const QUERY_NAME = /^[A-Za-z0-9_.-]{1,64}$/u;

/** Why a tile path template is refused, or nothing: a path on the provider's origin with `{z}`, `{x}` and `{y}` once each. */
export function mapTileTemplateProblem(template: string): string | undefined {
  if (template.length > 300) return "is longer than 300 characters";
  if (!TEMPLATE_CHARACTERS.test(template)) {
    return "must be a path starting with / using letters, digits and / . _ ~ - = & ? and the placeholders {z}, {x}, {y}";
  }
  for (const placeholder of ["{z}", "{x}", "{y}"]) {
    if (template.split(placeholder).length !== 2) return `must hold ${placeholder} exactly once`;
  }
  if (/[{}]/u.test(template.replaceAll("{z}", "").replaceAll("{x}", "").replaceAll("{y}", ""))) {
    return "may hold no placeholder but {z}, {x} and {y}";
  }
  if (template.startsWith("//")) return "must be a path, not another host";
  return undefined;
}

const providerSchema = z.strictObject({
  origin: z.string().max(300).superRefine((value, ctx) => {
    const problem = networkOriginProblem(value) ?? (/^https?:\/\//u.test(value) ? undefined : "must use https, or http for a loopback address");
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
  }),
  template: z.string().superRefine((value, ctx) => {
    const problem = mapTileTemplateProblem(value);
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
  }),
  attribution: oneLineText(200, true),
  maxZoom: z.number().int().min(MAP_MIN_ZOOM).max(MAP_TILE_MAX_ZOOM),
  /**
   * The provider's key, by the name of a secret this node holds. The node adds it to each tile request as the header
   * or the query parameter named here; it never reaches the page, props, state, logs or the model.
   */
  credential: z
    .strictObject({
      secret: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/u, "is a secret name: lower-case letters, digits, _ . -"),
      header: z.string().regex(HEADER_NAME, "is an HTTP header name").optional(),
      query: z.string().regex(QUERY_NAME, "is a query parameter name").optional(),
    })
    .refine((value) => (value.header === undefined) !== (value.query === undefined), "names exactly one of header or query")
    .optional(),
});

export type MapTileProvider = z.infer<typeof providerSchema>;

/** The node's tile policy: one provider, or none. None, the default, means no map ever requests a tile. */
export const mapTilePolicySchema = providerSchema.nullable();
export type MapTilePolicy = z.infer<typeof mapTilePolicySchema>;

/**
 * Why a map shows the offline basemap only: no provider is set, or the provider's key is not usable on this node (not
 * provided, not stored for `maps:tiles`, or without a value). Said so a map, and Settings, can tell the person why.
 */
export const MAP_TILES_OFFLINE_REASONS = ["no-provider", "key-unavailable"] as const;
export type MapTilesOfflineReason = (typeof MAP_TILES_OFFLINE_REASONS)[number];

/** What the page is told about the policy: whose tiles, and the attribution it must show. Never a path or a key. */
export interface MapTilePolicyView {
  provider: { origin: string; attribution: string; maxZoom: number } | null;
  /** Present when `provider` is `null`: why the maps are offline-only. */
  offline?: MapTilesOfflineReason;
}

/**
 * The page's view of the policy. A provider whose key is unusable is not handed to the page — every tile would fail —
 * and the view says why instead; the provider's origin and the key's name stay out of it.
 */
export function mapTilePolicyView(policy: MapTilePolicy, keyUsable = true): MapTilePolicyView {
  if (policy === null) return { provider: null, offline: "no-provider" };
  if (!keyUsable) return { provider: null, offline: "key-unavailable" };
  return { provider: { origin: policy.origin, attribution: policy.attribution, maxZoom: policy.maxZoom } };
}

/** Why a tile address is out of bounds, or nothing: a whole zoom up to the provider's maximum, and x, y on that zoom's grid. */
export function mapTileProblem(policy: Pick<MapTileProvider, "maxZoom">, z: number, x: number, y: number): string | undefined {
  const maxZoom = Math.min(policy.maxZoom, MAP_TILE_MAX_ZOOM);
  if (!Number.isInteger(z) || z < MAP_MIN_ZOOM || z > maxZoom) return `zoom must be a whole number from 0 to ${String(maxZoom)}`;
  const span = 2 ** z;
  if (!Number.isInteger(x) || x < 0 || x >= span || !Number.isInteger(y) || y < 0 || y >= span) {
    return `x and y must be whole numbers from 0 to ${String(span - 1)} at zoom ${String(z)}`;
  }
  return undefined;
}
