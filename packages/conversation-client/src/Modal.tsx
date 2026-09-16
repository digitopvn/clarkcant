/**
 * A modal.
 *
 * The specification reserves one for a decision that genuinely has to interrupt — an approval, a
 * credential, a pairing confirmation — and the width and radius are its numbers, not a guess.
 *
 * The behaviour it has to get right is small and easy to get wrong: Escape closes, the scrim
 * closes, focus moves into the dialog and returns to whatever opened it afterwards, and the page
 * behind cannot be scrolled while it is up. A modal that traps focus on open but not on close
 * leaves a keyboard user somewhere they did not choose.
 */

import { type ReactElement, type ReactNode, useCallback, useEffect, useRef } from "react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Rendered under the title. Optional, because not every dialog needs explaining. */
  description?: string;
  children: ReactNode;
  /** The row of actions at the bottom. Omitted when the dialog is purely informational. */
  actions?: ReactNode;
}

/** Elements a modal is allowed to move focus between. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, description, children, actions }: ModalProps): ReactElement | null {
  const dialog = useRef<HTMLDivElement>(null);
  // Captured on open so focus can go back where it came from rather than to the top of the page.
  const opener = useRef<Element | null>(null);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      // Cycled inside the dialog rather than allowed to escape to the page behind it, which is
      // still on screen and would otherwise be reachable by keyboard while visually covered.
      const node = dialog.current;
      if (node === null) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    opener.current = document.activeElement;
    document.addEventListener("keydown", onKeyDown);

    const node = dialog.current;
    const firstFocusable = node?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? node)?.focus();

    // The page behind must not scroll while the dialog is up, or the user scrolls a surface they
    // cannot see and loses their place.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open, onKeyDown]);

  if (!open) return null;

  return (
    <>
      <div className="cc-modal-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="cc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cc-modal-title"
        {...(description === undefined ? {} : { "aria-describedby": "cc-modal-desc" })}
        ref={dialog}
        tabIndex={-1}
        data-modal="true"
      >
        <header className="cc-modal-head">
          <h2 id="cc-modal-title">{title}</h2>
          <button type="button" className="cc-icon-btn" onClick={onClose} aria-label="Đóng">
            ✕
          </button>
        </header>
        <div className="cc-modal-body">
          {description !== undefined && (
            <p id="cc-modal-desc" className="cc-panel-note" style={{ marginTop: 0 }}>
              {description}
            </p>
          )}
          {children}
        </div>
        {actions !== undefined && <footer className="cc-modal-actions">{actions}</footer>}
      </div>
    </>
  );
}
