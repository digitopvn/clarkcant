import { z } from "zod";

import { artifactRefSchema } from "./artifacts.ts";

import {
  cardSchemaProblems,
  codePointLabel,
  findHiddenCharacter,
  hiddenCharacterProblem,
  markHiddenCharacters,
  oneLineText,
  sliceCodePoints,
} from "./text-rules.ts";
import type { SemanticValue } from "./widget-semantic.ts";

/**
 * Cards that show a piece of work: a block of code, a unified diff, a file.
 *
 * Everything on them is what the model wrote into their props, bounded by the schema. None of them fetches anything:
 * a file card names a file and says what it is, and has no link, no "open" and no download, because a reference to a
 * real artifact goes only through the node's own artifact broker, never through a URL a model wrote. The node's own
 * artifact and diff cards stay host-owned and are built from its records; these are catalog primitives beside them.
 *
 * One-line fields (a title, a path, a name, a section, a source) refuse any line break, control, bidi control or
 * invisible character, with a reason naming it. Code and diff lines cannot refuse all of them, since a bidi control can
 * be a real part of a string literal; the page draws each as a visible marker instead, and says the card holds them.
 *
 * One description serves the node and the page. The node refuses props that fail `artifactViewerProblems` before an
 * instance exists; the page reads the same props with `readArtifactViewer` and draws only what passes.
 */

export const MAX_CODE_CHARS = 20_000;
export const MAX_CODE_LINES = 400;
export const MAX_DIFF_FILES = 20;
export const MAX_DIFF_HUNKS = 20;
export const MAX_DIFF_LINES = 600;
export const MAX_DIFF_CHARS = 40_000;
export const MAX_DIFF_LINE_CHARS = 1000;
export const MAX_START_LINE = 10_000_000;

export const DIFF_LINE_KINDS = ["add", "remove", "context"] as const;
export type DiffLineKind = (typeof DIFF_LINE_KINDS)[number];

/** A language hint: a highlighter name or a file extension, never markup. */
export const LANGUAGE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_+#.-]{0,39}$";
/** A media type as `type/subtype`, with no parameters. */
export const MEDIA_TYPE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$";

/**
 * Every line break besides `\n`: CR LF, a lone CR, and the next-line, line and paragraph separators.
 *
 * A page may draw any of them as a new line, so code counts each as one. Left as they are, a separator would start a
 * line on screen that the numbers beside it never counted, and every number below it would sit beside the wrong line.
 */
const OTHER_LINE_BREAKS = /\r\n?|\u0085|\u2028|\u2029/gu;
const ANY_LINE_BREAK = /[\n\r\u0085\u2028\u2029]/u;

/** Code with every line break written as `\n`. */
export function normalizeLineBreaks(code: string): string {
  return code.replace(OTHER_LINE_BREAKS, "\n");
}

const titleSchema = oneLineText(200, false);
const pathSchema = oneLineText(300, true);

/**
 * A short token of a fixed shape, such as a language or a media type.
 *
 * The shape alone would refuse a hidden character, but only as a pattern that failed. Naming the character first says
 * what to remove, and says it the way every other field of these cards does.
 */
function tokenText(pattern: string, max: number, example: string) {
  const shape = new RegExp(pattern, "u");
  return z
    .string()
    .max(max, `is longer than ${String(max)} characters`)
    .superRefine((value, ctx) => {
      const problem = hiddenCharacterProblem(value);
      if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
      else if (!shape.test(value)) ctx.addIssue({ code: "custom", message: `is not in the form ${example}` });
    });
}

export const codeViewerSchema = z.strictObject({
  title: titleSchema.optional(),
  /** Where the code comes from, shown as text. */
  path: pathSchema.optional(),
  language: tokenText(LANGUAGE_PATTERN, 40, 'of a language name or extension, such as "ts" or "python"').optional(),
  /** Read with every line break as `\n`, so a line is what the numbers beside it count. */
  code: z.string().min(1).max(MAX_CODE_CHARS).transform(normalizeLineBreaks),
  /** The number of the first line shown, when the code is an excerpt. */
  startLine: z.number().int().min(1).max(MAX_START_LINE).optional(),
  /** The model cut the code to fit: the card says so. */
  truncated: z.boolean().optional(),
});
export type CodeViewer = z.infer<typeof codeViewerSchema>;

