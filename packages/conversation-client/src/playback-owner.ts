/**
 * One active playback owner for the host's own players.
 *
 * A conversation can hold several videos and audio files, and two of them playing over each other is never what
 * the person meant: starting one pauses whichever host player was playing before. Each start also advances a
 * count, so a press of Play that is still waiting for its bytes can tell whether anything else started since.
 */

/** The part of a media element the owner touches. */
export interface PlaybackMedia {
  readonly paused: boolean;
  pause: () => void;
}

export interface PlaybackOwner {
  /**
   * `media` started playing: the previous owner, if it is still playing, is paused.
   *
   * There is no release: a player removed from the page is paused by the browser, and the one reference kept is
   * replaced by the next start.
   */
  claim: (media: PlaybackMedia) => void;
  /** How many starts there have been. A press compares it with what it was when the person pressed. */
  starts: () => number;
}

export function createPlaybackOwner(): PlaybackOwner {
  let owner: PlaybackMedia | undefined;
  let count = 0;
  return {
    claim: (media) => {
      count += 1;
      const previous = owner;
      owner = media;
      if (previous !== undefined && previous !== media && !previous.paused) previous.pause();
    },
    starts: () => count,
  };
}

/** The page's owner: there is one page, so there is one playing player. */
export const playbackOwner: PlaybackOwner = createPlaybackOwner();

/**
 * Whether a press of Play made before the bytes arrived should still start the player once they have.
 *
 * Only while the press is still the person's latest intent: no other host player started since, and the keyboard
 * is still with this player or with nobody (the button they pressed was replaced by the player). A person who moved
 * focus elsewhere, or started something else, gets a paused player rather than one that starts on its own later.
 */
export function pressStillCurrent(input: {
  /** `starts()` when the person pressed Play. */
  pressedAt: number;
  /** `starts()` now. */
  startsNow: number;
  active: Element | null;
  body: Element | null;
  media: Element;
}): boolean {
  if (input.startsNow !== input.pressedAt) return false;
  return input.active === null || input.active === input.body || input.active === input.media;
}
