/**
 * Whether the transcript should follow its own bottom.
 *
 * A streamed answer grows on every delta, and a view that follows it unconditionally takes the page back
 * down each time someone scrolls up to read what came before. That reads as a fight because it is one, and
 * the fix is to treat following as something the reader chooses by being at the bottom rather than as a
 * property of the transcript.
 *
 * The comparison is against a slack rather than zero: a wheel or a trackpad almost never lands exactly at
 * the bottom, and a reader one pixel away from it is reading the newest message, not the previous one.
 */
export const BOTTOM_FOLLOW_SLACK_PX = 48;

/** How far the view is from the bottom, in pixels. Never negative. */
export function distanceFromBottom(metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
	return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

/** Whether a view at this position is close enough to the bottom to be following it. */
export function followsBottom(
	metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
	slack = BOTTOM_FOLLOW_SLACK_PX,
): boolean {
	return distanceFromBottom(metrics) <= slack;
}

type ScrollMetrics = { scrollHeight: number; scrollTop: number; clientHeight: number };

/**
 * How far the transcript has moved each scroller itself, summed: the moves that keep what is on screen in place when the
 * layout changes, never the reader's. Kept by the scroller, so everything that reads its position agrees on them.
 */
const layoutMoves = new WeakMap<object, number>();

/**
 * Record a move of the view that came from the layout rather than from the reader.
 *
 * Rows above the screen shrink - a fold closing, the virtual window's estimates catching up with what was measured - and
 * the transcript scrolls up by as much to keep the row being read where it was, or the browser pulls the view up
 * because there is no longer that much below it. The view goes up, but the reader did not leave the bottom.
 */
export function noteLayoutScroll(node: object, delta: number): void {
	if (delta !== 0) layoutMoves.set(node, (layoutMoves.get(node) ?? 0) + delta);
}

/** What a scroll event said: where the view was, and how far the layout had moved it by then. */
export interface ScrollReport {
	top: number;
	layout: number;
}

export function reportScroll(node: ScrollMetrics & object): ScrollReport {
	return { top: node.scrollTop, layout: layoutMoves.get(node) ?? 0 };
}

/**
 * Whether the reader still follows the bottom when something arrives to follow.
 *
 * `followed` is what the last scroll event said, and `report` where it said the view was. A browser reports a scroll on
 * its next frame, so an answer can be drawn between a scroll and its report: a reader who has just scrolled up, or a
 * focus or `scrollIntoView` that brought an earlier row into view, would be taken back down - and the press they were
 * about to make would land on whatever moved under the pointer. A view that has moved up since the report by more than
 * the slack has left the bottom, whatever the report said.
 *
 * Only the reader's moves count. The moves the layout made since the report (`noteLayoutScroll`) are where the view was
 * expected to be, not a scroll up, and a view still at the bottom has not left it whatever moved it there.
 */
export function stillFollowsBottom(followed: boolean, report: ScrollReport, node: ScrollMetrics & object, slack = BOTTOM_FOLLOW_SLACK_PX): boolean {
	if (!followed) return false;
	if (followsBottom(node, slack)) return true;
	const expectedTop = report.top + (layoutMoves.get(node) ?? 0) - report.layout;
	return expectedTop - node.scrollTop <= slack;
}

/**
 * How the view should travel to the bottom.
 *
 * Following a growing reply moves the view a few lines at a time, and a smooth scroll keeps that easy to read.
 * A longer jump, such as opening a stored conversation from its top, is a change of place rather than a follow:
 * animating it would sweep the whole transcript past the screen, which shows nothing readable and makes every
 * player on the way count as near the viewport, so it reads all of their bytes. Anything further than one
 * screen therefore jumps. A shorter one is "auto", which leaves the stylesheet to decide, so reduced motion
 * still turns the glide off.
 */
export function followScrollBehavior(metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }): "instant" | "auto" {
	return distanceFromBottom(metrics) > metrics.clientHeight ? "instant" : "auto";
}