export const diffLineSchema = z.strictObject({
  kind: z.enum(DIFF_LINE_KINDS),
  /** One line, without its sign. A line break of any kind is refused: each line is given on its own. */
  text: z
    .string()
    .max(MAX_DIFF_LINE_CHARS)
    .superRefine((value, ctx) => {
      const found = ANY_LINE_BREAK.exec(value);
      if (found !== null) {
        ctx.addIssue({
          code: "custom",
          message: `contains ${codePointLabel(found[0])}, a line break; give each line of the diff as a line of its own`,
        });
      }
    }),
});
export type DiffLine = z.infer<typeof diffLineSchema>;

export const diffHunkSchema = z.strictObject({
  /** The first line the hunk covers in the old file, 0 when the file is new. */
  oldStart: z.number().int().min(0).max(MAX_START_LINE),
  /** The first line the hunk covers in the new file, 0 when the file is deleted. */
  newStart: z.number().int().min(0).max(MAX_START_LINE),
  /** The enclosing function or section, as a diff header names it. */
  section: oneLineText(200, false).optional(),
  lines: z.array(diffLineSchema).min(1).max(MAX_DIFF_LINES),
});
export type DiffHunk = z.infer<typeof diffHunkSchema>;

export const diffFileSchema = z.strictObject({
  path: pathSchema,
  /** The path before a rename. */
  oldPath: pathSchema.optional(),
  hunks: z.array(diffHunkSchema).min(1).max(MAX_DIFF_HUNKS),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

export const diffViewerSchema = z.strictObject({
  title: titleSchema.optional(),
  files: z.array(diffFileSchema).min(1).max(MAX_DIFF_FILES),
  /** The model left part of the change out: the card says so. */
  truncated: z.boolean().optional(),
});
export type DiffViewer = z.infer<typeof diffViewerSchema>;

export const fileViewerSchema = z.strictObject({
  title: titleSchema.optional(),
  name: oneLineText(200, true),
  mediaType: tokenText(MEDIA_TYPE_PATTERN, 128, 'type/subtype with no parameters, such as "application/pdf"').optional(),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  /** Where the file came from, in words: "Generated by Clark", "Attached by Lan". */
  source: oneLineText(200, false).optional(),
  /** Where the file is, as text. Never a link. */
  path: oneLineText(500, true).optional(),
  /** A few sentences; a line break is fine, a hidden character is not. */
  summary: z
    .string()
    .max(500)
    .superRefine((value, ctx) => {
      const problem = hiddenCharacterProblem(value, { lineBreaks: true });
      if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
    })
    .optional(),
  /**
   * The artifact this card stands for, when the node holds it. A pointer, not a permission: the host offers Open and
   * Save As for it, and the node checks on each that the person owns it. The card's other words stay the model's.
   */
  artifactRef: artifactRefSchema.optional(),
});
export type FileViewer = z.infer<typeof fileViewerSchema>;

export type ArtifactViewerKind = "code" | "diff" | "file";

export type ArtifactViewerContent =
  | { kind: "code"; card: CodeViewer }
  | { kind: "diff"; card: DiffViewer }
  | { kind: "file"; card: FileViewer };

/* ------------------------------------------------------------------ *
 * Counting
 * ------------------------------------------------------------------ */

/** The lines of a block of code. A final line break ends the last line; it does not start another. */
export function codeLines(code: string): string[] {
  const lines = normalizeLineBreaks(code).split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** The first and last line numbers a code card shows. */
export function codeLineRange(card: Pick<CodeViewer, "code" | "startLine">): { first: number; last: number; count: number } {
  const count = codeLines(card.code).length;
  const first = card.startLine ?? 1;
  return { first, last: first + count - 1, count };
}

/**
 * The language to highlight: the one the model named, or the path's extension.
 *
 * Only a hint. A name the highlighter does not know shows the code as plain text, which is what an invented or
 * missing language should get.
 */
export function codeLanguage(card: Pick<CodeViewer, "language" | "path">): string | undefined {
  if (card.language !== undefined) return card.language;
  const name = card.path?.split(/[\\/]/u).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return new RegExp(LANGUAGE_PATTERN, "u").test(extension) ? extension : undefined;
}

/** A diff line with the numbers it has in the old and the new file. An added line has no old number, a removed one no new. */
export type NumberedDiffLine = DiffLine & { oldLine?: number; newLine?: number };

/** Each line of a hunk with its old and new line numbers, counted from the hunk's starts. */
export function numberedHunkLines(hunk: DiffHunk): NumberedDiffLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.lines.map((line) => {
    if (line.kind === "add") return { ...line, newLine: newLine++ };
    if (line.kind === "remove") return { ...line, oldLine: oldLine++ };
    return { ...line, oldLine: oldLine++, newLine: newLine++ };
  });
}

/** How many lines of the old and new file a hunk covers. */
export function hunkCounts(hunk: DiffHunk): { oldCount: number; newCount: number } {
  let oldCount = 0;
  let newCount = 0;
  for (const line of hunk.lines) {
    if (line.kind !== "add") oldCount += 1;
    if (line.kind !== "remove") newCount += 1;
  }
  return { oldCount, newCount };
}

/** The hunk's header as a unified diff writes it, computed from its lines rather than taken from the model. */
export function hunkHeader(hunk: DiffHunk): string {
  const { oldCount, newCount } = hunkCounts(hunk);
  const section = hunk.section === undefined || hunk.section === "" ? "" : ` ${hunk.section}`;
  return `@@ -${String(hunk.oldStart)},${String(oldCount)} +${String(hunk.newStart)},${String(newCount)} @@${section}`;
}

/** Lines added and removed in one file, counted from its lines. */
export function diffFileCounts(file: DiffFile): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") additions += 1;
      if (line.kind === "remove") deletions += 1;
    }
  }
  return { additions, deletions };
}

