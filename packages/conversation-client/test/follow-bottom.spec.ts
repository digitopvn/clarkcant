import { describe, expect, it } from "vitest";

import {
  BOTTOM_FOLLOW_SLACK_PX,
  distanceFromBottom,
  followScrollBehavior,
  followsAfterScroll,
  followsBottom,
  noteLayoutScroll,
  reportScroll,
  scrollAsTranscript,
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

  /** A view whose scroll lands at once, as an instant one does, or not yet, as a smooth one has not on the call. */
  const scrollable = (top: number, lands: boolean): ReturnType<typeof view> & { scrollTo(options: ScrollToOptions): void } => {
    const node = {
      ...view(top),
      scrollTo(options: ScrollToOptions): void {
        if (lands) node.scrollTop = Math.min(options.top ?? node.scrollTop, node.scrollHeight - node.clientHeight);
      },
    };
    return node;
  };

  it("sees a reader's scroll up right after the transcript's own scroll down to follow the reply", () => {
    // Reported at the bottom; the reply grows by 400px and the transcript follows it down, then the reader scrolls up by
    // as much, all before the browser reports either move. Measured from the report, the view did not move.
    const node = scrollable(1400, true);
    const report = reportScroll(node);
    node.scrollHeight = 2400;
    scrollAsTranscript(node, { top: node.scrollHeight, behavior: "instant" });
    expect(node.scrollTop).toBe(1800);
    expect(stillFollowsBottom(true, report, node)).toBe(true);
    node.scrollTop -= 400;
    expect(stillFollowsBottom(true, report, node)).toBe(false);
  });

  it("records only the part of its own scroll the view has made, so a glide still under way is not counted", () => {
    const node = scrollable(1400, false);
    const report = reportScroll(node);
    node.scrollHeight = 2400;
    scrollAsTranscript(node, { top: node.scrollHeight, behavior: "smooth" });
    // The view has not moved yet: counting the whole glide would read the view as far above where it was expected.
    expect(stillFollowsBottom(true, report, node)).toBe(true);
  });

  it("records each step of its glide as it lands, so a reader's scroll up after a step is seen", () => {
    // Reported at the bottom; the reply grows by 400px and the transcript glides down to it. A step of 300px lands and is
    // read before the browser reports it, then the reader scrolls up by 100px, ending the glide.
    const node = scrollable(1400, false);
    const report = reportScroll(node);
    node.scrollHeight = 2400;
    scrollAsTranscript(node, { top: node.scrollHeight, behavior: "smooth" });
    node.scrollTop = 1700;
    expect(stillFollowsBottom(true, report, node)).toBe(true);
    node.scrollTop = 1600;
    // Measured from the report alone the view moved 200px down; the glide took it 300px, so the reader moved up 100px.
    expect(stillFollowsBottom(true, report, node)).toBe(false);
  });

  it("nets a reader's scroll up against a glide step that lands in the same frame, hiding no more than the step", () => {
    // Read only once both moves have landed: a 300px step and the reader's scroll up of 400px, which ends the glide.
    const node = scrollable(1400, false);
    const report = reportScroll(node);
    node.scrollHeight = 2400;
    scrollAsTranscript(node, { top: node.scrollHeight, behavior: "smooth" });
    node.scrollTop = 1400 + 300 - 400;
    expect(stillFollowsBottom(true, report, node)).toBe(false);
    expect(followsAfterScroll(true, report, node)).toBe(false);
  });

  it("does not count the glide past its target, or a reader's scroll on from there", () => {
    const node = scrollable(1400, false);
    const report = reportScroll(node);
    node.scrollHeight = 2400;
    scrollAsTranscript(node, { top: node.scrollHeight, behavior: "smooth" });
    // The glide arrived at 1800; more of the reply landed and the reader scrolled up by 100px from the glide's end.
    node.scrollTop = 1800;
    expect(reportScroll(node).top).toBe(1800);
    node.scrollHeight = 3000;
    node.scrollTop = 1700;
    expect(followsAfterScroll(true, report, node)).toBe(false);
  });

  it("keeps following when a step of its own glide is reported after more of the reply landed below", () => {
    // The glide is still on its way when the reply grows again: the step's report puts the view far from the new bottom.
    const node = scrollable(1400, false);
    const report = reportScroll(node);
    node.scrollHeight = 2400;
    scrollAsTranscript(node, { top: node.scrollHeight, behavior: "smooth" });
    node.scrollHeight = 2530;
    node.scrollTop = 1402;
    expect(followsAfterScroll(true, report, node)).toBe(true);
    // A reader who was not following is not made to.
    expect(followsAfterScroll(false, report, node)).toBe(false);
  });

  it("keeps following when the transcript held the row being read in place, and the reply grew below", () => {
    const node = view(1400);
    const report = reportScroll(node);
    node.scrollTop -= 300;
    noteLayoutScroll(node, -300);
    node.scrollHeight += 400;
    expect(followsAfterScroll(true, report, node)).toBe(true);
  });

  it("stops following on a reported scroll up of the reader's own, however small, once the view is above the bottom", () => {
    const node = view(1400);
    const report = reportScroll(node);
    node.scrollHeight = 2400;
    node.scrollTop = 1390;
    expect(followsAfterScroll(true, report, node)).toBe(false);
    // At the bottom, a reader follows it whatever brought them there.
    node.scrollTop = 1800 - BOTTOM_FOLLOW_SLACK_PX;
    expect(followsAfterScroll(false, reportScroll(node), node)).toBe(true);
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