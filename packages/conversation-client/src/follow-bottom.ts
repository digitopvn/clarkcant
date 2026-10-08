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
 * How far the transcript and the layout have moved each scroller, summed: the moves that keep what is on screen in place
 * when the layout changes, and the transcript's own scrolls to the bottom, never the reader's. Kept by the scroller, so
 * everything that reads its position agrees on them.
 */
const layoutMoves = new WeakMap<object, number>();

/**
 * Record a move of the view that came from the layout rather than from the reader.
 *
 * Rows above the screen shrink - a fold closing, the virtual window's estimates catching up with what was measured - and
 * the transcript scrolls up by as much to keep the row being read where it was, or the browser pulls the view up
 * because there is no longer that much below it. The view goes up, but the reader did not leave the bottom.
 *
 * A glide of the transcript's under way (`scrollAsTranscript`) measures its steps from where the view was when the move
 * came, so the move is not counted again as a step of the glide.
 */
export function noteLayoutScroll(node: object, delta: number): void {
	recordMove(node, delta);
	const glide = glides.get(node);
	if (glide !== undefined) glide.landed += delta;
}

function recordMove(node: object, delta: number): void {
	if (delta !== 0) layoutMoves.set(node, (layoutMoves.get(node) ?? 0) + delta);
}

/** A smooth scroll the transcript started and the view has not finished: where it goes, and how far it has got. */
interface Glide {
	target: number;
	landed: number;
}

/** The transcript's glide under way in each scroller, if any. */
const glides = new WeakMap<object, Glide>();

/**
 * Record the steps of the transcript's glide the view has made since it was last read, as the transcript's moves.
 *
 * A glide only travels towards its target. A view that has moved further that way has made more of it, up to the target,
 * and that part is the transcript's. A view that has moved back the other way has left the glide - the browser ends a
 * smooth scroll when the reader scrolls - and the move back is not recorded, so it counts as the reader's.
 *
 * The glide ends at its target, or where the view can go no further that way: less of the transcript below than when it
 * started, or a target past the true end by less than a device pixel. Otherwise it would never be reached, and the record
 * would outlive the browser's glide.
 *
 * A move along the glide that something else made while it was recorded - the reader scrolling down, a focus, "Jump to
 * latest" - is counted as the glide's, up to its target. That is safe because it is a move down, towards the bottom,
 * which never reads as leaving it: what it can hide is a move of the reader's up by no more than the glide's length, the
 * residual `scrollAsTranscript` names. Any move up of more than a pixel ends the glide, and the layout's moves recorded
 * while it is under way shift where its steps are measured from (`noteLayoutScroll`), so nothing is counted twice.
 */
function landGlide(node: ScrollMetrics & object): void {
	const glide = glides.get(node);
	if (glide === undefined) return;
	const direction = Math.sign(glide.target - glide.landed);
	const travelled = (node.scrollTop - glide.landed) * direction;
	if (travelled < -1) {
		glides.delete(node);
		return;
	}
	const step = Math.min(Math.max(travelled, 0), Math.abs(glide.target - glide.landed)) * direction;
	recordMove(node, step);
	glide.landed += step;
	const end = direction > 0 ? Math.max(0, node.scrollHeight - node.clientHeight) : 0;
	if (Math.abs(glide.target - glide.landed) < 1 || Math.abs(end - glide.landed) < 1) glides.delete(node);
}

/**
 * Scroll the view as the transcript rather than as the reader - to keep the row being read in place, or to follow the
 * bottom - and record the move (`noteLayoutScroll`), so it is not taken for the reader's.
 *
 * Unrecorded, a scroll down to follow the reply would hide a scroll up the reader makes before the browser reports the
 * first one: measured from the last report, the view would not have moved.
 *
 * An instant scroll is recorded whole when the call returns. A smooth one moves the view over the next frames, and each
 * step is recorded as it lands, whenever the view's position is next read (`reportScroll`, `stillFollowsBottom`,
 * `followsAfterScroll`): no step the view has made goes unrecorded. Recording the whole glide up front instead would read
 * the part still to travel as the reader scrolling up.
 *
 * What remains is a reader's scroll up that lands between two reads of the view's position while the glide is under way.
 * The browser shows the reader's move and the glide's steps since the last read as one move: if the steps were the
 * larger, the view is still further along the glide than where it was last read, and the reader's move hides inside
 * them. The exact bound is the moves between those two reads, at most the glide's length: one screen
 * (`followScrollBehavior`). On an idle main thread the position is read every frame, and the hidden part is one frame's
 * step, about a third of the glide at the steepest frame of a Chromium glide. A Chromium smooth scroll runs on the
 * compositor, so a main thread kept busy - likely while a reply streams - lets several of its frames land between two
 * reads, and the hidden part can approach the whole glide.
 *
 * A hidden move is taken for following: when more of the reply arrives before the reader's scroll is reported, the
 * transcript follows it down. That scroll also cancels the rest of the reader's gesture if the browser was still
 * animating it, as it does a wheel's: the reader loses the gesture, not just the hidden step, and has to scroll up again.
 *
 * Any scroll ends a smooth one under way, so a new one records what the last glide made and starts from there.
 */