/** Lines added and removed across the whole diff. */
export function diffCounts(card: DiffViewer): { files: number; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of card.files) {
    const counts = diffFileCounts(file);
    additions += counts.additions;
    deletions += counts.deletions;
  }
  return { files: card.files.length, additions, deletions };
}

/**
 * How many hidden characters the code or the diff's lines hold, each drawn as a marker rather than applied.
 *
 * Zero for a file card: every word on it is one line and refuses them.
 */
export function hiddenCharacterCount(content: ArtifactViewerContent): number {
  if (content.kind === "code") return markHiddenCharacters(content.card.code).count;
  if (content.kind === "file") return 0;
  let count = 0;
  for (const file of content.card.files) {
    for (const hunk of file.hunks) for (const line of hunk.lines) count += markHiddenCharacters(line.text).count;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * Reading and checking
 * ------------------------------------------------------------------ */

type Parsed = { ok: true; content: ArtifactViewerContent } | { ok: false; issues: z.core.$ZodIssue[] };

function parsed(kind: ArtifactViewerKind, props: unknown): Parsed {
  if (kind === "code") {
    const result = codeViewerSchema.safeParse(props);
    return result.success ? { ok: true, content: { kind, card: result.data } } : { ok: false, issues: result.error.issues };
  }
  if (kind === "diff") {
    const result = diffViewerSchema.safeParse(props);
    return result.success ? { ok: true, content: { kind, card: result.data } } : { ok: false, issues: result.error.issues };
  }
  const result = fileViewerSchema.safeParse(props);
  return result.success ? { ok: true, content: { kind, card: result.data } } : { ok: false, issues: result.error.issues };
}

const CUT = "cut it and set truncated";
const LEAVE_OUT = "leave some out and set truncated";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A file named in a reason: by its path when that is safe to repeat, otherwise by its place in the list. */
function fileLabel(file: Record<string, unknown>, index: number): string {
  const path = file.path;
  return typeof path === "string" && path.length <= 300 && path.trim() !== "" && findHiddenCharacter(path) === undefined
    ? path
    : `file ${String(index + 1)}`;
}

/**
 * What is over a card's limits, each said with how far over it is and what to do.
 *
 * Read from the props as given, before the schema, so a model hears "the code is 25000 characters; a card shows at
 * most 20000" rather than a bare "too big", whichever of the node's checks reaches the limit first.
 */
export function artifactViewerLimitProblems(kind: ArtifactViewerKind, props: unknown): string[] {
  if (!isRecord(props) || kind === "file") return [];
  const problems: string[] = [];
  if (kind === "code") {
    if (typeof props.code !== "string") return [];
    const chars = props.code.length;
    const lines = codeLines(props.code).length;
    if (chars > MAX_CODE_CHARS) {
      problems.push(`the code is ${String(chars)} characters; a card shows at most ${String(MAX_CODE_CHARS)}: ${CUT}`);
    }
    if (lines > MAX_CODE_LINES) {
      problems.push(`the code has ${String(lines)} lines; a card shows at most ${String(MAX_CODE_LINES)}: ${CUT}`);
    }
    return problems;
  }
  if (!Array.isArray(props.files)) return [];
  if (props.files.length > MAX_DIFF_FILES) {
    problems.push(`the diff has ${String(props.files.length)} files; a card shows at most ${String(MAX_DIFF_FILES)}: ${LEAVE_OUT}`);
  }
  let lines = 0;
  let chars = 0;
  let longLine: string | undefined;
  props.files.forEach((file: unknown, fileIndex) => {
    if (!isRecord(file) || !Array.isArray(file.hunks)) return;
    const label = fileLabel(file, fileIndex);
    if (file.hunks.length > MAX_DIFF_HUNKS) {
      problems.push(`${label} has ${String(file.hunks.length)} hunks; a card shows at most ${String(MAX_DIFF_HUNKS)} a file: ${LEAVE_OUT}`);
    }
    file.hunks.forEach((hunk: unknown, hunkIndex) => {
      if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return;
      lines += hunk.lines.length;
      hunk.lines.forEach((line: unknown, lineIndex) => {
        if (!isRecord(line) || typeof line.text !== "string") return;
        chars += line.text.length;
        if (longLine === undefined && line.text.length > MAX_DIFF_LINE_CHARS) {
          longLine =
            `line ${String(lineIndex + 1)} of hunk ${String(hunkIndex + 1)} of ${label} is ${String(line.text.length)} characters; ` +
            `a card shows at most ${String(MAX_DIFF_LINE_CHARS)} a line: ${CUT}`;
        }
      });
    });
  });
  if (longLine !== undefined) problems.push(longLine);
  if (lines > MAX_DIFF_LINES) problems.push(`the diff has ${String(lines)} lines; a card shows at most ${String(MAX_DIFF_LINES)}: ${CUT}`);
  if (chars > MAX_DIFF_CHARS) problems.push(`the diff holds ${String(chars)} characters; a card shows at most ${String(MAX_DIFF_CHARS)}: ${CUT}`);
  return problems;
}

function codeProblems(card: CodeViewer): string[] {
  const { last } = codeLineRange(card);
  return last > MAX_START_LINE ? [`the last line would be number ${String(last)}, above ${String(MAX_START_LINE)}`] : [];
}

/**
 * What is wrong with one hunk, on its own and beside the hunk above it.
 *
 * Two hunks of one file must agree: the lines the first adds and removes shift every line after it by the same amount,
 * so the second's new start follows from its old start. The check is skipped when the diff says part of the change is
 * left out, since a hunk left out between them shifts the lines too, and when either hunk only adds or only removes,
 * since unified diffs number such a hunk from the line before it.
 */
function hunkProblems(file: DiffFile, hunk: DiffHunk, index: number, previous: DiffHunk | undefined, truncated: boolean): string[] {
  const where = `hunk ${String(index + 1)} of ${file.path}`;
  const problems: string[] = [];
  const { oldCount, newCount } = hunkCounts(hunk);
  if (hunk.lines.every((line) => line.kind === "context")) problems.push(`${where} changes nothing: it has no added or removed line`);
  if (hunk.oldStart === 0 && oldCount > 0) problems.push(`${where} starts at old line 0, so it can only add lines`);
  if (hunk.newStart === 0 && newCount > 0) problems.push(`${where} starts at new line 0, so it can only remove lines`);
  if (previous === undefined) return problems;
  const before = hunkCounts(previous);
  if (hunk.oldStart < previous.oldStart + before.oldCount || hunk.newStart < previous.newStart + before.newCount) {
    problems.push(`${where} overlaps or comes before the hunk above it; hunks go in file order`);
    return problems;
  }
  const comparable = !truncated && [before.oldCount, before.newCount, oldCount, newCount].every((count) => count > 0);
  const shift = previous.newStart - previous.oldStart + before.newCount - before.oldCount;
  if (comparable && hunk.newStart - hunk.oldStart !== shift) {
    problems.push(
      `${where} starts at new line ${String(hunk.newStart)}, but the hunks above it move old line ${String(hunk.oldStart)} ` +
        `to new line ${String(hunk.oldStart + shift)}; fix the numbers, or set truncated if part of the change between them is left out`,
    );
  }
  return problems;
}

function diffProblems(card: DiffViewer): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of card.files) {
    if (seen.has(file.path)) problems.push(`${file.path} appears twice; give each file once with all its hunks`);
    seen.add(file.path);
    file.hunks.forEach((hunk, index) => {
      problems.push(...hunkProblems(file, hunk, index, index === 0 ? undefined : file.hunks[index - 1], card.truncated === true));
    });
  }
  return problems;
}

