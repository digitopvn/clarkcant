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

import { type CSSProperties, type ReactElement, type ReactNode, useCallback, useEffect, useRef } from "react";

import { useT } from "./i18n/locale-context.tsx";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Rendered under the title. Optional, because not every dialog needs explaining. */
  description?: string;
  children: ReactNode;
  /** The row of actions at the bottom. Omitted when the dialog is purely informational. */
  actions?: ReactNode;
  /**
   * Overrides the specification's width for this dialog.
   *
   * The 700px in the token set is the width of a decision — an approval, a credential — where the point is
   * that it interrupts. A settings surface is read rather than decided, and the design draws it narrower so
   * the eye does not have to travel from a label to a control on the far side of a wide box.
   */
  width?: string;
}

/** Elements a modal is allowed to move focus between. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, description, children, actions, width }: ModalProps): ReactElement | null {
  const t = useT();
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

  // The listener is separate from the focus work on purpose: a handler whose identity changes re-registers
  // a listener, which is harmless, while re-running the focus work would pull focus out of whatever the user
  // is on. That is not harmless, and it is not hypothetical - see the note on the effect below.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onKeyDown]);

  /*
   * Opening moves focus into the dialog; closing returns it to whatever opened it.
   *
   * This depends on `open` and nothing else. It used to share one effect with the listener above, so it re-ran
   * whenever the close handler's identity changed - which happens on every re-render of the surface that owns
   * the dialog. Each re-run restored focus to the opener and then moved it to the dialog's first control, so a
   * keyboard user's focus was taken while they were using the dialog. It appeared as an intermittent browser
   * suite failure: a journey that presses arrow keys in the settings tab strip failed in CI and passed on a
   * faster machine, because the panel's data landing at the wrong moment was enough to re-render it.
   */
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    opener.current = document.activeElement;

    const node = dialog.current;
    const firstFocusable = node?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? node)?.focus();

    // The page behind must not scroll while the dialog is up, or the user scrolls a surface they
    // cannot see and loses their place.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open]);

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
        {...(width === undefined ? {} : { style: { "--cc-modal-width": width } as CSSProperties })}
      >
        <header className="cc-modal-head">
          <h2 id="cc-modal-title">{title}</h2>
          <button type="button" className="cc-icon-btn" onClick={onClose} aria-label={t("settings.modal.close")}>
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