export function scrollAsTranscript(node: ScrollMetrics & { scrollTo(options: ScrollToOptions): void }, options: ScrollToOptions): void {
	landGlide(node);
	glides.delete(node);
	const from = node.scrollTop;
	node.scrollTo(options);
	recordMove(node, node.scrollTop - from);
	if (options.top === undefined) return;
	const target = Math.min(Math.max(options.top, 0), Math.max(0, node.scrollHeight - node.clientHeight));
	if (Math.abs(target - node.scrollTop) >= 1) glides.set(node, { target, landed: node.scrollTop });
}

/** What a scroll event said: where the view was, and how far the layout had moved it by then. */
export interface ScrollReport {
	top: number;
	layout: number;
}

export function reportScroll(node: ScrollMetrics & object): ScrollReport {
	landGlide(node);
	return { top: node.scrollTop, layout: layoutMoves.get(node) ?? 0 };
}

/** Where the view would be had only the layout and the transcript moved it since the report. */
function expectedTop(report: ScrollReport, node: object): number {
	return report.top + (layoutMoves.get(node) ?? 0) - report.layout;
}

/** Whether the view is no higher than the layout and the transcript alone would have put it since the report. */
function readerStayed(report: ScrollReport, node: ScrollMetrics & object): boolean {
	return expectedTop(report, node) - node.scrollTop < 1;
}

/**
 * Whether the reader follows the bottom, read as a scroll event arrives, against the report before it.
 *
 * A view at the bottom follows it, whoever brought it there. A view above the bottom follows it only if it was following
 * and nothing but the transcript and the layout has moved it since: a step of the transcript's glide reported after more
 * of the reply landed below puts the view far from the new bottom, but the reader did not leave it. Any scroll up of the
 * reader's own stops the following, however small: the slack is for where a reader stops at the bottom, not for how far
 * they may scroll away from it.
 */
export function followsAfterScroll(followed: boolean, report: ScrollReport, node: ScrollMetrics & object): boolean {
	landGlide(node);
	if (followsBottom(node)) return true;
	return followed && readerStayed(report, node);
}

/**
 * Whether the reader still follows the bottom when something arrives to follow.
 *
 * `followed` is what the last scroll event said, and `report` where it said the view was. A browser reports a scroll on
 * its next frame, so an answer can be drawn between a scroll and its report: a reader who has just scrolled up, or a
 * focus or `scrollIntoView` that brought an earlier row into view, would be taken back down - and the press they were
 * about to make would land on whatever moved under the pointer. A view above the bottom that has moved up since the
 * report has left the bottom, whatever the report said.
 *
 * Only the reader's moves count. The moves the layout and the transcript made since the report (`noteLayoutScroll`,
 * `scrollAsTranscript`) are where the view was expected to be, not a scroll up or down, and a view still at the bottom
 * has not left it whatever moved it there.
 *
 * Above the bottom this asks what `followsAfterScroll` asks once the scroll is reported: any move up of the reader's own,
 * however small, has left the bottom. The slack is for where a reader stops at the bottom, so it is not a distance a
 * scroll not yet reported may travel while the view is held above the bottom - by more of the reply landing below, or by
 * the transcript's glide still on its way down to it.
 */
export function stillFollowsBottom(followed: boolean, report: ScrollReport, node: ScrollMetrics & object, slack = BOTTOM_FOLLOW_SLACK_PX): boolean {
	landGlide(node);
	if (!followed) return false;
	if (followsBottom(node, slack)) return true;
	return readerStayed(report, node);
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
