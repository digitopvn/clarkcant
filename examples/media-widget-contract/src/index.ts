/**
 * @clarkcant/example-media-widget-contract
 *
 * Clearly synthetic media fixture. It exists to prove the rule that one widget instance
 * has at most one live media owner, and that restoring a pinned player does not start
 * playback on its own.
 *
 * @implementation-status stub
 * TODO(P6): the fixture component. The ownership rule it tests is already implemented and
 * tested in `@clarkcant/core` (`claimLiveOwner` refuses a second owner and reports who
 * holds it); what is missing is a component that surfaces it in a UI.
 *
 * This is deliberately **not** a vendor integration. No real SDK, account, DRM or
 * licensing path is involved, and the fixture must stay labelled as synthetic: passing it
 * must never be presented as evidence that a commercial player works.
 */

export const FIXTURE_LABEL = "Synthetic media fixture. No real playback SDK or account is involved.";

export interface MediaFixtureState {
  /** Only one surface may hold this at a time. */
  liveOwnerToken: string | null;
  playing: boolean;
  /** Position survives a pin or unpin so state is preserved rather than restarted. */
  positionSeconds: number;
}

/** What the fixture must demonstrate, one assertion per line. */
export const CONTRACT_ASSERTIONS = [
  "mounting the same instance inline and pinned yields one live owner, not two",
  "restoring a pinned fixture does not autoplay",
  "unpinning preserves position and does not stop a running background job",
  "a second surface can preview read-only while the first owns playback",
] as const;

/**
 * @implementation-status stub
 * TODO(P6): the fixture component.
 */
export const MEDIA_FIXTURE_STATUS = "assertions-declared-component-not-implemented";
