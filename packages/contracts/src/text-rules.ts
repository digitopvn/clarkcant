/**
 * Characters a model may not put in the words a card shows.
 *
 * A card shows what the model wrote, and the same words become the text a screen reader, a transcript and a later model
 * turn read. Some characters make those differ from what the page draws: a bidi control reorders text on screen while
 * the stored bytes read in another order, an invisible character hides inside a word, and a line break or a line
 * separator in a one-line field forges a new line in the text alternative. Every card that shows model-written text
 * refuses them with the same rules, so a reason names the character and a model can remove it and try again.
 *
 * ZWJ (U+200D) and ZWNJ (U+200C) are left alone: they join and separate letters in scripts people write every day, and
 * emoji sequences depend on them.
 */

/** The characters refused in one-line text, as the body of a regular-expression character class. */
export const HIDDEN_CHARACTER_CLASS =
  "\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff";

/**
 * One line with no hidden character: the JSON Schema `pattern` a definition gives a one-line string.
 *
 * Written with `\u` escapes that mean the same with or without the `u` flag, so the schema reads the same wherever it is
 * compiled.
 */
export const ONE_LINE_PATTERN = `^[^${HIDDEN_CHARACTER_CLASS}]*$`;

/** The same, for a field that may not be empty: at least one character that is not a space once the line is trimmed. */
export const ONE_LINE_REQUIRED_PATTERN = `^[^${HIDDEN_CHARACTER_CLASS}]*[^\\s${HIDDEN_CHARACTER_CLASS}][^${HIDDEN_CHARACTER_CLASS}]*$`;

const HIDDEN = new RegExp(`[${HIDDEN_CHARACTER_CLASS}]`, "u");

export type HiddenCharacterKind = "control" | "line-break" | "bidi" | "invisible";

export interface HiddenCharacter {
  /** `U+202E` */
  codePoint: string;
  kind: HiddenCharacterKind;
  /** Offset in UTF-16 code units. */
  index: number;
}

/** `U+202E` for a character. */
export function codePointLabel(character: string): string {
  return `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

function kindOf(code: number): HiddenCharacterKind {
  if (code === 0x0a || code === 0x0d || code === 0x85 || code === 0x2028 || code === 0x2029) return "line-break";
  if (code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
    return "bidi";
  }
  if (code === 0x200b || code === 0xfeff) return "invisible";
  return "control";
}

/**
 * The first character in `value` a card refuses, or `undefined`.
 *
 * `lineBreaks` lets `\n` and `\t` through, for text that is many lines by nature (code, a diff line's neighbours); the
 * line and paragraph separators stay refused there, because a page draws them as a new line that nothing counts.
 */
export function findHiddenCharacter(value: string, options: { lineBreaks?: boolean } = {}): HiddenCharacter | undefined {
  let from = 0;
  while (from < value.length) {
    const match = HIDDEN.exec(value.slice(from));
    if (match === null) return undefined;
    const index = from + match.index;
    const code = value.charCodeAt(index);
    if (options.lineBreaks === true && (code === 0x0a || code === 0x09)) {
      from = index + 1;
      continue;
    }
    return { codePoint: codePointLabel(value[index] ?? ""), kind: kindOf(code), index };
  }
  return undefined;
}

const WHAT: Record<HiddenCharacterKind, string> = {
  "line-break": "a line break, and this field is one line",
  bidi: "a control that changes text direction, so the text would read differently from how it is drawn",
  invisible: "an invisible character",
  control: "a control character",
};

/** Why `value` is refused, in words a model can act on, or `undefined` when it is fine. */
export function hiddenCharacterProblem(value: string, options: { lineBreaks?: boolean } = {}): string | undefined {
  const found = findHiddenCharacter(value, options);
  if (found === undefined) return undefined;
  return `contains ${found.codePoint}, ${WHAT[found.kind]}; remove it`;
}

/**
 * At most `max` UTF-16 code units of `text`, never cutting a surrogate pair in half.
 *
 * Half a pair is not a character: it draws as a replacement box and is not valid UTF-8 when the text leaves the page.
 */
export function sliceCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = max > 0 ? text.charCodeAt(max - 1) : 0;
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return text.slice(0, Math.max(0, end));
}

/**
 * `text` fitted to `limit`, saying so when it had to be shortened.
 *
 * For a text alternative built from many parts, where cutting silently would let a reader think they had it all.
 */
export function clipWithMarker(text: string, limit: number, marker = "… (shortened)"): string {
  if (text.length <= limit) return text;
  return `${sliceCodePoints(text, limit - marker.length).trimEnd()}${marker}`;
}