/**
 * A URL scheme at the start of a path, `mailto:` and `javascript:` as much as `https://`: a file card names a file, it
 * never links one. A Windows drive (`C:\`, `D:/`) is a path, not a scheme.
 */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:/iu;
const WINDOWS_DRIVE = /^[a-z]:(?:[\\/]|$)/iu;

function fileProblems(card: FileViewer): string[] {
  const problems: string[] = [];
  if (/[\\/]/u.test(card.name)) problems.push("the name is the file's own name; put the folder in path");
  if (card.path !== undefined && URL_LIKE.test(card.path) && !WINDOWS_DRIVE.test(card.path)) {
    problems.push("a file card names a file and does not link one; a path that is a URL is refused");
  }
  return problems;
}

/**
 * Everything wrong with a card's props: what is over its limits, what the schema says, then what it cannot say.
 *
 * A limit is said once, in its own words: the schema's "too big" for the same field is left out beside it.
 */
export function artifactViewerProblems(kind: ArtifactViewerKind, props: unknown): string[] {
  const limits = artifactViewerLimitProblems(kind, props);
  const result = parsed(kind, props);
  if (!result.ok) {
    const issues = limits.length === 0 ? result.issues : result.issues.filter((issue) => issue.code !== "too_big");
    return [...limits, ...cardSchemaProblems(issues)];
  }
  if (result.content.kind === "code") return [...limits, ...codeProblems(result.content.card)];
  if (result.content.kind === "diff") return [...limits, ...diffProblems(result.content.card)];
  return [...limits, ...fileProblems(result.content.card)];
}

