/**
 * Which transcript rows are in the document, and how much room stands in for the rest.
 *
 * A long conversation holds thousands of messages, and drawing every one of them keeps thousands of React subtrees,
 * DOM nodes and widget renderers alive for history nobody is reading. The transcript therefore mounts the rows around
 * what the reader can see, plus about one screen on either side, and keeps the rows it does not mount as spacers of
 * their measured height, so the scrollbar and every position in the conversation stay where they were.
 *
 * Pure, so the bound on what is mounted is counted in a unit test rather than trusted to a browser.
 *
 * Heights are each row's own measured block size plus the gap that follows it in the list, so the offset of a row is
 * the sum of the heights before it. A row never measured counts as the estimate: the mean of those measured, which a
 * long chat converges on quickly, or `ROW_HEIGHT_ESTIMATE_PX` before anything was.
 */

/** What a row nobody has measured yet is taken to be, before any row was measured. */
export const ROW_HEIGHT_ESTIMATE_PX = 120;

/** Below this many rows every row is mounted: a short conversation gains nothing and keeps native find-in-page. */
export const VIRTUALIZE_AFTER_ROWS = 60;

/** How a mounted row relates to the screen. A row that is not mounted is `suspended`, drawn as part of a spacer. */
export type RowVisibility = "visible" | "near";

/** One run of the list in document order: mounted rows `[from, to)`, or a spacer for the rows between two such runs. */
export type TranscriptSegment =
  | { kind: "rows"; from: number; to: number }
  | { kind: "gap"; from: number; to: number; height: number };

export interface TranscriptWindowInput {
  ids: readonly string[];
  /** Measured height per row id, the gap after it included. */
  heights: ReadonlyMap<string, number>;
  /** The top of the screen, in pixels from the top of the first row. */
  viewportTop: number;
  viewportHeight: number;
  /** Pixels mounted beyond each edge of the screen. */
  overscan: number;
  /** Rows mounted wherever they are: the newest, the focused, one playing, the selection, the anchor. */
  keep: ReadonlySet<number>;
  /** The gap between two rows in the list, which a spacer's own gap stands in for. */
  gap: number;
  /** Mount every row when there are no more than this many. */
  virtualizeAfter?: number;
}

export interface TranscriptWindow {
  segments: TranscriptSegment[];
  /** Mounted row indices, ascending. */
  mounted: number[];
  /** The rows on screen, `[from, to)`; empty when the list is not on screen. */
  visibleFrom: number;
  visibleTo: number;
  /** The height of the whole list as measured and estimated. */
  totalHeight: number;
}

/** The mean measured height, or the default before anything was measured. */
export function estimateRowHeight(heights: ReadonlyMap<string, number>, fallback = ROW_HEIGHT_ESTIMATE_PX): number {
  if (heights.size === 0) return fallback;
  let sum = 0;
  for (const height of heights.values()) sum += height;
  return sum / heights.size;
}

/** The top offset of every row, and of the end of the list at `ids.length`. */
export function rowOffsets(ids: readonly string[], heights: ReadonlyMap<string, number>, estimate: number): Float64Array {
  const offsets = new Float64Array(ids.length + 1);
  for (let index = 0; index < ids.length; index += 1) offsets[index + 1] = offsets[index]! + (heights.get(ids[index]!) ?? estimate);
  return offsets;
}

