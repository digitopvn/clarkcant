import {
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  MAP_TILE_SIZE,
  MAP_VIEWPORT,
  MERCATOR_MAX_LATITUDE,
  type MapCamera,
  type MapFeature,
  type MapPosition,
  projectPosition,
  unprojectPoint,
  worldSize,
} from "@clarkcant/contracts";

import { landRings } from "./map-basemap.ts";

/**
 * Where things fall on a map's fixed 640×400 viewport, as plain functions of the camera.
 *
 * Web Mercator with 256-pixel tiles, the same projection the contract fits a camera with, so what the node says is
 * visible (`visibleMapBounds`) is what the page draws. Nothing here touches the DOM.
 */

export const MAP_PAN_STEP = 96;

/** The viewport's top-left corner in world pixels at the camera's zoom. */
function origin(camera: MapCamera): [number, number] {
  const [x, y] = projectPosition(camera.center, camera.zoom);
  return [x - MAP_VIEWPORT.width / 2, y - MAP_VIEWPORT.height / 2];
}

/** A position on the viewport, in pixels from its top-left corner. */
export function toScreen(position: MapPosition, camera: MapCamera): [number, number] {
  const [x, y] = projectPosition(position, camera.zoom);
  const [left, top] = origin(camera);
  return [x - left, y - top];
}

function wrapLongitude(longitude: number): number {
  const wrapped = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && longitude > 0 ? 180 : wrapped;
}

function clampLatitude(latitude: number): number {
  return Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, latitude));
}

function rounded(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The camera moved by a number of viewport pixels: longitude wraps, latitude stops at the projection's edge. */
export function panCamera(camera: MapCamera, dx: number, dy: number): MapCamera {
  const [x, y] = projectPosition(camera.center, camera.zoom);
  const [longitude, latitude] = unprojectPoint(x + dx, y + dy, camera.zoom);
  return { center: [rounded(wrapLongitude(longitude)), rounded(clampLatitude(latitude))], zoom: camera.zoom };
}

/** The camera one or more whole zoom levels in or out, kept in bounds; the center stays where it is. */
export function zoomCamera(camera: MapCamera, delta: number): MapCamera {
  return { center: camera.center, zoom: Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, camera.zoom + delta)) };
}

/** An SVG path through positions, optionally closed. Coordinates rounded to a tenth of a pixel. */
function pathThrough(positions: readonly MapPosition[], camera: MapCamera, close: boolean): string {
  const points = positions.map((position) => toScreen(position, camera));
  const body = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  return close ? `${body}Z` : body;
}

/** Whether a ring's screen box meets the viewport, so rings off screen are not drawn at all. */
function onScreen(points: readonly (readonly [number, number])[]): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return maxX >= 0 && minX <= MAP_VIEWPORT.width && maxY >= 0 && minY <= MAP_VIEWPORT.height;
}

/** The offline land, as one path of the rings that meet the viewport. */
export function basemapPath(camera: MapCamera): string {
  const parts: string[] = [];
  for (const ring of landRings()) {
    const points = ring.map((position) => toScreen(position, camera));
    if (!onScreen(points)) continue;
    parts.push(`${points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join("")}Z`);
  }
  return parts.join("");
}

/** Meridians and parallels at a spacing that suits the zoom; none past zoom 8, where they would fill the view. */
export function graticulePath(camera: MapCamera): string {
  if (camera.zoom > 8) return "";
  const step = camera.zoom <= 2 ? 30 : camera.zoom <= 4 ? 10 : camera.zoom <= 6 ? 5 : 1;
  const parts: string[] = [];
  const top = toScreen([0, MERCATOR_MAX_LATITUDE], camera)[1];
  const bottom = toScreen([0, -MERCATOR_MAX_LATITUDE], camera)[1];
  for (let longitude = -180; longitude <= 180; longitude += step) {
    const x = toScreen([longitude, 0], camera)[0];
    if (x >= 0 && x <= MAP_VIEWPORT.width) parts.push(`M${x.toFixed(1)} ${Math.max(0, top).toFixed(1)}V${Math.min(MAP_VIEWPORT.height, bottom).toFixed(1)}`);
  }
  for (let latitude = -80; latitude <= 80; latitude += step) {
    const y = toScreen([0, latitude], camera)[1];
    if (y >= 0 && y <= MAP_VIEWPORT.height) parts.push(`M0 ${y.toFixed(1)}H${String(MAP_VIEWPORT.width)}`);
  }
  return parts.join("");
}

