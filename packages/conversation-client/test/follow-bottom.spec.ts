import { describe, expect, it } from "vitest";

import {
  BOTTOM_FOLLOW_SLACK_PX,
  distanceFromBottom,
  followScrollBehavior,
  followsBottom,
  noteLayoutScroll,
  reportScroll,
  stillFollowsBottom,
} from "../src/follow-bottom.ts";

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

  /** A transcript 2000px tall in a 600px view, at `top`. */
  const view = (top: number, scrollHeight = 2000): { scrollHeight: number; scrollTop: number; clientHeight: number } => ({
    scrollHeight,
    scrollTop: top,
    clientHeight: 600,
  });

  it("leaves a reader who scrolled up before the browser reported it where they are", () => {
    // The last report said the bottom, at 1400; the view is now above it, and the report of that scroll is still to come.
    const node = view(1400);
    const report = reportScroll(node);
    node.scrollTop = 0;
    expect(stillFollowsBottom(true, report, node)).toBe(false);
    node.scrollTop = 1400 - BOTTOM_FOLLOW_SLACK_PX - 1;
    expect(stillFollowsBottom(true, report, node)).toBe(false);
  });

  it("keeps following when the view has not moved up since the report, or moved down to follow", () => {
    const node = view(1400);
    const report = reportScroll(node);
    // Something arrived below: the view is further from the bottom, but it did not move.
    node.scrollHeight = 2600;
    expect(stillFollowsBottom(true, report, node)).toBe(true);
    // A small nudge stays within the slack, the same as a position just short of the bottom.
    node.scrollTop = 1400 - BOTTOM_FOLLOW_SLACK_PX;
    expect(stillFollowsBottom(true, report, node)).toBe(true);
    // Following a growing transcript moves the view down.
    node.scrollTop = 1900;
    expect(stillFollowsBottom(true, report, node)).toBe(true);
    // A reader who was not following is not made to by anything here.
    expect(stillFollowsBottom(false, report, node)).toBe(false);
  });

  it("does not take a move the layout made for the reader leaving the bottom", () => {
    // Rows above the view shrink by 500px and the transcript scrolls up as much to keep the row being read in place,
    // then more of the reply arrives, all before the browser reports the move.
    const node = view(1400);
    const report = reportScroll(node);
    node.scrollHeight -= 500;
    node.scrollTop -= 500;
    noteLayoutScroll(node, -500);
    node.scrollHeight += 300;
    expect(stillFollowsBottom(true, report, node)).toBe(true);
  });

  it("still sees the reader's own scroll up on top of a move the layout made", () => {
    const node = view(1400);
    const report = reportScroll(node);
    node.scrollHeight -= 500;
    node.scrollTop -= 500;
    noteLayoutScroll(node, -500);
    node.scrollTop -= BOTTOM_FOLLOW_SLACK_PX + 1;
    node.scrollHeight += 300;
    expect(stillFollowsBottom(true, report, node)).toBe(false);
  });

  it("counts only the layout's moves since the report", () => {
    const node = view(1400);
    noteLayoutScroll(node, -500);
    // Reported after that move: the view is where the reader put it, and a scroll up from there is theirs.
    node.scrollTop = 900;
    const report = reportScroll(node);
    node.scrollTop = 400;
    expect(stillFollowsBottom(true, report, node)).toBe(false);
  });

  it("keeps following a view that is still at the bottom, whatever moved it there", () => {
    // Less below the view: the browser pulls it up to the new bottom, a move nothing here was told about.
    const node = view(1400);
    const report = reportScroll(node);
    node.scrollHeight = 1200;
    node.scrollTop = 600;
    expect(stillFollowsBottom(true, report, node)).toBe(true);
  });

  it("keeps the layout's moves of one scroller apart from another's", () => {
    const one = view(1400);
    const other = view(1400);
    const report = reportScroll(other);
    noteLayoutScroll(one, -500);
    other.scrollTop = 900;
    other.scrollHeight = 2300;
    expect(stillFollowsBottom(true, report, other)).toBe(false);
  });
});