/** The first index whose row ends below `y`: the row at `y`, or `count` when `y` is past the end. */
function rowAt(offsets: Float64Array, count: number, y: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle + 1]! > y) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The first index whose row starts at or below `y`. */
function rowFrom(offsets: Float64Array, count: number, y: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle]! >= y) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function computeTranscriptWindow(input: TranscriptWindowInput): TranscriptWindow {
  const count = input.ids.length;
  const estimate = estimateRowHeight(input.heights);
  const offsets = rowOffsets(input.ids, input.heights, estimate);
  const totalHeight = offsets[count]!;
  const viewportBottom = input.viewportTop + input.viewportHeight;
  const visibleFrom = Math.min(rowAt(offsets, count, input.viewportTop), count);
  const visibleTo = Math.max(visibleFrom, rowFrom(offsets, count, viewportBottom));

  let mounted: number[];
  if (count <= (input.virtualizeAfter ?? VIRTUALIZE_AFTER_ROWS)) {
    mounted = Array.from({ length: count }, (_, index) => index);
  } else {
    const from = rowAt(offsets, count, input.viewportTop - input.overscan);
    const to = Math.max(from, rowFrom(offsets, count, viewportBottom + input.overscan));
    const chosen = new Set<number>();
    for (let index = from; index < to; index += 1) chosen.add(index);
    for (const index of input.keep) if (index >= 0 && index < count) chosen.add(index);
    mounted = [...chosen].sort((left, right) => left - right);
  }

  const segments: TranscriptSegment[] = [];
  let cursor = 0;
  for (let position = 0; position < mounted.length; ) {
    const start = mounted[position]!;
    let end = start + 1;
    position += 1;
    while (position < mounted.length && mounted[position] === end) {
      end += 1;
      position += 1;
    }
    if (start > cursor) segments.push(gapSegment(offsets, cursor, start, input.gap));
    segments.push({ kind: "rows", from: start, to: end });
    cursor = end;
  }
  if (cursor < count) segments.push(gapSegment(offsets, cursor, count, input.gap));
  return { segments, mounted, visibleFrom, visibleTo, totalHeight };
}

/** A spacer for rows `[from, to)`. Its own gap in the list is part of the room the rows took, so it is left out. */
function gapSegment(offsets: Float64Array, from: number, to: number, gap: number): TranscriptSegment {
  return { kind: "gap", from, to, height: Math.max(0, offsets[to]! - offsets[from]! - gap) };
}

/** Whether a mounted row is on screen or only kept near it. */
export function rowVisibility(index: number, window: Pick<TranscriptWindow, "visibleFrom" | "visibleTo">): RowVisibility {
  return index >= window.visibleFrom && index < window.visibleTo ? "visible" : "near";
}

/** Whether two windows mount the same rows, show the same ones on screen, and leave the same room for the rest. */
export function sameTranscriptWindow(left: TranscriptWindow, right: TranscriptWindow): boolean {
  if (left.visibleFrom !== right.visibleFrom || left.visibleTo !== right.visibleTo) return false;
  if (left.segments.length !== right.segments.length) return false;
  return left.segments.every((segment, index) => {
    const other = right.segments[index]!;
    if (segment.kind !== other.kind || segment.from !== other.from || segment.to !== other.to) return false;
    return segment.kind === "rows" || other.kind === "rows" || Math.abs(segment.height - other.height) < 1;
  });
}

/**
 * Where the screen is, from the row it is anchored to.
 *
 * The anchor is the first row on screen and how far its top is from the top of the screen, which is negative when it
 * is partly scrolled past. Taking the screen's position from it rather than from `scrollTop` is what keeps the window
 * on the rows being read when an older page is put in front of them: their index and offset move, the anchor's row
 * does not.
 *
 * No anchor, or one no longer held, is the bottom of the list, where a conversation opens.
 */
export function viewportTopFor(input: {
  ids: readonly string[];
  heights: ReadonlyMap<string, number>;
  anchor: { id: string; offset: number } | undefined;
  viewportHeight: number;
}): number {
  const estimate = estimateRowHeight(input.heights);
  const offsets = rowOffsets(input.ids, input.heights, estimate);
  const index = input.anchor === undefined ? -1 : input.ids.indexOf(input.anchor.id);
  if (index < 0 || input.anchor === undefined) return Math.max(0, offsets[input.ids.length]! - input.viewportHeight);
  return offsets[index]! - input.anchor.offset;
}
