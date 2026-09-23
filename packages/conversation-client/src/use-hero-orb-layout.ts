import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "./typewriter.ts";

/** How long each suggestion waits behind the one before it as they leave. */
export const HERO_CHIP_STAGGER_MS = 90;

/**
 * The orb's canvas, which is deliberately larger than the ball drawn inside it.
 *
 * The ball's radius is a fraction of the canvas, so the margin around it is what the pointer's
 * flare and the jelly deformation have to grow into. At 720 pixels the margin was about a hundred
 * pixels a side, and a flare that followed the pointer to the edge was cut off by the canvas — a
 * straight line across a glow that is meant to fade. 960 with a smaller radius keeps the ball
 * exactly the size it was and nearly doubles the room around it.
 */
export const ORB_DRAW_SIZE = 960;

/** The ball's radius as a fraction of the canvas half-height: 0.54 x 960 is the 518 pixel ball. */
export const ORB_RADIUS = 0.54;

/**
 * The orb's diameter once it is docked behind the composer.
 *
 * One reference size for the placement and the room reserved in the transcript, rather than the
 * canvas size: what a reader sees and what the layout has to make space for is the ball, not the
 * buffer.
 */
export const ORB_DOCK_SIZE = 720;

/** Where the orb is drawn, in the shell's own coordinates. */
export interface OrbPlacement {
  x: number;
  y: number;
  /** Drawn at `ORB_DOCK_SIZE` and scaled, so the docked size is the reference. */
  scale: number;
  docked: boolean;
}

export type HeroPhase = "shown" | "leaving" | "gone";

/**
 * Read a motion duration off the document, in milliseconds.
 *
 * Timings belong to the stylesheet, and so does the reduced-motion override: reading the value
 * back means an animation this file drives lasts exactly as long as the one the stylesheet would
 * have run. A second copy of `600` in the TypeScript is how the two come apart, and the symptom is
 * an element that finishes moving before its own fade does.
 */
function motionDurationMs(variable: string, fallbackMs: number): number {
  if (typeof getComputedStyle !== "function") return fallbackMs;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallbackMs;
  return raw.endsWith("ms") ? value : value * 1000;
}

/** The shared easing curve, by the same argument as the durations above. */
function motionEasing(): string {
  if (typeof getComputedStyle !== "function") return "ease";
  return getComputedStyle(document.documentElement).getPropertyValue("--cc-motion-easing").trim() || "ease";
}

export interface HeroOrbLayout {
  heroPhase: HeroPhase;
  /** The element the orb answers pointer movement anywhere inside. */
  shell: React.RefObject<HTMLDivElement | null>;
  /** The space the hero reserves for the orb, which is where the orb measures itself from. */
  heroOrb: React.RefObject<HTMLDivElement | null>;
  composerWrap: React.RefObject<HTMLDivElement | null>;
  orbPlacement: OrbPlacement | undefined;
  heroExitMs: number;
  /** Remember where the composer is, before anything moves it. Call in the same event that changes the layout. */
  rememberComposerTop: () => void;
  /** Start the hero leaving. No-op once it has already started. */
  beginHeroExit: () => void;
  /** Return to the start screen immediately, with the orb returning to the middle. */
  resetHero: () => void;
}

/**
 * The two shapes the interface takes, and the single orb that moves between them.
 *
 * Kept as one hook because the phase, the measurement and the composer's own return animation are
 * three views of one fact: where the layout currently puts the orb. Splitting them further would
 * mean passing the phase and the refs across a hook boundary on every frame that matters, for no
 * reader's benefit.
 *
 * @param messageCount How many stored messages the timeline already has. A conversation that
 *   arrived with messages was never the start screen, so this hook skips the hero entirely for it.
 */
