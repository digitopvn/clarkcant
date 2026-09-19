import { motionFor, MOTION, MOTION_REDUCED } from "./tokens.ts";

/**
 * The four motions the interface actually has, as shared helpers.
 *
 * A component that writes its own transition is a component that will eventually write `transition: all`, or a
 * duration nobody chose, or a bounce on body text. The rules are already in AGENTS.md; this module is where they
 * become the only way to do it.
 *
 * Three decisions are encoded here rather than left to callers:
 *
 * **Only `transform` and `opacity` are animated.** Those are the two properties a browser can animate without
 * laying the page out again, and a panel that animates its height makes everything below it move — which is the
 * layout jank the design rules forbid. It also means these helpers cannot be pointed at text: there is no
 * `font-size` or `color` in the set.
 *
 * **The mild bounce is for press, release and panel only.** Overshoot is what makes a press feel like a press; on
 * anything the user is reading it reads as a toy, and on a popover it makes the content arrive somewhere other
 * than where it settles.
 *
 * **Reduced motion comes from the reduced token set, not from a multiplier.** Multiplying by zero still leaves a
 * transition that fires events, and the design rules are explicit that a zero-duration infinite animation is a bug
 * rather than an implementation of reduced motion. `motionFor` is the single place that decides.
 */

export type MotionKind = "press" | "release" | "panel" | "popover";

export interface MotionDeclaration {
  /** Always a subset of `transform` and `opacity`; never `all`, never a layout property. */
  property: readonly string[];
  duration: string;
  easing: string;
}

/**
 * Which token each motion uses.
 *
 * `press` is the shortest because it is feedback for something the user is already doing; `panel` is the longest
 * because it is the one a user is meant to notice arriving.
 */
const KIND_TOKENS: Record<MotionKind, { duration: keyof typeof MOTION; easing: "easing" | "bounce"; property: readonly string[] }> = {
  press: { duration: "micro", easing: "bounce", property: ["transform", "opacity"] },
  release: { duration: "micro", easing: "bounce", property: ["transform", "opacity"] },
  panel: { duration: "panel", easing: "bounce", property: ["transform", "opacity"] },
  // No bounce: a popover that overshoots arrives somewhere other than where it settles, and it holds content
  // rather than being a gesture the user just made.
  popover: { duration: "normal", easing: "easing", property: ["opacity", "transform"] },
};

export function motion(kind: MotionKind, options: { reducedMotion: boolean }): MotionDeclaration {
  const tokens = motionFor(options.reducedMotion);
  const spec = KIND_TOKENS[kind];
  return {
    property: spec.property,
    duration: tokens[spec.duration],
    easing: tokens[spec.easing],
  };
}

/** The declaration as CSS, so a stylesheet can use it without restating the values. */
export function motionCss(kind: MotionKind, options: { reducedMotion: boolean }): string {
  const declaration = motion(kind, options);
  return (
    `transition-property: ${declaration.property.join(", ")}; ` +
    `transition-duration: ${declaration.duration}; ` +
    `transition-timing-function: ${declaration.easing};`
  );
}

/**
 * Whether a duration is one of the motion tokens.
 *
 * Exported so a test can hold the stylesheet to it: a duration written into a component is the drift this module
 * exists to prevent, and the check needs to run against the real tokens rather than a copy of them.
 */
export function isMotionDuration(value: string): boolean {
  return Object.values(MOTION).includes(value as never) || Object.values(MOTION_REDUCED).includes(value as never);
}

/**
 * Whether reduced motion removes the animation rather than shortening it.
 *
 * A zero duration is correct here and only here: it is what the reduced set declares for every key, and the test
 * beside it asserts that every key has a counterpart so nothing silently keeps its full-motion value.
 */
export function reducedMotionIsStill(value: string): boolean {
  return value === MOTION_REDUCED.micro;
}
