/**
 * Where the conversation window was when it last closed, so it opens there again.
 *
 * Pure, like `window-mode.mjs`: what to remember and whether a remembered place is still usable are decisions about
 * numbers. Reading and writing the file, and asking Electron for the displays, stay in `main.mjs`.
 *
 * Only the conversation's own size is remembered. The voice bar, the orb and an expanded window are sizes the shell
 * chose, so a window closed in one of them reopens at the size the person had before collapsing it.
 */

/** Version of the remembered shape; a file written by another shape is ignored rather than guessed at. */
export const WINDOW_PLACEMENT_VERSION = 1;

/** Smaller than this was not a conversation window someone chose to keep; the default is better than a sliver. */
export const MIN_REMEMBERED_SIZE = Object.freeze({ width: 480, height: 360 });

/** How much of the top of the window must land on a display: enough to grab and move it. */
const REACHABLE_STRIP = Object.freeze({ width: 120, height: 32 });

/**
 * The shape written to disk for a window about to close.
 *
 * `normalBounds` is the window's size outside maximize and full screen (Electron's `getNormalBounds()`), or the size
 * the window mode remembered while collapsed; `maximized` and `fullScreen` are whether to take that state again after
 * showing. Full screen is what the title bar's own grow button does, so a window closed that way reopens that way.
 *
 * `openedAs` is the remembered size the window was opened with and what the OS actually made of it. On a scaled
 * display those differ by a rounding pixel or two, so a window nobody moved or resized is remembered as it was asked
 * for; otherwise it would grow a little at every launch.
 */
export function placementToRemember({ normalBounds, maximized, fullScreen, openedAs }) {
  const untouched = openedAs !== undefined && sameBounds(normalBounds, openedAs.actual);
  const bounds = untouched ? openedAs.requested : normalBounds;
  return {
    version: WINDOW_PLACEMENT_VERSION,
    bounds: {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    },
    maximized: maximized === true,
    fullScreen: fullScreen === true,
  };
}

/**
 * The place to open the window at, or `undefined` to use the default.
 *
 * A remembered place is used only while it is still reachable: a display that was unplugged, or a resolution that
 * shrank, would otherwise open the window somewhere nobody can see it. Its size is kept within the display it lands
 * on, so a window remembered from a larger screen still fits.
 */
export function restoredPlacement(saved, workAreas) {
  if (saved === null || typeof saved !== "object" || saved.version !== WINDOW_PLACEMENT_VERSION) return undefined;
  const bounds = saved.bounds;
  if (bounds === null || typeof bounds !== "object") return undefined;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return undefined;
  if (width < MIN_REMEMBERED_SIZE.width || height < MIN_REMEMBERED_SIZE.height) return undefined;

  const area = (workAreas ?? []).find((candidate) => overlap(candidate, { x, y, width, height: REACHABLE_STRIP.height }) >= REACHABLE_STRIP.width);
  if (area === undefined) return undefined;

  const fittedWidth = Math.min(Math.round(width), area.width);
  const fittedHeight = Math.min(Math.round(height), area.height);
  return {
    bounds: {
      x: Math.min(Math.max(Math.round(x), area.x), area.x + area.width - fittedWidth),
      y: Math.min(Math.max(Math.round(y), area.y), area.y + area.height - fittedHeight),
      width: fittedWidth,
      height: fittedHeight,
    },
    maximized: saved.maximized === true,
    fullScreen: saved.fullScreen === true,
  };
}

function sameBounds(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** How many pixels of `strip`'s width fall inside `area` on a row of the strip that `area` also covers. */
function overlap(area, strip) {
  const top = Math.max(area.y, strip.y);
  const bottom = Math.min(area.y + area.height, strip.y + strip.height);
  if (bottom <= top) return 0;
  return Math.max(0, Math.min(area.x + area.width, strip.x + strip.width) - Math.max(area.x, strip.x));
}