export function useHeroOrbLayout(messageCount: number): HeroOrbLayout {
  const [heroPhase, setHeroPhase] = useState<HeroPhase>("shown");
  const [orbPlacement, setOrbPlacement] = useState<OrbPlacement | undefined>(undefined);
  const shell = useRef<HTMLDivElement>(null);
  const heroOrb = useRef<HTMLDivElement>(null);
  const composerWrap = useRef<HTMLDivElement>(null);
  /**
   * The composer's top edge before the hero left.
   *
   * Read in the same event that starts the exit, because it is the last moment at which the old
   * position still exists: the alternative is measuring after the fact and animating from a value
   * that is no longer anywhere.
   */
  const composerFrom = useRef<number | undefined>(undefined);

  const heroExitMs =
    prefersReducedMotion() ? 0 : motionDurationMs("--cc-motion-exit", 320) + HERO_CHIP_STAGGER_MS * 3;

  const rememberComposerTop = useCallback((): void => {
    const node = composerWrap.current;
    composerFrom.current = node === null ? undefined : node.getBoundingClientRect().top;
  }, []);

  const beginHeroExit = useCallback((): void => {
    if (heroPhase !== "shown") return;
    rememberComposerTop();
    setHeroPhase("leaving");
    window.setTimeout(
      () => setHeroPhase((phase) => (phase === "leaving" ? "gone" : phase)),
      heroExitMs,
    );
  }, [heroExitMs, heroPhase, rememberComposerTop]);

  const resetHero = useCallback((): void => {
    rememberComposerTop();
    setHeroPhase("shown");
  }, [rememberComposerTop]);

  /**
   * Grow the input to fit what is typed into it — see the composer hook for the textarea growth
   * itself; this layout effect replays the composer's move from the middle of the screen to the
   * bottom.
   *
   * The Web Animations API rather than a CSS transition, because the composer has no property to
   * transition — where it sits comes from the document's flow, and the flow changed in one step. A
   * transform from the old position to none is the same movement, and it is applied to an element
   * whose layout position is already final, so nothing else is displaced while it plays.
   */
  useLayoutEffect(() => {
    const node = composerWrap.current;
    const from = composerFrom.current;
    composerFrom.current = undefined;
    if (node === null || from === undefined || prefersReducedMotion()) return;
    const delta = from - node.getBoundingClientRect().top;
    if (Math.abs(delta) < 2) return;
    node.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
      duration: motionDurationMs("--cc-motion-orb", 600),
      easing: motionEasing(),
    });
  }, [heroPhase]);

  /**
   * Keep the orb where the layout says it belongs.
   *
   * The orb is one element that moves between two places, so its position is measured from the
   * thing it belongs to rather than declared in CSS: the hero's reserved space while the start
   * screen is up, and the composer's frame once it is docked. A ResizeObserver rather than a list
   * of events, because what moves it is a change in either of those frames — a font arriving, a
   * chip wrapping, the input growing a line — and a list of causes is a list that goes stale.
   */
  const measureOrb = useCallback((): void => {
    const shellBox = shell.current?.getBoundingClientRect();
    if (shellBox === undefined) return;
    const docked = heroPhase !== "shown";
    const frame = (docked ? composerWrap.current : heroOrb.current)?.getBoundingClientRect();
    if (frame === undefined) return;
    const next: OrbPlacement = docked
      ? {
          x: frame.left + frame.width / 2 - shellBox.left,
          // A third of the orb above the composer's frame, the rest behind it: that is what "the orb
          // sits behind the input" means as a number.
          y: frame.top + ORB_DOCK_SIZE / 6 - shellBox.top,
          scale: 1,
          docked: true,
        }
      : {
          x: frame.left + frame.width / 2 - shellBox.left,
          y: frame.top + frame.height / 2 - shellBox.top,
          // The anchor reserves the space the ball occupies, so the canvas is scaled to that width.
          scale: frame.width / ORB_DRAW_SIZE,
          docked: false,
        };
    // Compared before storing, because this runs on every resize of a frame that moves on nearly
    // every keystroke: a fresh object each time would re-render the conversation per character.
    setOrbPlacement((current) =>
      current !== undefined &&
      Math.abs(current.x - next.x) < 0.5 &&
      Math.abs(current.y - next.y) < 0.5 &&
      current.scale === next.scale
        ? current
        : next,
    );
  }, [heroPhase]);

  useLayoutEffect(() => {
    /*
     * A trailing re-measure, debounced behind whatever just fired.
     *
     * The bounded settle window below assumes every layout-moving event - the readiness fetch that
     * decides whether the setup card is there, the suggestion chips it brings with it, the webfont -
     * lands inside a known number of milliseconds. On a loaded machine it does not: a ResizeObserver
     * callback can catch the anchor mid-move (the frame the card's own entrance transition is still
     * playing in), store that position, and then never fire again because nothing observed changes
     * size after that frame - only position, which ResizeObserver does not report. Without this, that
     * frame is what the orb is stuck at. Debounced rather than fired on every callback, so a burst of
     * resizes settles into one final measurement instead of one per event.
     */
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const measureSoonAndAgain = (): void => {
      measureOrb();
      if (trailing !== undefined) clearTimeout(trailing);
      trailing = setTimeout(() => measureOrb(), 250);
    };
    measureSoonAndAgain();
    window.addEventListener("resize", measureSoonAndAgain);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => measureSoonAndAgain()) : undefined;
    // The hero's own box is observed as well as the reserved space inside it, because what moves
    // the anchor is the text around it growing - the heading arriving with the webfont, the
    // paragraph wrapping - and a resize of the anchor's parent re-measures where the anchor ended
    // up.
    for (const node of [heroOrb.current?.parentElement, heroOrb.current, composerWrap.current]) {
      if (node !== null && node !== undefined && observer !== undefined) observer.observe(node);
    }
    // And again as the layout settles over the first second - the health check returning, the
    // composer's own line arriving - because the first measurement describes the page before any
    // of that. Bounded on purpose: a settle window, not a loop - the trailing re-measure above is
    // what covers whatever lands after this window closes.
    const settleTimers = [0, 50, 150, 400, 900].map((ms) => setTimeout(() => measureSoonAndAgain(), ms));
    // The webfont arrives after the first paint and changes how tall the hero's text is, which
    // moves the reserved space the orb is placed against.
    void document.fonts?.ready.then(() => measureSoonAndAgain());
    return () => {
      for (const timer of settleTimers) clearTimeout(timer);
      if (trailing !== undefined) clearTimeout(trailing);
      observer?.disconnect();
      window.removeEventListener("resize", measureSoonAndAgain);
    };
  }, [measureOrb]);

  /**
   * A conversation that arrived with messages was never the start screen.
   *
   * Loading history is not the hero leaving — nothing was sent — so this skips the exit entirely
   * rather than replaying it for a conversation the user was already in.
   */
  useEffect(() => {
    if (messageCount > 0) setHeroPhase((phase) => (phase === "shown" ? "gone" : phase));
  }, [messageCount]);

  return {
    heroPhase,
    shell,
    heroOrb,
    composerWrap,
    orbPlacement,
    heroExitMs,
    rememberComposerTop,
    beginHeroExit,
    resetHero,
  };
}
