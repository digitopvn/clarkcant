import { describe, expect, it } from "vitest";

import { WINDOW_PLACEMENT_VERSION, placementToRemember, restoredPlacement } from "../src/window-placement.mjs";

/**
 * Reopening the conversation window where it was, tested without an Electron process.
 *
 * The cases that matter are the ones where the remembered place is no longer true: a display that went away, a
 * smaller screen, a file from another shape. Each must fall back to a window the person can reach.
 */

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND = { x: 1920, y: 0, width: 2560, height: 1400 };

function saved(bounds: { x: number; y: number; width: number; height: number }, maximized = false): unknown {
  return placementToRemember({ normalBounds: bounds, maximized });
}

describe("remembering the window", () => {
  it("keeps whole pixels and whether it was maximized", () => {
    expect(placementToRemember({ normalBounds: { x: 10.4, y: 20.6, width: 1200.2, height: 800.7 }, maximized: true })).toEqual({
      version: WINDOW_PLACEMENT_VERSION,
      bounds: { x: 10, y: 21, width: 1200, height: 801 },
      maximized: true,
      fullScreen: false,
    });
  });

  it("does not grow by the scaled display's rounding when nobody moved or resized it", () => {
    const requested = { x: 728, y: 315, width: 1108, height: 768 };
    const actual = { x: 728, y: 315, width: 1111, height: 772 };
    expect(placementToRemember({ normalBounds: actual, maximized: false, openedAs: { requested, actual } }).bounds).toEqual(requested);
  });

  it("keeps the new size once the person resized it", () => {
    const requested = { x: 728, y: 315, width: 1108, height: 768 };
    const resized = { x: 728, y: 315, width: 1300, height: 900 };
    const openedAs = { requested, actual: { ...requested, width: 1111, height: 772 } };
    expect(placementToRemember({ normalBounds: resized, maximized: false, openedAs }).bounds).toEqual(resized);
  });
});

describe("opening it again", () => {
  it("opens where it was, maximized again when it was", () => {
    expect(restoredPlacement(saved({ x: 200, y: 100, width: 1300, height: 900 }, true), [PRIMARY])).toEqual({
      bounds: { x: 200, y: 100, width: 1300, height: 900 },
      maximized: true,
      fullScreen: false,
    });
  });

  it("goes back to full screen when it was closed there, keeping the size to leave it for", () => {
    const remembered = placementToRemember({ normalBounds: { x: 200, y: 100, width: 1100, height: 760 }, maximized: false, fullScreen: true });
    expect(restoredPlacement(remembered, [PRIMARY])).toEqual({
      bounds: { x: 200, y: 100, width: 1100, height: 760 },
      maximized: false,
      fullScreen: true,
    });
  });

  it("finds it on a second display that is still attached", () => {
    expect(restoredPlacement(saved({ x: 2200, y: 200, width: 1400, height: 900 }), [PRIMARY, SECOND])?.bounds.x).toBe(2200);
  });

  it("uses the default when the display it was on is gone, rather than opening it off screen", () => {
    expect(restoredPlacement(saved({ x: 2200, y: 200, width: 1400, height: 900 }), [PRIMARY])).toBeUndefined();
  });

  it("keeps a window remembered from a larger screen inside the smaller one it opens on", () => {
    const placement = restoredPlacement(saved({ x: 100, y: 50, width: 2400, height: 1300 }), [PRIMARY]);
    expect(placement?.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it("ignores a sliver, a file of another shape, and nonsense", () => {
    expect(restoredPlacement(saved({ x: 0, y: 0, width: 68, height: 56 }), [PRIMARY])).toBeUndefined();
    expect(restoredPlacement({ version: 99, bounds: { x: 0, y: 0, width: 1200, height: 800 } }, [PRIMARY])).toBeUndefined();
    expect(restoredPlacement({ version: WINDOW_PLACEMENT_VERSION, bounds: { x: "a" } }, [PRIMARY])).toBeUndefined();
    expect(restoredPlacement(null, [PRIMARY])).toBeUndefined();
  });
});
