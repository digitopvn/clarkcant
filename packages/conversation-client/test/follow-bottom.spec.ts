import { describe, expect, it } from "vitest";

import { BOTTOM_FOLLOW_SLACK_PX, distanceFromBottom, followScrollBehavior, followsBottom, stillFollowsBottom } from "../src/follow-bottom.ts";

describe("following the bottom of the transcript", () => {
  it("measures how far the view is from the bottom", () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 600 })).toBe(0);
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 600 })).toBe(300);
  });

  it("never reports a negative distance, because overscroll is not a position above the bottom", () => {
    // Elastic scrolling and a shrinking transcript both produce a scrollTop past the end, and a negative
    // distance would read as "further from the bottom than the whole view", which is nonsense.
    expect(distanceFromBottom({ scrollHeight: 600, scrollTop: 700, clientHeight: 600 })).toBe(0);
  });

  it("follows from the bottom and from just short of it", () => {
    expect(followsBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 600 })).toBe(true);
    // A wheel or a trackpad almost never lands exactly at the bottom, and a reader within the slack is
    // reading the newest message rather than the previous one.
    expect(followsBottom({ scrollHeight: 1000, scrollTop: 400 - BOTTOM_FOLLOW_SLACK_PX, clientHeight: 600 })).toBe(true);
  });

  it("stops following once the reader is meaningfully above the bottom", () => {
    expect(followsBottom({ scrollHeight: 1000, scrollTop: 400 - BOTTOM_FOLLOW_SLACK_PX - 1, clientHeight: 600 })).toBe(false);
    expect(followsBottom({ scrollHeight: 1000, scrollTop: 0, clientHeight: 600 })).toBe(false);
  });

  it("takes the slack as a parameter, so one place decides how close counts", () => {
    const metrics = { scrollHeight: 1000, scrollTop: 300, clientHeight: 600 };
    expect(followsBottom(metrics, 100)).toBe(true);
    expect(followsBottom(metrics, 10)).toBe(false);
  });

  it("glides while following a reply, and jumps when the bottom is more than a screen away", () => {
    // A few new lines follow the stylesheet's own behaviour, smooth unless reduced motion turns it off.
    expect(followScrollBehavior({ scrollHeight: 1100, scrollTop: 400, clientHeight: 600 })).toBe("auto");
    expect(followScrollBehavior({ scrollHeight: 1600, scrollTop: 400, clientHeight: 600 })).toBe("auto");
    // Opening a stored conversation from its top would otherwise sweep every player past the screen.
    expect(followScrollBehavior({ scrollHeight: 1601, scrollTop: 400, clientHeight: 600 })).toBe("instant");
    expect(followScrollBehavior({ scrollHeight: 9000, scrollTop: 0, clientHeight: 600 })).toBe("instant");
  });

  it("leaves a reader who scrolled up before the browser reported it where they are", () => {
    // The last report said the bottom, at 400; the view is now far above it, and the report of that scroll is still to come.
    expect(stillFollowsBottom(true, 400, 0)).toBe(false);
    expect(stillFollowsBottom(true, 400, 400 - BOTTOM_FOLLOW_SLACK_PX - 1)).toBe(false);
  });

  it("keeps following when the view has not moved up since the report, or moved down to follow", () => {
    expect(stillFollowsBottom(true, 400, 400)).toBe(true);
    // A small nudge stays within the slack, the same as a position just short of the bottom.
    expect(stillFollowsBottom(true, 400, 400 - BOTTOM_FOLLOW_SLACK_PX)).toBe(true);
    // Following a growing transcript moves the view down.
    expect(stillFollowsBottom(true, 400, 900)).toBe(true);
    // A reader who was not following is not made to by anything here.
    expect(stillFollowsBottom(false, 400, 400)).toBe(false);
  });
});
