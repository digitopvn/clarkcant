/**
 * Where another settings section can send a person in the Credentials list, as the selectors the list renders.
 *
 * The list owns these attributes; a section that points at it (the decision provider's TypeSafe card) and the tests that
 * check the pointer both read them from here, so a renamed attribute fails a test instead of leaving a button that does
 * nothing.
 */
export const CREDENTIALS_SECTION_SELECTOR = "[data-credentials-section='true']";

/** The row for one credential name. */
export function credentialRowSelector(name: string): string {
  return `[data-credential-row="${cssString(name)}"]`;
}

/** The key field inside one credential's row: where a person types the key, never a Remove or Replace button. */
export function credentialFieldSelector(name: string): string {
  return `[data-credential-field="${cssString(name)}"]`;
}

/** A name as a CSS string literal; credential names are plain identifiers, but a quote or backslash must not end it. */
function cssString(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** What took focus when a section pointed at a credential, or `none` when the Credentials list is not on the page. */
export type CredentialFocusTarget = "field" | "row" | "heading" | "none";

/**
 * Moves focus to a credential in the Credentials list: its key field, else its row, else the list's heading.
 *
 * Never a button in the row, so a held Enter cannot run into Remove. Something always takes focus while the list is on
 * the page, so the pointer is never a press that does nothing.
 */
export function focusCredential(name: string, root: ParentNode = document): CredentialFocusTarget {
  const section = root.querySelector<HTMLElement>(CREDENTIALS_SECTION_SELECTOR);
  const row = (section ?? root).querySelector<HTMLElement>(credentialRowSelector(name));
  const field = row?.querySelector<HTMLElement>(`${credentialFieldSelector(name)}:not([disabled])`);
  if (field) {
    field.focus();
    return "field";
  }
  if (row) {
    focusAsTarget(row);
    return "row";
  }
  const heading = section?.querySelector<HTMLElement>("h2, h3, h4");
  if (heading) {
    focusAsTarget(heading);
    return "heading";
  }
  return "none";
}

/** Focuses an element that is not a control, making it a focus target for scripts only (out of the Tab order). */
function focusAsTarget(element: HTMLElement): void {
  if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
  element.scrollIntoView?.({ block: "nearest" });
  element.focus();
}
