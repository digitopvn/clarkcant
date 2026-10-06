import { describe, expect, it } from "vitest";

import {
  ROW_HEIGHT_ESTIMATE_PX,
  VIRTUALIZE_AFTER_ROWS,
  computeTranscriptWindow,
  rowOffsets,
  rowVisibility,
  sameTranscriptWindow,
  viewportTopFor,
  type TranscriptWindow,
  type TranscriptWindowInput,
} from "../src/transcript-window.ts";

const ids = (count: number, prefix = "msg"): string[] => Array.from({ length: count }, (_, index) => `${prefix}_${String(index + 1)}`);

/** A height per row that varies the way a chat does: short lines, long answers, a widget now and then. */
function chatHeights(rows: readonly string[]): Map<string, number> {
  return new Map(rows.map((id, index) => [id, index % 17 === 0 ? 640 : index % 3 === 0 ? 260 : 72]));
}

const VIEWPORT = 800;
const GAP = 24;

function windowAt(rows: readonly string[], heights: ReadonlyMap<string, number>, viewportTop: number, keep: number[] = []): TranscriptWindow {
  const input: TranscriptWindowInput = {
    ids: rows,
    heights,
    viewportTop,
    viewportHeight: VIEWPORT,
    overscan: VIEWPORT,
    keep: new Set([rows.length - 1, ...keep]),
    gap: GAP,
  };
  return computeTranscriptWindow(input);
}

/** The segments cover every row exactly once, in order, whatever is mounted. */
function expectPartition(window: TranscriptWindow, count: number): void {
  let next = 0;
  for (const segment of window.segments) {
    expect(segment.from).toBe(next);
    expect(segment.to).toBeGreaterThan(segment.from);
    next = segment.to;
  }
  expect(next).toBe(count);
  const mounted = window.segments.filter((segment) => segment.kind === "rows").flatMap((segment) => {
    const indices: number[] = [];
    for (let index = segment.from; index < segment.to; index += 1) indices.push(index);
    return indices;
  });
  expect(mounted).toEqual(window.mounted);
}

