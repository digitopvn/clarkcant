/**
 * The composer's draft as it will read once sent: the Markdown a person types, marked up while they type it.
 *
 * The field stays a plain textarea — typing, deleting, selecting, undo, spell-check and every input method behave
 * exactly as they always did — and this is drawn underneath it, the same text in the same box, with the textarea's
 * own glyphs made transparent. That only works while both lay out identically, so nothing here may change the width
 * of a character: no other font, size, weight or style. Emphasis is carried by colour, a tint behind code, a stroke
 * that thickens strong text without moving it, and a line through struck text. The syntax stays visible but quiet, so
 * the person still sees and can edit what they typed.
 *
 * Pure, and line-based: the draft is short, and a line is the unit a person edits. A fence opens a code block that
 * runs until its closing fence, and inside it nothing else is read as Markdown.
 */

/** What a run of text is, for the stylesheet: the class `cc-md-live-<kind>`. */
export type DraftMarkKind =
  | "syntax"
  | "strong"
  | "emphasis"
  | "strike"
  | "code"
  | "link"
  | "url"
  | "heading"
  | "quote"
  | "list"
  | "fence";

export interface DraftSegment {
  text: string;
  /** Outermost first; empty for plain text. */
  marks: readonly DraftMarkKind[];
}

export type DraftLine = readonly DraftSegment[];

const FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^(\s{0,3}#{1,6})(\s+)(.*)$/;
const QUOTE = /^(\s{0,3}>\s?)(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;

/**
 * The inline rules, tried at each position in this order. Each names its opening and closing syntax so the markers are
 * drawn as syntax and only what is between them carries the mark; a marker that is never closed is left as typed.
 */
const INLINE: readonly { pattern: RegExp; mark: DraftMarkKind }[] = [
  { pattern: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/, mark: "code" },
  { pattern: /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/, mark: "strong" },
  { pattern: /^(~~)(?=\S)([\s\S]*?\S)\1/, mark: "strike" },
  { pattern: /^(\*|_)(?=[^\s*_])([\s\S]*?[^\s*_])\1(?![*_])/, mark: "emphasis" },
];
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;
const BARE_URL = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/;

/** The draft, line by line, as runs of marked text. Joining every run's text, line by line with `\n`, gives the draft back. */
export function markDraft(draft: string): DraftLine[] {
  const lines = draft.split("\n");
  const out: DraftLine[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const fenced = FENCE.exec(line);
    if (fence !== undefined) {
      // Inside a block: the closing fence is syntax, everything else is code taken literally.
      if (fenced !== null && fenced[2]?.startsWith(fence) === true && fenced[3]?.trim() === "") {
        fence = undefined;
        out.push([{ text: line, marks: ["fence", "syntax"] }]);
      } else {
        out.push(line === "" ? [] : [{ text: line, marks: ["fence"] }]);
      }
      continue;
    }
    if (fenced !== null) {
      fence = fenced[2]?.[0]?.repeat(3);
      out.push([{ text: line, marks: ["fence", "syntax"] }]);
      continue;
    }
    out.push(markLine(line));
  }
  return out;
}

function markLine(line: string): DraftLine {
  const heading = HEADING.exec(line);
  if (heading !== null) {
    return [
      { text: `${heading[1] ?? ""}${heading[2] ?? ""}`, marks: ["heading", "syntax"] },
      ...markInline(heading[3] ?? "", ["heading"]),
    ];
  }
  const quote = QUOTE.exec(line);
  if (quote !== null) {
    return [{ text: quote[1] ?? "", marks: ["quote", "syntax"] }, ...markInline(quote[2] ?? "", ["quote"])];
  }
  const list = LIST.exec(line);
  if (list !== null) {
    return [
      ...(list[1] === "" ? [] : [{ text: list[1] ?? "", marks: [] }]),
      { text: `${list[2] ?? ""}${list[3] ?? ""}`, marks: ["list"] },
      ...markInline(list[4] ?? "", []),
    ];
  }
  return markInline(line, []);
}

/** A run of inline text, with the marks of the line it is on carried on every piece of it. */
function markInline(text: string, outer: readonly DraftMarkKind[]): DraftSegment[] {
  const out: DraftSegment[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") out.push({ text: plain, marks: outer });
    plain = "";
  };
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    // A marker only opens at the start of a word, so `snake_case_name` and `2*3*4` stay plain.
    const atWordStart = index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1] ?? "");
    const link = LINK.exec(rest);
    if (link !== null) {
      flush();
      out.push({ text: "[", marks: [...outer, "syntax"] });
      out.push(...markInline(link[1] ?? "", [...outer, "link"]));
      out.push({ text: "](", marks: [...outer, "syntax"] });
      out.push({ text: link[2] ?? "", marks: [...outer, "url"] });
      out.push({ text: ")", marks: [...outer, "syntax"] });
      index += link[0].length;
      continue;
    }
    const url = atWordStart ? BARE_URL.exec(rest) : null;
    if (url !== null) {
      flush();
      out.push({ text: url[0], marks: [...outer, "link"] });
      index += url[0].length;
      continue;
    }
    const rule = atWordStart ? INLINE.find((candidate) => candidate.pattern.test(rest)) : undefined;
    const match = rule?.pattern.exec(rest);
    if (rule !== undefined && match !== null && match !== undefined) {
      flush();
      const marker = match[1] ?? "";
      const inner = match[2] ?? "";
      out.push({ text: marker, marks: [...outer, rule.mark, "syntax"] });
      // Code is literal; the other marks can hold further Markdown, as **a `b` c** does.
      if (rule.mark === "code") out.push({ text: inner, marks: [...outer, "code"] });
      else out.push(...markInline(inner, [...outer, rule.mark]));
      out.push({ text: marker, marks: [...outer, rule.mark, "syntax"] });
      index += match[0].length;
      continue;
    }
    plain += text[index] ?? "";
    index += 1;
  }
  flush();
  return out;
}
