import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type RefObject } from "react";

import { createOrbRenderer, orbPointerFromClient, type OrbOptions, type OrbPointerRect, type OrbPointerSample } from "./orb.ts";
import { readDocumentTheme, subscribeToDocumentTheme } from "./theme.ts";

/**
 * The orb.
 *
 * A canvas with the shader renderer attached, and the housekeeping that a canvas needs to be a
 * good citizen:
 *
 *   - it stops drawing when it is not on screen, because an animation nobody can see is a battery
 *     being spent for nothing;
 *   - it honours `prefers-reduced-motion` by drawing one frame and stopping, because an animated
 *     glow is exactly the kind of decoration that setting exists to turn off;
 *   - it renders a static fallback when WebGL is unavailable, rather than an empty box.
 *
 * The fallback is the element's own gradient background, which is why the class stays on the
 * canvas: with WebGL the canvas paints over it, and without WebGL it is what the user sees.
 */

export interface OrbProps extends OrbOptions {
  /** Rendered size. The orb is round, so this is both width and height. */
  size: number;
  /** Class applied alongside the orb's own, for the fallback background and layout. */
  className?: string;
  /** Describes the orb for a screen reader, which otherwise reads an empty canvas. */
  label?: string;
  /**
   * Element whose pointer movement the orb answers to.
   *
   * A ref rather than the orb's own listeners because the orb is not always reachable: docked behind
   * the composer it is covered by the input, so the movement that should light it up happens over
   * the composer instead. Given the surface the whole orb lives in, the reaction is a function of
   * how close the pointer is rather than of which element it is over, and it is correct in both
   * placements.
   */
  pointerTarget?: RefObject<HTMLElement | null>;
}

/**
 * Parse a CSS colour into the 0..1 triple the shader expects.
 *
 * Handles the two forms the token sheet actually emits. Returning undefined for anything else is
 * deliberate: a colour the shader cannot read should fall back to the orb's own default rather
 * than to black, which would show as a dark square over a light page.
 */
function parseCssColor(value: string): readonly number[] | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const digits = hex[1] ?? "";
    const pairs =
      digits.length === 3
        ? [...digits].map((digit) => `${digit}${digit}`)
        : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
    return pairs.map((pair) => Number.parseInt(pair, 16) / 255);
  }

  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value);
  if (fn !== null) {
    return [fn[1], fn[2], fn[3]].map((part) => (Number.parseFloat(part ?? "0") || 0) / 255);
  }

  return undefined;
}

/**
 * The page's own background, so the orb's square canvas does not sit on top of it as a visible
 * rectangle. Read rather than hardcoded, and re-read whenever the theme changes, because a colour
 * captured at mount becomes the previous theme's colour the moment someone switches.
 */
function readCanvasColor(): readonly number[] | undefined {
  if (typeof getComputedStyle !== "function") return undefined;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--cc-canvas").trim();
  return raw === "" ? undefined : parseCssColor(raw);
}

export function Orb({ size, className, label, pointerTarget, ...options }: OrbProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  /*
   * The orb's background is baked into the renderer when it is created, and the renderer has no
   * setter for it, so a theme change has to recreate it. This dependency is what makes that happen;
   * without it the canvas keeps painting the old background and its edges become visible.
   */
  const theme = useSyncExternalStore(subscribeToDocumentTheme, readDocumentTheme, () => "dark" as const);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const canvasColor = readCanvasColor();
    const created = createOrbRenderer(canvas, {
      ...options,
      // The page background wins over the orb's own default, so the canvas edge is invisible.
      ...(canvasColor === undefined ? {} : { palette: { ...options.palette, canvas: canvasColor } }),
    });
    if (!created.ok) {
      // Reported rather than swallowed: a caller that wants to know why there is no orb should be
      // able to find out, and the fallback is visible either way.
      setFailed(created.reason);
      return;
    }

    const renderer = created.renderer;
    renderer.resize();

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frameHandle = 0;
    let visible = true;

    /*
     * Pointer tracking.
     *
     * The sample is a plain value updated by the listener and consumed once per frame, so no React
     * state is involved: a mouse crossing the orb at 120 Hz would otherwise re-render the whole
     * conversation a hundred times a second to move a highlight.
     */
    const target = pointerTarget?.current ?? null;
    let sample: OrbPointerSample = { x: 0, y: 0, strength: 0 };
    let rect: OrbPointerRect = { left: 0, top: 0, width: 0, height: 0 };
    let rectStale = true;
    let rectReadAt = 0;

    const readRect = (): void => {
      const box = canvas.getBoundingClientRect();
      rect = { left: box.left, top: box.top, width: box.width, height: box.height };
      rectStale = false;
      rectReadAt = performance.now();
    };

    const onPointerMove = (event: PointerEvent): void => {
      // Re-read on a budget instead of on every event. A layout read per pointer event is how a
      // smooth interaction starts to stutter, and the orb can only move when the layout moves it.
      if (rectStale || performance.now() - rectReadAt > 120) readRect();
      sample = orbPointerFromClient({ ...rect, clientX: event.clientX, clientY: event.clientY });
    };
    // Leaving the surface is a sample at zero rather than the last position held: without it the
    // glow stays lit at wherever the pointer left, which reads as a stuck highlight.
    const onPointerLeave = (): void => {
      sample = { x: 0, y: 0, strength: 0 };
    };

    if (target !== null) {
      target.addEventListener("pointermove", onPointerMove);
      target.addEventListener("pointerleave", onPointerLeave);
    }

    const invalidateRect = (): void => {
      rectStale = true;
    };
    // Capture phase, because a scroll does not bubble: without it, scrolling the transcript would
    // leave the cached rect behind and the glow would answer a pointer position that has moved.
    window.addEventListener("scroll", invalidateRect, true);

    const loop = (time: number): void => {
      renderer.setPointer(sample);
      renderer.frame(time);
      frameHandle = window.requestAnimationFrame(loop);
    };

    const start = (): void => {
      if (frameHandle !== 0 || reduceMotion) return;
      frameHandle = window.requestAnimationFrame(loop);
    };
    const stop = (): void => {
      if (frameHandle === 0) return;
      window.cancelAnimationFrame(frameHandle);
      frameHandle = 0;
    };

    if (reduceMotion) {
      // One frame, at rest, so the orb is present without moving.
      renderer.frame(0);
    } else {
      start();
    }

    const onResize = (): void => {
      renderer.resize();
      invalidateRect();
      if (reduceMotion) renderer.frame(0);
    };
    window.addEventListener("resize", onResize);

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        visible = entry?.isIntersecting ?? true;
        if (visible) start();
        else stop();
      },
      { threshold: 0.01 },
    );
    observer.observe(canvas);

    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", invalidateRect, true);
      if (target !== null) {
        target.removeEventListener("pointermove", onPointerMove);
        target.removeEventListener("pointerleave", onPointerLeave);
      }
      renderer.dispose();
    };
    // The options are read once, when the renderer is built. Re-creating the context whenever a
    // new options object identity arrives would drop and rebuild the GPU program on every keystroke
    // in the composer, which is why the dependency list here is deliberately empty.
  }, [theme, pointerTarget]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      data-orb={failed === undefined ? "gl" : "fallback"}
      {...(failed === undefined ? {} : { "data-orb-reason": failed })}
      role="img"
      aria-label={label ?? "Orb"}
    />
  );
}