/** The card its props describe, or `undefined` when the node would refuse them. */
export function readArtifactViewer(kind: ArtifactViewerKind, props: unknown): ArtifactViewerContent | undefined {
  const result = parsed(kind, props);
  return result.ok && artifactViewerProblems(kind, props).length === 0 ? result.content : undefined;
}

/* ------------------------------------------------------------------ *
 * What the card says, as text and as semantic state
 * ------------------------------------------------------------------ */

/** The most a snapshot's text alternative may hold. */
export const ARTIFACT_TEXT_LIMIT = 4000;

/** Text cut to a limit, saying how much was left out rather than ending mid-line as though that were all. */
function clipped(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const note = (left: number) => `\n… ${String(left)} more characters are on the card`;
  // The note is shorter when fewer characters are left out, so keep grows until the two fill the limit exactly.
  let keep = limit - note(text.length).length;
  while (keep + 1 + note(text.length - keep - 1).length <= limit) keep += 1;
  // A cut never falls inside a surrogate pair: half an emoji is not a character.
  const kept = sliceCodePoints(text, keep);
  return `${kept}${note(text.length - kept.length)}`;
}

function sizeText(bytes: number): string {
  return `${String(bytes)} byte${bytes === 1 ? "" : "s"}`;
}

/** The line a text alternative adds when the body holds hidden characters, written as markers in it. */
function hiddenNote(count: number): string {
  return count === 0 ? "" : `\nHolds ${String(count)} hidden character(s), each written here as ⟨U+…⟩ rather than applied.`;
}

/**
 * The card as plain text: the text alternative a reader gets when it cannot be drawn.
 *
 * Code and diffs keep their lines, so a transcript that outlives the renderer still holds the change; a body too long
 * for a snapshot says how much it left out. A hidden character in the body is written as its marker, as the page draws
 * it, so the transcript reads the way the card looks.
 */
