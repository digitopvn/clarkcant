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

/** Valid window modes. There is no third one: a window is either showing the conversation or the bar. */
export const WINDOW_MODES = Object.freeze(["normal", "compact"]);

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
      return {
        ...state,
        mode: "compact",
        normalBounds: state.bounds,
        // The bar appears where the window already was when that position still fits, and is pulled back into
        // the work area when it does not - a bar off the edge of the screen is a window nobody can reach.
        bounds: fitIntoWorkArea(
          { x: state.bounds.x, y: state.bounds.y, width: MINIMAL_BAR.width, height: MINIMAL_BAR.height },
          state.workArea,
        ),
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
