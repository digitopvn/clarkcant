/**
 * The arithmetic of shrinking and growing the desktop window.
 *
 * Pure on purpose. What the window should become is a decision about numbers, and a decision about numbers can
 * be tested without starting Electron; what Electron actually did with those numbers is a different question,
 * answered by the smoke test reading `getBounds()` back off the real window.
 *
 * Both sizes are here rather than inline in `main.mjs` so the compact mode and the minimal voice bar cannot
 * drift apart: the bar is what the window shows, and the floor is the smallest the OS will let it be.
 */

/**
 * The smallest the window may be resized to, from the issue: a twenty by fifty bar.
 *
 * This is a floor for `setMinimumSize`, not a size anything aims for. On Windows the OS adds its own tracking
 * floor on top of it, which only a real display can measure - hence the smoke test rather than an assertion
 * here.
 */
export const COMPACT_MIN_SIZE = Object.freeze({ width: 20, height: 50 });

/**
 * The size the window takes when it becomes a voice bar: the twenty by fifty icon plus the expand affordance
 * and their padding.
 *
 * Final acceptance of this number is on a real display; it is what the window becomes, not what it may not go
 * below.
 */
export const MINIMAL_BAR = Object.freeze({ width: 68, height: 56 });

/**
 * Valid window modes.
 *
 * Four, matching the design: the conversation at its normal size, the same conversation given more room, the
 * voice bar, and the orb. `compact` and `orb` are the two collapsed presentations and they are not the same
 * thing — the bar shows state and controls, the orb shows only the orb — which is why they are separate modes
 * rather than one mode with a flag.
 *
 * A mode this build does not know is refused rather than coerced into `normal`: silently growing a window
 * somebody asked to shrink is worse than not moving it.
 */
export const WINDOW_MODES = Object.freeze(["normal", "expanded", "compact", "orb"]);

/**
 * The size each mode takes, where a mode has one of its own.
 *
 * `expanded` is deliberately absent: it is the work area rather than a number, because "more room" means
 * whatever the display has, and a fixed 1600×1000 would be larger than some screens and smaller than others.
 * `normal` is absent too — it restores what the person had.
 */
export const WINDOW_MODE_PRESETS = Object.freeze({
  compact: MINIMAL_BAR,
  orb: Object.freeze({ width: 148, height: 148 }),
});

/**
 * The window's remembered state.
 *
 * `normalBounds` is the whole point of keeping state at all: expanding has to restore what the person had, and
 * a hardcoded size would move their window every time they collapsed it.
 */
export function initialWindowMode(input) {
  const bounds = normalizeBounds(input?.bounds);
  return {
    mode: "normal",
    bounds,
    normalBounds: bounds,
    alwaysOnTop: input?.alwaysOnTop === true,
    workArea: input?.workArea,
  };
}

/**
 * The next state for an action, or the same state for an action that means nothing here.
 *
 * Total by design: an unrecognised action returns the state unchanged rather than throwing, so a renderer that
 * asks for something this build does not know cannot take the window down with it.
 */
export function nextWindowMode(state, action) {
  switch (action?.type) {
    case "enter-compact":
      return enterPreset(state, "compact");
    case "enter-orb":
      return enterPreset(state, "orb");
    case "enter-expanded":
      return {
        ...state,
        mode: "expanded",
        // Only a collapse from the conversation remembers where it was: expanding from an already-collapsed
        // state must not overwrite that with the bar's own bounds.
        normalBounds: state.mode === "normal" ? state.bounds : state.normalBounds,
        // The whole work area, which is what "expanded" means and why it has no preset size.
        bounds:
          state.workArea === undefined || state.workArea === null
            ? normalizeBounds(state.bounds)
            : normalizeBounds(state.workArea),
      };
    case "expand":
      return {
        ...state,
        mode: "normal",
        // Exactly what was remembered. A default size here would be simpler and would move the window.
        bounds: normalizeBounds(state.normalBounds ?? state.bounds),
      };
    case "set-always-on-top":
      return { ...state, alwaysOnTop: action.value === true };
    default:
      return state;
  }
}

/**
 * Collapse to one of the presets, remembering where the conversation was.
 *
 * Shared by the bar and the orb so the two cannot disagree about what "remembered" means: both keep the window
 * where it was when that position still fits, and both are pulled back into the work area when it does not — a
 * small window off the edge of the screen is a window nobody can reach.
 */
function enterPreset(state, mode) {
  const preset = WINDOW_MODE_PRESETS[mode];
  return {
    ...state,
    mode,
    normalBounds: state.mode === "normal" ? state.bounds : state.normalBounds,
    bounds: fitIntoWorkArea(
      { x: state.bounds.x, y: state.bounds.y, width: preset.width, height: preset.height },
      state.workArea,
    ),
  };
}

/**
 * Apply a named mode, for a caller that has a mode rather than an action.
 *
 * The intent registry speaks in modes and the window speaks in actions, so one has to translate. Doing it here
 * keeps the mapping next to the arithmetic it drives, instead of in a handler where it would be one more thing
 * to keep in step. An unknown mode returns nothing, and the caller refuses rather than guessing at `normal`.
 */
export function actionForMode(mode) {
  switch (mode) {
    case "normal":
      return { type: "expand" };
    case "expanded":
      return { type: "enter-expanded" };
    case "compact":
      return { type: "enter-compact" };
    case "orb":
      return { type: "enter-orb" };
    default:
      return undefined;
  }
}

/**
 * Move bounds inside the work area, keeping the size.
 *
 * Only position moves: resizing a window to fit would be a second surprise on top of the first one.
 */
export function fitIntoWorkArea(bounds, workArea) {
  const normalized = normalizeBounds(bounds);
  if (workArea === undefined || workArea === null) return normalized;

  const maxX = workArea.x + Math.max(0, workArea.width - normalized.width);
  const maxY = workArea.y + Math.max(0, workArea.height - normalized.height);
  return {
    ...normalized,
    x: Math.min(Math.max(normalized.x, workArea.x), maxX),
    y: Math.min(Math.max(normalized.y, workArea.y), maxY),
  };
}

/** Whole pixels only: a fractional window position is a rounding argument nobody wants to have. */
function normalizeBounds(bounds) {
  return {
    x: Math.round(bounds?.x ?? 0),
    y: Math.round(bounds?.y ?? 0),
    width: Math.round(bounds?.width ?? MINIMAL_BAR.width),
    height: Math.round(bounds?.height ?? MINIMAL_BAR.height),
  };
}
