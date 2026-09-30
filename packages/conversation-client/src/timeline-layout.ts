/**
 * The activity timeline's keyboard and paging rules, kept apart from the component so they can be tested without a DOM.
 *
 * The entries of the page on screen are one list with one tab stop: Up and Down (or Left and Right) move between them,
 * Home and End go to the first and the last, and the entry that holds the tab stop is the one last focused, else the
 * selected one, else the first.
 */

/** Where a key moves focus in a list of `count` entries, or `undefined` for a key that does not move it or at either end. */
export function moveTimelineFocus(key: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  if (key === "ArrowDown" || key === "ArrowRight") return index + 1 < count ? index + 1 : undefined;
  if (key === "ArrowUp" || key === "ArrowLeft") return index > 0 ? index - 1 : undefined;
  if (key === "Home") return index === 0 ? undefined : 0;
  if (key === "End") return index === count - 1 ? undefined : count - 1;
  return undefined;
}

/** The one entry on the page that takes the tab stop: the one last focused, else the selected one, else the first. */
export function timelineTabStop(pageIds: readonly string[], focusedId: string | undefined, selectedId: string | undefined): string | undefined {
  if (focusedId !== undefined && pageIds.includes(focusedId)) return focusedId;
  if (selectedId !== undefined && pageIds.includes(selectedId)) return selectedId;
  return pageIds[0];
}

/** What pressing an entry selects: the entry, or nothing when it was already the selected one. */
export function timelineToggle(selectedId: string | undefined, entryId: string): string | undefined {
  return selectedId === entryId ? undefined : entryId;
}

/** The page shown after a move, kept within the timeline's pages. */
export function clampTimelinePage(page: number, pageCount: number): number {
  return Math.min(Math.max(0, Math.trunc(page)), Math.max(0, pageCount - 1));
}

/** How long a description may be before it opens folded, with a control to show the rest. */
export const TIMELINE_FOLD_CHARS = 160;
const TIMELINE_FOLD_LINES = 3;

/** Whether a description is long enough, in characters or in lines, to open folded. */
export function timelineDescriptionFolds(description: string | undefined): boolean {
  if (description === undefined) return false;
  return description.length > TIMELINE_FOLD_CHARS || description.split("\n").length > TIMELINE_FOLD_LINES;
}

/** The folded description: its first lines, cut to the fold length at a word where one is near. */
export function foldedTimelineDescription(description: string): string {
  const lines = description.split("\n").slice(0, TIMELINE_FOLD_LINES).join("\n");
  if (lines.length <= TIMELINE_FOLD_CHARS && lines.length < description.length) return `${lines.trimEnd()}…`;
  if (lines.length <= TIMELINE_FOLD_CHARS) return lines;
  // Cut by code point, so a character outside the Basic Multilingual Plane is never split into half a pair.
  const cut = Array.from(lines).slice(0, TIMELINE_FOLD_CHARS).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > TIMELINE_FOLD_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