/** How a feature is drawn: a marker for a point, a path for a line or an area. */
export type MapShape =
  | { kind: "point"; x: number; y: number }
  | { kind: "line"; d: string }
  | { kind: "area"; d: string };

export function featureShape(feature: MapFeature, camera: MapCamera): MapShape {
  const geometry = feature.geometry;
  if (geometry.type === "Point") {
    const [x, y] = toScreen(geometry.coordinates, camera);
    return { kind: "point", x, y };
  }
  if (geometry.type === "LineString") return { kind: "line", d: pathThrough(geometry.coordinates, camera, false) };
  return { kind: "area", d: geometry.coordinates.map((ring) => pathThrough(ring, camera, true)).join("") };
}

/** One raster tile to draw: its address and where its square falls on the viewport. */
export interface MapTilePlacement {
  key: string;
  z: number;
  x: number;
  y: number;
  left: number;
  top: number;
  size: number;
}

/**
 * The tiles that cover the viewport. Past the provider's maximum zoom the deepest tiles it has are drawn larger rather
 * than asking for tiles it does not serve. Columns wrap around the antimeridian; rows past the poles are left out.
 */
export function visibleTiles(camera: MapCamera, maxZoom: number): MapTilePlacement[] {
  const z = Math.max(MAP_MIN_ZOOM, Math.min(camera.zoom, maxZoom));
  const size = MAP_TILE_SIZE * 2 ** (camera.zoom - z);
  const [left, top] = origin(camera);
  const span = 2 ** z;
  const placements: MapTilePlacement[] = [];
  const firstColumn = Math.floor(left / size);
  const lastColumn = Math.floor((left + MAP_VIEWPORT.width - 1) / size);
  const firstRow = Math.max(0, Math.floor(top / size));
  const lastRow = Math.min(span - 1, Math.floor((top + MAP_VIEWPORT.height - 1) / size));
  const seen = new Set<string>();
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const x = ((column % span) + span) % span;
      const placementKey = `${String(z)}/${String(x)}/${String(row)}@${String(column)}`;
      if (seen.has(placementKey)) continue;
      seen.add(placementKey);
      placements.push({ key: placementKey, z, x, y: row, left: column * size - left, top: row * size - top, size });
    }
  }
  return placements;
}

/** The feature after or before the given one, wrapping; the first or last when none is given. */
export function stepFeature(features: readonly MapFeature[], currentId: string | undefined, direction: 1 | -1): string | undefined {
  if (features.length === 0) return undefined;
  const index = features.findIndex((feature) => feature.id === currentId);
  if (index < 0) return (direction === 1 ? features[0] : features[features.length - 1])?.id;
  return features[(index + direction + features.length) % features.length]?.id;
}

/** Two cameras are the same view. */
export function sameCamera(a: MapCamera, b: MapCamera): boolean {
  return a.zoom === b.zoom && a.center[0] === b.center[0] && a.center[1] === b.center[1];
}

/** The pixel shift from one camera's view to another's at the same zoom, used to slide content into place. */
export function cameraShift(from: MapCamera, to: MapCamera): [number, number] | undefined {
  if (from.zoom !== to.zoom) return undefined;
  const [ax, ay] = projectPosition(from.center, from.zoom);
  const [bx, by] = projectPosition(to.center, to.zoom);
  const size = worldSize(to.zoom);
  // The short way round when the view crosses the antimeridian.
  let dx = bx - ax;
  if (dx > size / 2) dx -= size;
  if (dx < -size / 2) dx += size;
  return [dx, by - ay];
}
