import { type ComposerReference, type ComposerTrigger, referenceToken } from "@clarkcant/contracts";

/**
 * Where a `/` or `@` in the draft opens the picker, and what choosing a row does to the draft.
 *
 * Pure functions over the draft text and the caret, so the rules a person relies on while typing — a URL or an email
 * address never opens anything, a chosen reference lives exactly as long as its token is in the text — are tested
 * here rather than by driving a browser.
 */

/** The trigger under the caret: which character opened it, where its token starts and ends, and what was typed. */
export interface ActiveTrigger {
  trigger: ComposerTrigger;
  /** Index of the `/` or `@` itself. */
  start: number;
  /** End of the token, which may run past the caret when the caret is inside a word. */
  end: number;
  /** What was typed between the trigger and the caret. */
  query: string;
}

/** The node refuses a longer query, so the picker does not ask. */
const QUERY_MAX = 200;
const WORD = /[\p{L}\p{N}_]/u;
const SPACE = /\s/u;
/** What may stand right after a token that is still the reference: the end, a space, or closing punctuation. */
const AFTER_TOKEN = /[\s.,;:!?)\]}"'”’»]/u;

/**
 * Whether a token that stops at `end` ends there. A colon ends it only before a space or the end of the text, so the
 * `/skill` of `/skill:new` is not a skill called `skill`.
 */
function tokenEndsAt(text: string, end: number): boolean {
  const after = text[end];
  if (after === undefined) return true;
  if (after === ":") return end + 1 === text.length || SPACE.test(text[end + 1] ?? "");
  return AFTER_TOKEN.test(after);
}

export function activeTrigger(draft: string, caret: number): ActiveTrigger | undefined {
  if (caret < 0 || caret > draft.length) return undefined;
  let tokenStart = caret;
  while (tokenStart > 0 && !SPACE.test(draft[tokenStart - 1] ?? "")) tokenStart -= 1;
  let end = caret;
  while (end < draft.length && !SPACE.test(draft[end] ?? "")) end += 1;
  const token = draft.slice(tokenStart, caret);
  if (token === "") return undefined;

  if (token.startsWith("/")) {
    const query = token.slice(1);
    // A path being typed ("/usr/bin") is not a skill being named.
    if (query.includes("/") || query.length > QUERY_MAX) return undefined;
    return { trigger: "/", start: tokenStart, end, query };
  }

  const at = token.indexOf("@");
  if (at < 0) return undefined;
  const before = token.slice(0, at);
  // An email address (a word right before the `@`) and a URL (a `/` or `:` before it) are text, not a mention.
  // Opening punctuation is allowed: "(@clarkcant" still names the project.
  if (WORD.test(before.at(-1) ?? "") || before.includes("/") || before.includes(":")) return undefined;
  const query = token.slice(at + 1);
  if (query.length > QUERY_MAX) return undefined;
  return { trigger: "@", start: tokenStart + at, end, query };
}

/**
 * The draft with the trigger's token replaced, and where the caret goes.
 *
 * A space follows a finished token so the next word does not run into it; a token ending in `/` is a directory being
 * opened, and the caret stays right after it so the picker lists what is inside.
 */
export function replaceToken(draft: string, active: ActiveTrigger, text: string): { draft: string; caret: number } {
  const after = draft.slice(active.end);
  const open = text.endsWith("/");
  const spacer = open || after.startsWith(" ") ? "" : " ";
  const next = `${draft.slice(0, active.start)}${text}${spacer}${after}`;
  const caret = active.start + text.length + (open ? 0 : 1);
  return { draft: next, caret: Math.min(caret, next.length) };
}

/**
 * Whether the token under the caret already spells this command in full, so there is nothing left for a row to write.
 *
 * Enter on such a row sends the message instead of completing it: a person who typed `/thinking` and pressed Enter
 * meant the command, whether or not the list had been drawn by then.
 */
export function commandFullyTyped(draft: string, active: ActiveTrigger, command: string): boolean {
  return active.trigger === "/" && draft.slice(active.start, active.end).toLowerCase() === `/${command}`.toLowerCase();
}

/** Whether a reference's token still stands in the text as a whole token, not as the start of a longer one. */
export function tokenPresent(text: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const index = text.indexOf(token, from);
    if (index < 0) return false;
    const before = index === 0 ? "" : (text[index - 1] ?? "");
    if ((before === "" || !WORD.test(before)) && tokenEndsAt(text, index + token.length)) return true;
    from = index + 1;
  }
}

/**
 * The chosen references a text still carries.
 *
 * A reference is dropped the moment its token is deleted from the draft, so what is sent is always what the person can
 * see in what they wrote, and a reference cannot ride along invisibly.
 */
export function liveReferences<T extends { ref: ComposerReference }>(text: string, chosen: readonly T[]): T[] {
  return chosen.filter((entry) => tokenPresent(text, referenceToken(entry.ref)));
}

/** The draft with one reference's token taken out, for the chip's remove button. */
export function withoutToken(draft: string, token: string): string {
  let from = 0;
  for (;;) {
    const index = draft.indexOf(token, from);
    if (index < 0) return draft;
    if (tokenEndsAt(draft, index + token.length)) {
      const cut = draft[index + token.length] === " " ? token.length + 1 : token.length;
      return `${draft.slice(0, index)}${draft.slice(index + cut)}`;
    }
    from = index + 1;
  }
}
