import { Fragment, useLayoutEffect, useMemo, type ReactElement, type RefObject } from "react";

import { markDraft, type DraftSegment } from "./composer-markdown.ts";

function segment(part: DraftSegment, key: number): ReactElement | string {
  if (part.marks.length === 0) return <Fragment key={key}>{part.text}</Fragment>;
  return (
    <span key={key} className={part.marks.map((mark) => `cc-md-live-${mark}`).join(" ")}>
      {part.text}
    </span>
  );
}

/**
 * The draft with its Markdown marked, drawn under the composer's textarea (`composer-markdown.ts` says why it is
 * drawn rather than edited). Hidden from assistive technology: the textarea is the field, and this is only its look.
 */
export function ComposerMirror({ draft, mirror }: { draft: string; mirror: RefObject<HTMLDivElement | null> }): ReactElement {
  const lines = useMemo(() => markDraft(draft), [draft]);
  return (
    <div className="cc-composer-mirror" ref={mirror} aria-hidden="true" data-composer-mirror="true">
      {lines.map((line, index) => (
        <Fragment key={index}>
          {index === 0 ? null : "\n"}
          {line.map(segment)}
        </Fragment>
      ))}
      {/* A textarea gives a trailing newline a line of its own; a block does not, without something on it. */}
      {draft.endsWith("\n") ? "​" : null}
    </div>
  );
}

/**
 * Keep the mirror over the textarea's text box: the same width the text wraps at (which loses a scrollbar's width
 * once the field scrolls), the same height, and the same scroll position.
 */
export function useComposerMirror(
  input: RefObject<HTMLTextAreaElement | null>,
  mirror: RefObject<HTMLDivElement | null>,
  draft: string,
): void {
  useLayoutEffect(() => {
    const field = input.current;
    const shadow = mirror.current;
    if (field === null || shadow === null) return;
    const sync = (): void => {
      shadow.style.width = `${field.clientWidth}px`;
      shadow.style.height = `${field.clientHeight}px`;
      shadow.scrollTop = field.scrollTop;
    };
    sync();
    field.addEventListener("scroll", sync, { passive: true });
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(sync);
    resized?.observe(field);
    return () => {
      field.removeEventListener("scroll", sync);
      resized?.disconnect();
    };
  }, [input, mirror, draft]);
}
