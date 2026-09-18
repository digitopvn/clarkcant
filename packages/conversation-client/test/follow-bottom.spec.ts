import { describe, expect, it } from "vitest";

import { BOTTOM_FOLLOW_SLACK_PX, distanceFromBottom, followsBottom } from "../src/follow-bottom.ts";

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
});
