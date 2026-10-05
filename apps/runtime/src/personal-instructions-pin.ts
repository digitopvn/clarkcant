/**
 * The personal instructions each session's next run is given, as the send boundary checked them for its model.
 *
 * The preference is read once per send, checked with everything else that send carries, and pinned here under the
 * session it is about to prompt; the adapter appends the pinned value and never reads the preference itself, so the
 * check and the send see the same text. A session with nothing pinned is given none. Bounded: the oldest pins go first,
 * and a session whose pin went is given no instructions rather than unchecked ones.
 */
export interface PersonalInstructionsPin {
  /** Pin the checked value for a session; `undefined` pins "none". */
  pin: (sessionId: string, text: string | undefined) => void;
  /** What a session's run is given: the pinned value, or none when nothing is pinned for it. */
  get: (sessionId: string | undefined) => string | undefined;
  /** Let a disposed session's pin go. */
  forget: (sessionId: string) => void;
}

export function createPersonalInstructionsPin(limit = 256): PersonalInstructionsPin {
  const pinned = new Map<string, string | undefined>();
  return {
    pin: (sessionId, text) => {
      // Re-inserted, so the order is last-pinned and the oldest is evicted first.
      pinned.delete(sessionId);
      pinned.set(sessionId, text);
      while (pinned.size > limit) {
        const oldest = pinned.keys().next();
        if (oldest.done === true) break;
        pinned.delete(oldest.value);
      }
    },
    get: (sessionId) => (sessionId === undefined ? undefined : pinned.get(sessionId)),
    forget: (sessionId) => {
      pinned.delete(sessionId);
    },
  };
}
