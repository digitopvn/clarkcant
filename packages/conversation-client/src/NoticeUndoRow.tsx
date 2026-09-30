import { type ReactElement, useLayoutEffect, useRef } from "react";

import { useT } from "./i18n/locale-context.tsx";
import type { NoticeUndo } from "./use-app-intent-surfaces.ts";

export interface NoticeUndoRowProps {
  undo: NoticeUndo;
  onUndo: () => void;
}

/**
 * The Undo for a notice a sentence dismissed, in the conversation's flow under the reply that said so.
 *
 * It offers the undo only while the node can still carry it out, then says quietly that the time has passed; once
 * used, it says the notice is back. It never takes focus when it appears: the person is reading the reply, and Tab
 * reaches the button in reading order. When the button goes while it has focus — pressed, or the time ran out while
 * it was focused — focus moves to the sentence that replaced it rather than falling to the page.
 */
export function NoticeUndoRow({ undo, onUndo }: NoticeUndoRowProps): ReactElement {
  const t = useT();
  const offered = undo.phase === "offered" || undo.phase === "restoring";
  const status = useRef<HTMLParagraphElement>(null);
  /** Set by a press and by focus; a press is kept even if removing the button fires a blur on the way out. */
  const pressed = useRef(false);
  const focused = useRef(false);

  useLayoutEffect(() => {
    if (offered || !(pressed.current || focused.current)) return;
    pressed.current = false;
    focused.current = false;
    status.current?.focus();
  }, [offered]);

  return (
    <div className="cc-row cc-notice-undo" data-notice-undo={undo.phase} data-notice-undo-id={undo.noticeId}>
      <p className="cc-notice-undo-text" role="status" tabIndex={-1} ref={status}>
        {undo.text}
      </p>
      {offered && (
        <button
          type="button"
          className="cc-icon-btn"
          // Sized to its word, as the other inline actions under a reply are; the shared round button is a fixed square.
          style={{ width: "auto", padding: "0 var(--cc-space-sm)", whiteSpace: "nowrap" }}
          data-intent-undo="true"
          aria-label={t("inbox.act.undoAria")}
          // Not `disabled` while the restore is on its way: a disabled button drops the focus it holds.
          aria-disabled={undo.phase === "restoring" ? "true" : undefined}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
          }}
          onClick={() => {
            if (undo.phase !== "offered") return;
            pressed.current = true;
            onUndo();
          }}
        >
          {t("inbox.act.undo")}
        </button>
      )}
    </div>
  );
}
