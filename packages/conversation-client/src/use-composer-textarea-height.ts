import { useLayoutEffect, type RefObject } from "react";

import { composerTextareaHeight } from "./composer-height.ts";

/**
 * Grow the input to fit what is typed into it, and stop at five lines.
 *
 * A layout effect rather than an effect so the growth lands in the same frame as the keystroke:
 * an effect would let the browser paint the old height first, and the box would visibly trail the
 * text by one frame on every line.
 */
export function useComposerTextareaHeight(
  composerInput: RefObject<HTMLTextAreaElement | null>,
  draft: string,
): void {
  useLayoutEffect(() => {
    const node = composerInput.current;
    if (node === null) return;
    // The height is released before measuring, because the scroll height of a box that is already
    // as tall as its content reports that height rather than the content's — which would make the
    // box only ever grow.
    node.style.height = "auto";
    const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
    const { height, scrolls } = composerTextareaHeight(node.scrollHeight, lineHeight);
    node.style.height = `${height}px`;
    node.style.overflowY = scrolls ? "auto" : "hidden";
  }, [composerInput, draft]);
}
