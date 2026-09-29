import type { NodeServices } from "../services.ts";

/**
 * A frame-grant lifetime a browser journey can shorten.
 *
 * A widget frame's URL carries a grant that lasts five minutes, and the journey that matters is what a kept frame does
 * after it has lapsed. Waiting five minutes in a browser test is not a test anybody runs, so this holds a shorter
 * lifetime for the grants the node mints next. It holds nothing else: the grant is still signed and verified by the
 * production code, against the real clock.
 *
 * Loaded only through `bootstrap/fixtures.ts`, and only when `CC_FRAME_GRANT_FIXTURE=1`. The route that sets it
 * refuses a lifetime longer than the production one, and the mint takes the shorter of the two as well.
 */
export function createFrameGrantFixture(): NonNullable<NodeServices["frameGrantFixture"]> {
  let lifetimeMs: number | undefined;
  return {
    lifetimeMs: () => lifetimeMs,
    setLifetimeMs: (next) => {
      lifetimeMs = next;
    },
  };
}
