import { type ReactElement, type RefObject, useEffect, useState } from "react";

import { selectedText } from "./selection.ts";

interface Placement {
  text: string;
  x: number;
  y: number;
}

/**
 * What appears over a highlighted passage.
 *
 * Two things are offered here and a third is not: keeping the passage and asking about it are both answers this
 * screen can give on its own, while "work on this somewhere else" needs a worker to send it to. A button that never
 * becomes available is worse than an absent one, because it looks like a feature that is broken.
 *
 * The menu follows the selection rather than the pointer: it is placed at the top of the highlighted range, which is
 * where the person's attention already is, and it disappears the moment the selection does.
 */
export function SelectionToolbar({
  container,
  onAttach,
  onExplain,
}: {
  /** The transcript. A selection anywhere else on the page is not what this is for. */
  container: RefObject<HTMLElement | null>;
  onAttach: (text: string) => void;
  onExplain: (text: string) => void;
}): ReactElement | null {
  const [placement, setPlacement] = useState<Placement | undefined>(undefined);

  useEffect(() => {
    const read = (): void => {
      const selection = typeof window === "undefined" ? null : window.getSelection();
      const inside = container.current;
      if (selection === null || inside === null || selection.rangeCount === 0 || selection.isCollapsed) {
        setPlacement(undefined);
        return;
      }

      const text = selectedText(selection.toString());
      const range = selection.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      if (text === undefined || element === null || !inside.contains(element)) {
        setPlacement(undefined);
        return;
      }

      const rect = range.getBoundingClientRect();
      setPlacement({ text, x: rect.left + rect.width / 2, y: rect.top });
    };

    document.addEventListener("selectionchange", read);
    // Once on mount as well, because a selection made before this rendered is still a selection.
    read();
    return () => document.removeEventListener("selectionchange", read);
  }, [container]);

  if (placement === undefined) return null;

  return (
    <div
      className="cc-selection-menu"
      data-selection-menu="true"
      role="toolbar"
      aria-label="Đoạn được chọn"
      style={{ left: `${placement.x}px`, top: `${placement.y}px` }}
    >
      <button
        type="button"
        data-selection-action="attach"
        onClick={() => {
          onAttach(placement.text);
          // The selection is cleared as well as the menu. Leaving it selected means the next selectionchange puts the
          // menu straight back, which looks like the button did nothing.
          window.getSelection()?.removeAllRanges();
          setPlacement(undefined);
        }}
      >
        Đính vào prompt
      </button>
      <button
        type="button"
        data-selection-action="explain"
        onClick={() => {
          onExplain(placement.text);
          window.getSelection()?.removeAllRanges();
          setPlacement(undefined);
        }}
      >
        Giải thích
      </button>
    </div>
  );
}
