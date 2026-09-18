/**
 * How tall the composer's input should be.
 *
 * A textarea that grows is the difference between writing a sentence and writing a paragraph: the
 * one-line field that scrolls internally hides the sentence the user is in the middle of. It grows
 * for two lines, keeps growing to five, and then stops and scrolls — because past that the composer
 * is competing with the conversation it is meant to be about.
 *
 * Pure, and separate from the DOM code that applies it, so the three numbers that matter — the
 * minimum, the maximum and when scrolling starts — are testable without a browser.
 */

/** The ceiling, in lines. */
export const COMPOSER_MAX_LINES = 5;

/**
 * Rounding and sub-pixel layout mean a measured height is rarely exactly the line box's, so a
 * difference smaller than this is not a reason to show a scrollbar.
 */
const SLACK_PX = 1;

export interface ComposerHeight {
  /** The height to apply, in pixels. */
  height: number;
  /** Whether the content is taller than that and therefore needs to scroll. */
  scrolls: boolean;
}

/**
 * Clamp a measured content height to the composer's range.
 *
 * `lineHeight` is passed in rather than assumed: it comes from the computed style, so a host that
 * changes the type scale gets a composer that still fits whole lines instead of one that clips half
 * of the fifth one.
 */
export function composerTextareaHeight(contentHeight: number, lineHeight: number): ComposerHeight {
  // A line height that could not be read — `NaN` from a `normal` keyword, or a negative from a host
  // that overrode it — would make every other number here meaningless. The check is `isFinite`
  // rather than a comparison, because every comparison against `NaN` is false and the value would
  // be carried straight into the height.
  const line = Number.isFinite(lineHeight) ? Math.max(lineHeight, 0) : 0;
  if (line === 0) return { height: Math.max(contentHeight, 1), scrolls: false };

  const height = Math.min(Math.max(contentHeight, line), line * COMPOSER_MAX_LINES);
  return { height, scrolls: contentHeight > height + SLACK_PX };
}
