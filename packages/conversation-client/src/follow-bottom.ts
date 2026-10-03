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