export function artifactViewerText(content: ArtifactViewerContent, limit = ARTIFACT_TEXT_LIMIT): string {
  const title = content.card.title !== undefined && content.card.title !== "" ? `${content.card.title}: ` : "";
  if (content.kind === "code") {
    const card = content.card;
    const { first, last } = codeLineRange(card);
    const cut = card.truncated === true ? ", cut short" : "";
    const body = markHiddenCharacters(card.code);
    const head = `${title}${card.path ?? "Code"} (${codeLanguage(card) ?? "text"}, lines ${String(first)}-${String(last)}${cut})`;
    return clipped(`${head}${hiddenNote(body.count)}\n${body.text}`, limit);
  }
  if (content.kind === "diff") {
    const card = content.card;
    const counts = diffCounts(card);
    const cut = card.truncated === true ? "; part of the change is left out" : "";
    const head = `${title}${String(counts.files)} file(s) changed, +${String(counts.additions)} -${String(counts.deletions)}${cut}`;
    let hidden = 0;
    const body = card.files.map((file) => {
      const fileCounts = diffFileCounts(file);
      const renamed = file.oldPath === undefined ? "" : `${file.oldPath} -> `;
      const hunks = file.hunks.map((hunk) => {
        const lines = hunk.lines.map((line) => {
          const marked = markHiddenCharacters(line.text);
          hidden += marked.count;
          return `${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}${marked.text}`;
        });
        return [hunkHeader(hunk), ...lines].join("\n");
      });
      return [`${renamed}${file.path} +${String(fileCounts.additions)} -${String(fileCounts.deletions)}`, ...hunks].join("\n");
    });
    return clipped([`${head}${hiddenNote(hidden)}`, ...body].join("\n"), limit);
  }
  const card = content.card;
  const facts = [card.mediaType, card.sizeBytes === undefined ? undefined : sizeText(card.sizeBytes)].filter(
    (fact): fact is string => fact !== undefined,
  );
  const parts = [
    `${title}${card.name}${facts.length === 0 ? "" : ` (${facts.join(", ")})`}`,
    card.source === undefined || card.source === "" ? undefined : `from ${card.source}`,
    card.path === undefined ? undefined : `at ${card.path}`,
  ].filter((part): part is string => part !== undefined);
  const summary = card.summary === undefined || card.summary === "" ? "" : `. ${card.summary}`;
  return clipped(`${parts.join(", ")}${summary}`, limit);
}

/**
 * What the card means for voice and `inspect_ui`: names, a language, line counts; never the code itself.
 *
 * Bounded by `normalizeSemanticDoc` afterwards. The body stays out: a summary that read a whole file aloud would be a
 * worse answer to "what is this" than its name, language and size. How many hidden characters the body holds is said,
 * since that is what a person asking "is anything odd about this code" needs to hear.
 */
export function artifactViewerSemantic(content: ArtifactViewerContent): {
  title?: string;
  summary: string;
  values: Record<string, SemanticValue>;
} {
  const title = content.card.title !== undefined && content.card.title !== "" ? { title: content.card.title } : {};
  const hidden = hiddenCharacterCount(content);
  const hiddenSummary = hidden === 0 ? "" : `; holds ${String(hidden)} hidden character(s), shown as markers`;
  const hiddenValue = hidden === 0 ? {} : { hiddenCharacters: hidden };
  if (content.kind === "code") {
    const card = content.card;
    const { first, last, count } = codeLineRange(card);
    const language = codeLanguage(card) ?? "text";
    const truncated = card.truncated === true;
    return {
      ...title,
      summary:
        `Code as stated when shown: ${card.path ?? "untitled"} (${language}), ${String(count)} line(s), ` +
        `lines ${String(first)}-${String(last)}${truncated ? ", cut short" : ""}${hiddenSummary}`,
      values: {
        ...(card.path === undefined ? {} : { path: card.path }),
        language,
        lineCount: count,
        firstLine: first,
        lastLine: last,
        truncated,
        ...hiddenValue,
      },
    };
  }
  if (content.kind === "diff") {
    const card = content.card;
    const counts = diffCounts(card);
    const truncated = card.truncated === true;
    return {
      ...title,
      summary:
        `Diff as stated when shown: ${String(counts.files)} file(s), ${String(counts.additions)} line(s) added, ` +
        `${String(counts.deletions)} removed${truncated ? "; part of the change is left out" : ""}${hiddenSummary}`,
      values: {
        fileCount: counts.files,
        linesAdded: counts.additions,
        linesRemoved: counts.deletions,
        files: card.files.map((file) => {
          const fileCounts = diffFileCounts(file);
          return `${file.path} +${String(fileCounts.additions)} -${String(fileCounts.deletions)}`;
        }),
        truncated,
        ...hiddenValue,
      },
    };
  }
  const card = content.card;
  return {
    ...title,
    summary: `File as stated when shown: ${card.name}${card.mediaType === undefined ? "" : ` (${card.mediaType})`}`,
    values: {
      name: card.name,
      ...(card.mediaType === undefined ? {} : { mediaType: card.mediaType }),
      ...(card.sizeBytes === undefined ? {} : { sizeBytes: card.sizeBytes }),
      ...(card.source === undefined || card.source === "" ? {} : { source: card.source }),
      ...(card.path === undefined ? {} : { path: card.path }),
    },
  };
}