describe("which transcript rows are mounted", () => {
  it("mounts a bounded number of rows anywhere in 5,000 messages, and covers every row exactly once", () => {
    const rows = ids(5_000);
    const heights = chatHeights(rows);
    const total = rowOffsets(rows, heights, ROW_HEIGHT_ESTIMATE_PX)[rows.length]!;
    let largest = 0;
    let steps = 0;
    for (let top = 0; top <= total; top += 997) {
      const window = windowAt(rows, heights, top);
      expectPartition(window, rows.length);
      largest = Math.max(largest, window.mounted.length);
      steps += 1;
    }
    expect(steps).toBeGreaterThan(400);
    // Three screens of the shortest rows, plus the newest row kept wherever the reader is.
    const bound = Math.ceil((3 * VIEWPORT) / 72) + 2;
    expect(largest).toBeLessThanOrEqual(bound);
    expect(largest).toBeLessThan(rows.length / 50);
  });

  it("opens at the bottom with the newest rows mounted and the rest as one spacer of their estimated height", () => {
    const rows = ids(2_000);
    const heights = new Map<string, number>();
    const top = viewportTopFor({ ids: rows, heights, anchor: undefined, viewportHeight: VIEWPORT });
    const window = windowAt(rows, heights, top);
    expect(window.mounted.at(-1)).toBe(rows.length - 1);
    expect(window.mounted.length).toBeLessThanOrEqual(Math.ceil((2 * VIEWPORT) / ROW_HEIGHT_ESTIMATE_PX) + 1);
    const [spacer] = window.segments;
    expect(spacer).toMatchObject({ kind: "gap", from: 0 });
    // The spacer's own gap in the list stands for the gap after the last row it replaces.
    if (spacer?.kind === "gap") expect(spacer.height).toBe(spacer.to * ROW_HEIGHT_ESTIMATE_PX - GAP);
  });

  it("keeps a focused, playing or selected row mounted however far the screen is from it", () => {
    const rows = ids(3_000);
    const heights = chatHeights(rows);
    const total = rowOffsets(rows, heights, 0)[rows.length]!;
    const window = windowAt(rows, heights, total - VIEWPORT, [12, 13, 14, 1_500]);
    for (const index of [12, 13, 14, 1_500, rows.length - 1]) expect(window.mounted).toContain(index);
    expectPartition(window, rows.length);
    expect(window.segments.filter((segment) => segment.kind === "rows").length).toBeGreaterThanOrEqual(3);
  });

  it("mounts every row of a short conversation", () => {
    const rows = ids(VIRTUALIZE_AFTER_ROWS);
    const window = windowAt(rows, chatHeights(rows), 0);
    expect(window.mounted).toHaveLength(rows.length);
    expect(window.segments).toEqual([{ kind: "rows", from: 0, to: rows.length }]);
  });

  it("leaves measured room for unmounted rows, so the list is as tall as it was", () => {
    const rows = ids(400);
    const heights = chatHeights(rows);
    const window = windowAt(rows, heights, 20_000);
    let height = 0;
    for (const segment of window.segments) {
      if (segment.kind === "gap") height += segment.height + GAP;
      else for (let index = segment.from; index < segment.to; index += 1) height += heights.get(rows[index]!)!;
    }
    expect(height).toBeCloseTo(window.totalHeight, 6);
  });

  it("tells the rows on screen from those only kept near it", () => {
    const rows = ids(500);
    const heights = new Map(rows.map((id) => [id, 100]));
    const window = windowAt(rows, heights, 10_000);
    expect(window.visibleFrom).toBe(100);
    expect(window.visibleTo).toBe(108);
    expect(rowVisibility(100, window)).toBe("visible");
    expect(rowVisibility(99, window)).toBe("near");
    expect(rowVisibility(108, window)).toBe("near");
  });
});

describe("keeping the reader's place", () => {
  it("stays on the anchored row when an older page is put in front of it", () => {
    const later = ids(200, "later");
    const heights = chatHeights(later);
    const anchor = { id: "later_57", offset: -30 };
    const before = viewportTopFor({ ids: later, heights, anchor, viewportHeight: VIEWPORT });
    const shownBefore = windowAt(later, heights, before);

    const older = ids(200, "older");
    const all = [...older, ...later];
    for (const id of older) heights.set(id, 90);
    const after = viewportTopFor({ ids: all, heights, anchor, viewportHeight: VIEWPORT });
    expect(after - before).toBe(200 * 90);
    const shownAfter = windowAt(all, heights, after);
    // The same rows are around the screen, at their new indices.
    expect(shownAfter.mounted.filter((index) => index < all.length - 1).map((index) => all[index])).toEqual(
      shownBefore.mounted.filter((index) => index < later.length - 1).map((index) => later[index]),
    );
  });

  it("opens at the bottom when there is no anchor, or the anchored row is no longer held", () => {
    const rows = ids(300);
    const heights = new Map(rows.map((id) => [id, 100]));
    expect(viewportTopFor({ ids: rows, heights, anchor: undefined, viewportHeight: VIEWPORT })).toBe(30_000 - VIEWPORT);
    expect(viewportTopFor({ ids: rows, heights, anchor: { id: "gone", offset: 0 }, viewportHeight: VIEWPORT })).toBe(30_000 - VIEWPORT);
  });

  it("does not redraw for a scroll that mounts the same rows", () => {
    const rows = ids(1_000);
    const heights = new Map(rows.map((id) => [id, 100]));
    expect(sameTranscriptWindow(windowAt(rows, heights, 50_020), windowAt(rows, heights, 50_030))).toBe(true);
    expect(sameTranscriptWindow(windowAt(rows, heights, 50_000), windowAt(rows, heights, 50_400))).toBe(false);
  });
});
