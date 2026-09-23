import type { MessageKey } from "./i18n/messages.ts";

/**
 * What a selection in the transcript can be turned into.
 *
 * The three things somebody wants after highlighting a sentence are: to keep it and say something about it, to have
 * it explained, and to have it worked on somewhere else while they carry on. The wording lives here rather than in
 * the component because it is the part worth testing: a menu that appears over the wrong text, or an attached quote
 * that loses the words around it, is a bug no screenshot shows.
 *
 * Each helper takes `t`, the catalog lookup from `useT()`, so the wording follows the current UI language rather
 * than always being Vietnamese.
 */

/** The longest selection that is offered as a whole. Menu 1 of 1: a wall of text is not a quote. */
export const SELECTION_MAX_CHARS = 2000;

/** Below this, a click that happened to drag is not a selection anybody meant. */
export const SELECTION_MIN_CHARS = 3;

export type SelectionAction = "attach" | "explain" | "background";

/** The text worth offering, or `undefined` when the drag was not a selection. */
export function selectedText(raw: string): string | undefined {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length < SELECTION_MIN_CHARS) return undefined;
  return trimmed.length > SELECTION_MAX_CHARS ? `${trimmed.slice(0, SELECTION_MAX_CHARS)}…` : trimmed;
}

/**
 * The selection added to what is already in the composer.
 *
 * Quoted and kept above the person's own words, because the quote is the thing being asked about and their question
 * is about it. An empty draft gets the quote alone: attaching something to nothing is still a useful thing to do,
 * and demanding a sentence first would be a rule invented here.
 */
export function attachedPrompt(selection: string, draft: string): string {
  const quoted = selection
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const rest = draft.trim();
  return rest === "" ? `${quoted}\n` : `${quoted}\n\n${rest}`;
}

/** What asking for an explanation actually asks. */
export function explainPrompt(selection: string, t: (key: MessageKey) => string): string {
  return t("widgets.selection.explainPrompt").replace("{selection}", selection);
}

/**
 * The title a background session is listed under.
 *
 * The selection's own opening words, clipped: a list of identical titles tells a person nothing about which worker
 * is which, and the title is the only thing a dropdown has room for.
 */
export function backgroundTitle(selection: string, t: (key: MessageKey) => string): string {
  const firstLine = selection.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const clipped = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
  return clipped === "" ? t("widgets.selection.backgroundTitleFallback") : clipped;
}

/** What a background session is asked to do with the selection. */
export function backgroundPrompt(selection: string, t: (key: MessageKey) => string): string {
  return t("widgets.selection.backgroundPrompt").replace("{selection}", selection);
}
