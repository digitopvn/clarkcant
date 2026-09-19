import { describe, expect, it } from "vitest";

import { isMotionDuration, motion, motionCss, reducedMotionIsStill, type MotionKind } from "../src/motion.ts";
import { MOTION, MOTION_REDUCED } from "../src/tokens.ts";

/**
 * The four motions.
 *
 * These tests are the design rules written down where they can fail. A helper module is only worth having if it
 * makes the wrong thing impossible, so most of what follows asserts a refusal: no `all`, no layout property, no
 * bounce where content is being read, no duration that is not a token, and a reduced-motion path that removes the
 * animation rather than shortening it.
 */

const KINDS: MotionKind[] = ["press", "release", "panel", "popover"];

describe("what the helpers animate", () => {
  it("never animates everything", () => {
    for (const kind of KINDS) {
      // `transition: all` animates layout and colour together, which is how a deliberate state change becomes jank.
      expect(motion(kind, { reducedMotion: false }).property).not.toContain("all");
    }
  });

  it("only animates the two properties that do not force a layout", () => {
    for (const kind of KINDS) {
      for (const property of motion(kind, { reducedMotion: false }).property) {
        expect(["transform", "opacity"]).toContain(property);
      }
    }
  });

  it("cannot be pointed at text, because no text property is in the set", () => {
    const properties = new Set(KINDS.flatMap((kind) => [...motion(kind, { reducedMotion: false }).property]));

    // The rule is about body text: a bounce or a fade on the thing somebody is reading. There is no way to reach
    // font-size, colour or letter-spacing through these helpers.
    for (const forbidden of ["font-size", "color", "background-color", "letter-spacing", "height", "width"]) {
      expect(properties.has(forbidden)).toBe(false);
    }
  });
});

describe("the mild bounce", () => {
  it("is used for the gestures and for the panel", () => {
    for (const kind of ["press", "release", "panel"] as const) {
      expect(motion(kind, { reducedMotion: false }).easing).toBe(MOTION.bounce);
    }
  });

  it("is not used for a popover, which settles where it arrives", () => {
    // Overshoot on a container holding content makes the content arrive somewhere other than where it ends up.
    expect(motion("popover", { reducedMotion: false }).easing).toBe(MOTION.easing);
  });
});

describe("durations", () => {
  it("are all tokens, never written into a component", () => {
    for (const kind of KINDS) {
      const declaration = motion(kind, { reducedMotion: false });
      expect(isMotionDuration(declaration.duration), `${kind} used ${declaration.duration}`).toBe(true);
    }
  });

  it("make a press the shortest motion and a panel the longest", () => {
    // A press is feedback for something the user is already doing; a panel is the one they are meant to notice.
    const press = Number.parseInt(motion("press", { reducedMotion: false }).duration, 10);
    const panel = Number.parseInt(motion("panel", { reducedMotion: false }).duration, 10);
    const popover = Number.parseInt(motion("popover", { reducedMotion: false }).duration, 10);

    expect(press).toBeLessThan(popover);
    expect(popover).toBeLessThan(panel);
  });
});

describe("reduced motion", () => {
  it("removes the animation rather than shortening it", () => {
    for (const kind of KINDS) {
      const declaration = motion(kind, { reducedMotion: true });

      expect(reducedMotionIsStill(declaration.duration)).toBe(true);
      // Linear, so there is no curve left to overshoot with.
      expect(declaration.easing).toBe(MOTION_REDUCED.easing);
    }
  });

  it("has a counterpart for every full-motion token, so nothing silently keeps its full value", () => {
    /*
     * The failure this guards is quiet: a key present in the full set and missing from the reduced one does not
     * break the build, it just keeps animating for the people who asked it not to.
     */
    expect(Object.keys(MOTION_REDUCED).sort()).toEqual(Object.keys(MOTION).sort());
  });

  it("does not leave a non-zero duration behind", () => {
    for (const value of Object.values(MOTION_REDUCED)) {
      if (value.endsWith("ms")) expect(value).toBe("0ms");
    }
  });
});

describe("the CSS form", () => {
  it("emits the three transition properties and nothing else", () => {
    const css = motionCss("panel", { reducedMotion: false });

    expect(css).toContain("transition-property: transform, opacity;");
    expect(css).toContain(`transition-duration: ${MOTION.panel};`);
    expect(css).toContain(`transition-timing-function: ${MOTION.bounce};`);
    expect(css).not.toContain("all");
  });

  it("emits a zero duration under reduced motion", () => {
    expect(motionCss("press", { reducedMotion: true })).toContain("transition-duration: 0ms;");
  });
});
