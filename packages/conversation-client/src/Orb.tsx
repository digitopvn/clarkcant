import { useEffect, useRef, useState, type ReactElement } from "react";

import { createOrbRenderer, type OrbOptions } from "./orb.ts";

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
 * rectangle. Read at mount rather than hardcoded, because the theme can be either.
 */
function readCanvasColor(): readonly number[] | undefined {
  if (typeof getComputedStyle !== "function") return undefined;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--cc-canvas").trim();
  return raw === "" ? undefined : parseCssColor(raw);
}

export function Orb({ size, className, label, ...options }: OrbProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState<string | undefined>(undefined);

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

    const loop = (time: number): void => {
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
      renderer.dispose();
    };
    // The options are read once, when the renderer is built. Re-creating the context whenever a
    // new options object identity arrives would drop and rebuild the GPU program on every keystroke
    // in the composer, which is why the dependency list here is deliberately empty.
  }, []);

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
