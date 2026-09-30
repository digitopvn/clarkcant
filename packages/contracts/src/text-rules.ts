import { z } from "zod";

/**
 * Characters a model may not put in the words a card shows.
 *
 * A card shows what the model wrote, and the same words become the text a screen reader, a transcript and a later model
 * turn read. Some characters make those differ from what the page draws: a bidi control reorders text on screen while
 * the stored bytes read in another order, an invisible character hides inside a word, a tag character carries text no
 * reader sees, and a line break or a line separator in a one-line field forges a new line in the text alternative. Every
 * card that shows model-written text refuses them with the same rules, so a reason names the character and a model can
 * remove it and try again.
 *
 * ZWJ (U+200D) and ZWNJ (U+200C) are left alone: they join and separate letters in scripts people write every day, and
 * emoji sequences depend on them. So are the variation selectors, which choose how an emoji or an ideograph is drawn.
 */

/**
 * The characters refused in one-line text, as the body of a regular-expression character class.
 *
 * Every one is in the Basic Multilingual Plane, so the class means the same with or without the `u` flag. The tag
 * characters (U+E0000–U+E007F) are refused too, but they are two UTF-16 units each, so the patterns below name them as
 * a pair and `findHiddenCharacter` names them as code points.
 */
export const HIDDEN_CHARACTER_CLASS =
  "\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u115f\\u1160\\u180e\\u200b\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e" +
  "\\u2060-\\u2064\\u2066-\\u2069\\u3164\\ufeff\\uffa0\\ufff9-\\ufffb";

/** The same characters with `\t` (U+0009) and `\n` (U+000A) left out: what text that is many lines by nature refuses. */
const MULTI_LINE_HIDDEN_CLASS =
  "\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u115f\\u1160\\u180e\\u200b\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e" +
  "\\u2060-\\u2064\\u2066-\\u2069\\u3164\\ufeff\\uffa0\\ufff9-\\ufffb";

/** The white space `\s` matches that is not refused: what a required line may start with before its first letter. */
const ALLOWED_SPACE = " \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000";

/**
 * One allowed character, read as UTF-16 units the way this node compiles a schema's `pattern` (without the `u` flag).
 *
 * A tag character is the pair U+DB40 U+DC00–U+DC7F, so U+DB40 is allowed only before U+DC80–U+DFFF (a variation selector
 * and the rest of that block). The two options start with different units, so each character is matched one way only.
 * Compiled with the `u` flag a tag character is one code point the class does not name and passes the pattern; the
 * node never compiles it that way, and every card also runs `findHiddenCharacter`, which reads code points.
 */
const ALLOWED = `(?:[^${HIDDEN_CHARACTER_CLASS}\\udb40]|\\udb40[\\udc80-\\udfff])`;
const ALLOWED_NOT_SPACE = `(?:[^\\s${HIDDEN_CHARACTER_CLASS}\\udb40]|\\udb40[\\udc80-\\udfff])`;

/** One line with no hidden character: the JSON Schema `pattern` a definition gives a one-line string. */
export const ONE_LINE_PATTERN = `^${ALLOWED}*$`;

/**
 * The same, for a field that may not be empty: at least one character that is not a space once the line is trimmed.
 *
 * The leading spaces come from a class that shares no character with the first letter's, so there is one way to match
 * any line and a refused line is decided in time linear in its length. `[^X]*[^\sX][^X]*`, the obvious spelling, tries
 * every split of a long refused line and takes time quadratic in it.
 */
export const ONE_LINE_REQUIRED_PATTERN = `^[${ALLOWED_SPACE}]*${ALLOWED_NOT_SPACE}${ALLOWED}*$`;

/**
 * Text of many lines with no hidden character but `\n` and `\t`: the JSON Schema `pattern` for what
 * `hiddenCharacterProblem(value, { lineBreaks: true })` accepts. `\r`, the line and paragraph separators and every other
 * refused character stay refused, because a page draws them as a new line that nothing counts, or not at all.
 */
export const MULTI_LINE_PATTERN = `^(?:[^${MULTI_LINE_HIDDEN_CLASS}\\udb40]|\\udb40[\\udc80-\\udfff])*$`;

/** Every refused character as code points, the tag characters included: compiled with the `u` flag. */
const HIDDEN_SOURCE = `[${HIDDEN_CHARACTER_CLASS}\\u{e0000}-\\u{e007f}]`;
const HIDDEN = new RegExp(HIDDEN_SOURCE, "u");

