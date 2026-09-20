import { describe, expect, it } from "vitest";

import {
  COMPACT_MIN_SIZE,
  MINIMAL_BAR,
  WINDOW_MODES,
  WINDOW_MODE_PRESETS,
  actionForMode,
  fitIntoWorkArea,
  initialWindowMode,
  nextWindowMode,
} from "../src/window-mode.mjs";

/**
 * The arithmetic of shrinking and growing the window, tested without an Electron process.
 *
 * This is what makes the compact mode reviewable: the part that decides sizes and positions is pure, so it is
 * a unit test rather than an operator watching a window. What Electron actually did with the numbers is a
 * separate question, answered by the smoke test reading `getBounds()` back.
 */

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const NORMAL_BOUNDS = { x: 100, y: 80, width: 1100, height: 760 };

describe("the window's allowed sizes", () => {
  it("the allowed minimum leaves room for a twenty by fifty bar", () => {
    // The floor is what the issue asks for: a window may not be shrunk below the bar it exists to show.
    expect(COMPACT_MIN_SIZE).toEqual({ width: 20, height: 50 });
  });

  it("the bar is bigger than the floor, because it holds more than one icon", () => {
    expect(MINIMAL_BAR.width).toBeGreaterThan(COMPACT_MIN_SIZE.width);
    expect(MINIMAL_BAR.height).toBeGreaterThanOrEqual(COMPACT_MIN_SIZE.height);
  });
});

describe("entering compact mode", () => {
  it("compact bounds keep the current position when it still fits the work area", () => {
    const state = initialWindowMode({ bounds: NORMAL_BOUNDS, workArea: WORK_AREA });
    const compact = nextWindowMode(state, { type: "enter-compact" });

    expect(compact.mode).toBe("compact");
    expect(compact.bounds).toEqual({ x: 100, y: 80, width: MINIMAL_BAR.width, height: MINIMAL_BAR.height });
    // Remembered, so expanding is a restore rather than a guess.
    expect(compact.normalBounds).toEqual(NORMAL_BOUNDS);
  });

  it("compact bounds move into the work area when the remembered position is off-screen", () => {
    // A window remembered at the bottom-right of a larger display must still be reachable on this one.
    const state = initialWindowMode({ bounds: { x: 1900, y: 1000, width: 1100, height: 760 }, workArea: WORK_AREA });
    const compact = nextWindowMode(state, { type: "enter-compact" });

    expect(compact.bounds.x).toBe(WORK_AREA.width - MINIMAL_BAR.width);
    expect(compact.bounds.y).toBe(WORK_AREA.height - MINIMAL_BAR.height);
    expect(compact.bounds).toEqual(fitIntoWorkArea(compact.bounds, WORK_AREA));
  });
});

describe("leaving compact mode", () => {
  it("expanding restores the remembered bounds exactly", () => {
    const state = initialWindowMode({ bounds: NORMAL_BOUNDS, workArea: WORK_AREA });
    const compact = nextWindowMode(state, { type: "enter-compact" });
    const expanded = nextWindowMode(compact, { type: "expand" });

    expect(expanded.mode).toBe("normal");
    expect(expanded.bounds).toEqual(NORMAL_BOUNDS);
  });

  it("expanding without a remembered size returns the size it was given rather than inventing one", () => {
    const state = initialWindowMode({ bounds: NORMAL_BOUNDS, workArea: WORK_AREA });
    const expanded = nextWindowMode({ ...state, mode: "compact" }, { type: "expand" });

    expect(expanded.bounds).toEqual(NORMAL_BOUNDS);
  });
});

describe("always on top", () => {
  it("always-on-top follows the user's choice and defaults to off", () => {
    const state = initialWindowMode({ bounds: NORMAL_BOUNDS, workArea: WORK_AREA });
    expect(state.alwaysOnTop).toBe(false);

    const on = nextWindowMode(state, { type: "set-always-on-top", value: true });
    expect(on.alwaysOnTop).toBe(true);
    // It is a pin, not a mode: turning it on does not resize or reposition anything.
    expect(on.mode).toBe(state.mode);
    expect(on.bounds).toEqual(state.bounds);
  });
});

/**
 * The four named modes, and the mapping from a mode name to the action that drives the arithmetic.
 *
 * The two collapsed presentations are separate modes rather than one mode with a flag, and these tests hold
 * that apart: the bar shows state and controls, the orb shows only the orb, and a build that treated them as
 * the same thing would give one of them the other's size.
 */
describe("the four window modes", () => {
  it("names exactly the modes the design has", () => {
    expect([...WINDOW_MODES]).toEqual(["normal", "expanded", "compact", "orb"]);
  });

  it("gives the orb its own size, distinct from the bar", () => {
    expect(WINDOW_MODE_PRESETS.orb).not.toEqual(WINDOW_MODE_PRESETS.compact);
    expect(WINDOW_MODE_PRESETS.orb.width).toBeGreaterThan(WINDOW_MODE_PRESETS.compact.width);
  });

  it("translates each mode name to the action that drives it", () => {
    expect(actionForMode("normal")).toEqual({ type: "expand" });
    expect(actionForMode("expanded")).toEqual({ type: "enter-expanded" });
    expect(actionForMode("compact")).toEqual({ type: "enter-compact" });
    expect(actionForMode("orb")).toEqual({ type: "enter-orb" });
  });

  it("answers nothing for a mode this build does not know", () => {
    // The caller refuses on `undefined` rather than guessing at `normal`: silently growing a window somebody
    // asked to shrink is worse than not moving it.
    expect(actionForMode("fullscreen")).toBeUndefined();
    expect(actionForMode(undefined)).toBeUndefined();
  });

  it("expands to the whole work area, which is why it has no preset size", () => {
    const state = initialWindowMode({
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    const expanded = nextWindowMode(state, { type: "enter-expanded" });
    expect(expanded.mode).toBe("expanded");
    expect(expanded.bounds).toMatchObject({ width: 1920, height: 1080 });
  });

  it("keeps the conversation's position when collapsing to the orb", () => {
    const state = initialWindowMode({
      bounds: { x: 100, y: 120, width: 900, height: 700 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    const orb = nextWindowMode(state, { type: "enter-orb" });
    expect(orb.mode).toBe("orb");
    expect(orb.bounds.width).toBe(WINDOW_MODE_PRESETS.orb.width);
    // And expanding returns to what was there, not to a default.
    expect(nextWindowMode(orb, { type: "expand" }).bounds).toMatchObject({ x: 100, y: 120, width: 900, height: 700 });
  });

  it("does not overwrite the remembered position when collapsing twice", () => {
    // Bar then orb: the second collapse must not remember the bar's bounds as the conversation's.
    const state = initialWindowMode({
      bounds: { x: 100, y: 120, width: 900, height: 700 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    const bar = nextWindowMode(state, { type: "enter-compact" });
    const orb = nextWindowMode(bar, { type: "enter-orb" });
    expect(nextWindowMode(orb, { type: "expand" }).bounds).toMatchObject({ width: 900, height: 700 });
  });
});
