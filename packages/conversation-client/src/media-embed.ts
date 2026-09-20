/**
 * The vendor embed URL for a restored media surface.
 *
 * A pin restores a surface, not a session. The position is carried in the vendor's own `start` parameter, because
 * the embed is the vendor's player and the only way to reopen it where it stopped is to ask it to — which is what
 * `restorePinnedInstance` returns the position for.
 *
 * Autoplay is never added, and that is the point of this function existing rather than a template string in the
 * renderer. Starting playback because a panel re-entered the viewport is the behaviour people describe as "it just
 * started playing by itself", so the URL that reopens a player must be unable to ask for it: there is no parameter
 * here that could turn it on.
 */

export const MEDIA_EMBED_STATUS = "vendor-url-built-without-autoplay";

export interface MediaEmbedInput {
  videoId: string;
  /** Where playback stopped. Fractional seconds are floored: a player takes whole seconds. */
  positionSeconds: number;
}

/**
 * The embed URL, with the position when there is one.
 *
 * A position of zero, a negative one or a non-finite one is left off rather than sent: `start=0` is not wrong so
 * much as noise, and `start=NaN` is a URL that would make the vendor's player behave unpredictably.
 */
export function vendorEmbedUrl(input: MediaEmbedInput): string {
  const seconds = Math.floor(input.positionSeconds);
  const resume = Number.isFinite(seconds) && seconds > 0 ? `?start=${String(seconds)}` : "";
  return `https://www.youtube-nocookie.com/embed/${input.videoId}${resume}`;
}