export type HiddenCharacterKind = "control" | "line-break" | "bidi" | "invisible" | "tag" | "filler";

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
  if (code >= 0xe0000 && code <= 0xe007f) return "tag";
  if (code === 0x115f || code === 0x1160 || code === 0x3164 || code === 0xffa0) return "filler";
  if (
    code === 0x00ad ||
    code === 0x180e ||
    code === 0x200b ||
    code === 0xfeff ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0xfff9 && code <= 0xfffb)
  ) {
    return "invisible";
  }
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
    const code = value.codePointAt(index) ?? 0;
    if (options.lineBreaks === true && (code === 0x0a || code === 0x09)) {
      from = index + 1;
      continue;
    }
    return { codePoint: codePointLabel(String.fromCodePoint(code)), kind: kindOf(code), index };
  }
  return undefined;
}

const WHAT: Record<HiddenCharacterKind, string> = {
  "line-break": "a line break, and this field is one line",
  bidi: "a control that changes text direction, so the text would read differently from how it is drawn",
  invisible: "an invisible character",
  tag: "a tag character, which is invisible and can carry text no reader sees",
  filler: "a Hangul filler, which draws as a blank",
  control: "a control character",
};

/** Why `value` is refused, in words a model can act on, or `undefined` when it is fine. */
export function hiddenCharacterProblem(value: string, options: { lineBreaks?: boolean } = {}): string | undefined {
  const found = findHiddenCharacter(value, options);
  if (found === undefined) return undefined;
  return `contains ${found.codePoint}, ${WHAT[found.kind]}; remove it`;
}

/**
 * One line of the model's words, as a card shows it.
 *
 * Refused when it holds a line break, a control, a bidi control, an invisible character, a tag character or a Hangul
 * filler, with a reason that names it; otherwise read in NFC and trimmed, so a label of spaces is empty and two labels that look the same are the same.
 * The length is the model's own, before trimming, as its JSON Schema counts it.
 */
export function oneLineText(max: number, required: boolean) {
  return z
    .string()
    .max(max, `is longer than ${String(max)} characters`)
    .superRefine((value, ctx) => {
      const problem = hiddenCharacterProblem(value);
      if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
    })
    .transform((value) => value.normalize("NFC").trim())
    .refine((value) => !required || value !== "", "is empty");
}

/** At most this many schema problems in one refusal, so one bad list cannot flood it. */
const MAX_SCHEMA_PROBLEMS = 5;

/** Why a card's props failed its schema, one reason per problem, each saying where. */
export function cardSchemaProblems(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.slice(0, MAX_SCHEMA_PROBLEMS).map((issue) => {
    const where = issue.path.length === 0 ? "props" : `"${issue.path.map(String).join(".")}"`;
    return `${where}: ${issue.message}`;
  });
}

/** How a hidden character is drawn where it cannot be refused: its code point, in brackets nobody types by accident. */
export function hiddenCharacterMarker(codePoint: string): string {
  return `⟨${codePoint}⟩`;
}

/** A run of ordinary text, or one hidden character. */
export type HiddenCharacterSegment = { text: string } | { hidden: HiddenCharacter };

/**
 * `text` split around every hidden character in it, `\n` and `\t` aside.
 *
 * For text that is many lines by nature, such as code, where a hidden character cannot simply be refused: a bidi control
 * can be a real part of a string literal. The page draws each one as a marker instead of applying it, so the code reads
 * the way it is stored.
 */
export function hiddenCharacterSegments(text: string): HiddenCharacterSegment[] {
  const segments: HiddenCharacterSegment[] = [];
  let from = 0;
  // One pass with a global expression: a block of code can hold thousands of them, and rescanning from each one would
  // make that quadratic.
  for (const match of text.matchAll(new RegExp(HIDDEN_SOURCE, "gu"))) {
    const index = match.index;
    const code = text.codePointAt(index) ?? 0;
    if (code === 0x0a || code === 0x09) continue;
    if (index > from) segments.push({ text: text.slice(from, index) });
    segments.push({ hidden: { codePoint: codePointLabel(match[0]), kind: kindOf(code), index } });
    // A tag character is two UTF-16 units: the text resumes after both, so no half of it is drawn as ordinary text.
    from = index + match[0].length;
  }
  if (from < text.length) segments.push({ text: text.slice(from) });
  return segments;
}

/** `text` with each hidden character written as its marker, and how many there were. */
export function markHiddenCharacters(text: string): { text: string; count: number } {
  let count = 0;
  const marked = hiddenCharacterSegments(text)
    .map((segment) => {
      if ("text" in segment) return segment.text;
      count += 1;
      return hiddenCharacterMarker(segment.hidden.codePoint);
    })
    .join("");
  return { text: marked, count };
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