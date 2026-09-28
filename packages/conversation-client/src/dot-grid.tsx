import { type ReactElement, useEffect, useRef } from "react";

/**
 * The dotted field behind the conversation, lit where the pointer is.
 *
 * Two layers of the same grid: a faint one that is always there, and a brighter one masked to a circle around the
 * pointer, so the dots under the mouse light up and fade out with distance. The position is written as two custom
 * properties rather than through React state, because a pointer move is sixty renders a second of a shell that has
 * nothing else to change.
 *
 * Only a mouse or pen lights it: a finger has no hover, and a glow that jumps to each tap reads as a bug. With no
 * pointer over the shell the light fades out, so a keyboard-only reader sees the faint grid and nothing that follows
 * a cursor they are not using.
 */
export function DotGrid(): ReactElement {
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = grid.current;
    const shell = node?.parentElement;
    if (node === null || node === undefined || shell === null || shell === undefined) return undefined;
    let frame = 0;
    let x = 0;
    let y = 0;

    const paint = (): void => {
      frame = 0;
      node.style.setProperty("--cc-grid-x", `${x}px`);
      node.style.setProperty("--cc-grid-y", `${y}px`);
    };
    const onMove = (event: PointerEvent): void => {
      if (event.pointerType === "touch") return;
      const box = node.getBoundingClientRect();
      x = event.clientX - box.left;
      y = event.clientY - box.top;
      node.dataset.lit = "true";
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    const onLeave = (): void => {
      node.dataset.lit = "false";
    };

    shell.addEventListener("pointermove", onMove);
    shell.addEventListener("pointerleave", onLeave);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      shell.removeEventListener("pointermove", onMove);
      shell.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return <div className="cc-dot-grid" data-lit="false" aria-hidden="true" ref={grid} />;
}
