/**
 * A press on a page, as data: what was pressed, and where.
 *
 * A browser task's click is recorded in two places a person later reads — the effect ledger, whose notice and answers
 * name it, and the activity log the Control settings list. Both are read in the person's language, which can change
 * after the click was recorded, so neither keeps a sentence in one language. The activity log keeps this record as it
 * is; the ledger's intent is one string, so it keeps one fixed English form (`browserPressIntent`) that
 * `browserPressOfIntent` reads back exactly. Every place that shows it to a person words it at that moment, through
 * `describeBrowserPress` on the node or the client's own translations.
 */
export interface BrowserPress {
  verb: "click";
  /** The control's accessible name, on one line. Never a value the task typed. */
  label: string;
  /** The page's host and path. Never its query, which can carry a token. */
  page: string;
}

export type BrowserPressLocale = "en" | "vi";

/** How long a label and a page may be, so the record stays one readable line. */
export const BROWSER_PRESS_LABEL_MAX = 60;
export const BROWSER_PRESS_PAGE_MAX = 120;

const PREFIX = "browser click “";
// Written by `browserPressIntent` only, so it is read back strictly: a label holds no curly quote, and a page is one
// line that ends where ` — ` starts what the press ran in.
const INTENT = /^browser click “([^“”\n]*)” on ([^\n]+?)(?: — [^\n]*)?$/u;

function flat(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * The press as it may be recorded: on one line, bounded, with any curly quote in the label made straight, so the
 * quotes around it are always the label's own and the record reads back to the same press.
 */
export function browserPress(label: string, page: string): BrowserPress {
  const safePage = flat(page, BROWSER_PRESS_PAGE_MAX).replaceAll(" — ", " - ");
  return {
    verb: "click",
    label: flat(label.replace(/[“”]/gu, '"'), BROWSER_PRESS_LABEL_MAX),
    page: safePage === "" ? "about:blank" : safePage,
  };
}

/** The ledger's intent for a press: one fixed English form, then where it ran after ` — `. */
export function browserPressIntent(press: BrowserPress, targetId: string): string {
  return `${PREFIX}${press.label}” on ${press.page} — ${targetId}`.slice(0, 2000);
}

/** The press an intent records, when it is one `browserPressIntent` wrote; anything else is not read as a press. */
export function browserPressOfIntent(intent: string): BrowserPress | undefined {
  const matched = INTENT.exec(intent);
  if (matched === null) return undefined;
  const [, label = "", page = ""] = matched;
  return { verb: "click", label, page };
}

/** The press in the person's words: `click “Send” on shop.example/apply`, `bấm “Send” trên shop.example/apply`. */
export function describeBrowserPress(press: BrowserPress, locale: BrowserPressLocale): string {
  return locale === "en" ? `click “${press.label}” on ${press.page}` : `bấm “${press.label}” trên ${press.page}`;
}
