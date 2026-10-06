import {
  MAX_NORMALIZATION_CHANGES,
  MAX_RECOGNITION_TERM_LENGTH,
  type RecognitionContext,
  type RecognitionTerm,
  type TranscriptNormalizationChange,
} from "@clarkcant/contracts";

/**
 * Deterministic transcript normalisation.
 *
 * A recognizer hears "use effect" and the person said `useEffect`; it writes "Github" for GitHub and "stale closer"
 * for stale closure. This puts the known spelling back, and nothing else: it is a lookup against the session's own
 * vocabulary, never a model, and it never rewrites a sentence. Four rules, each a fact about one term:
 *
 * - `casing`: the same word in the wrong case ("Github" -> GitHub). Never lowers a letter, so a sentence's first
 *   word stays as it was written.
 * - `spacing`: the term's own words, split the way speech splits them ("use effect" -> useEffect, "voice session dot
 *   ts" -> voice-session.ts).
 * - `alias`: a mis-hearing recorded for that term and no other ("stale closer" -> stale closure).
 * - `near-match`: a single-character slip on a long term ("playwrite" -> Playwright).
 *
 * It abstains rather than guesses. When a span reads as more than one known term it is left exactly as heard and
 * reported, so a targeted retry or the person can settle it. Every rule but a distinctive casing fix also needs the
 * utterance to be about code: another technical term in it, a coding word, or a Vietnamese sentence carrying the
 * English span - which is the code-switched case this exists for. "Use effect" in an English sentence about
 * something else is left alone.
 *
 * A command is never the result of a guess. Commands are recognized and kept, but no alias, spacing variant or near
 * match is ever rewritten into one: `git status` and `git stash` differ by what they do, and a normaliser that picked
 * between them would be deciding what runs.
 */

export interface NormalizationResult {
  /** The canonical text. Equal to the input when nothing applied. */
  text: string;
  changes: TranscriptNormalizationChange[];
  /** Spans with more than one known reading, left as heard. Offsets into the input. */
  abstained: Array<{ start: number; end: number; text: string; candidates: string[] }>;
  /** Spans of the input that are known technical terms, corrected or already right. */
  technical: Array<{ start: number; end: number }>;
}

type Rule = TranscriptNormalizationChange["rule"];
interface Token {
  lower: string;
  start: number;
  end: number;
}
interface Form {
  term: RecognitionTerm;
  rule: Rule;
}
interface Lexicon {
  forms: Map<string, Form[]>;
  longest: number;
  nearMatchable: Array<{ term: RecognitionTerm; compact: string }>;
  compacts: Array<{ term: RecognitionTerm; compact: string }>;
}

/**
 * Words that say an utterance is about code. Small and literal: a cue is evidence for applying a known spelling, not
 * a classifier of what the person meant.
 */
const TECHNICAL_CUES = new Set([
  "hook", "hooks", "component", "function", "file", "folder", "branch", "commit", "package", "dependency", "dependencies",
  "repo", "repository", "test", "tests", "build", "import", "export", "class", "type", "types", "interface", "bug",
  "error", "code", "merge", "deploy", "server", "model", "provider", "prompt", "install", "script", "config", "lint",
  "hàm", "biến", "nhánh", "tệp", "lỗi", "lệnh", "gói", "thư", "mục", "chạy", "cài",
]);

/** Letters that only Vietnamese uses among the languages this reads: a sentence with them is not English. */
const VIETNAMESE_LETTERS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/iu;

const SEPARATOR_BETWEEN_WORDS = /^[\s._/-]*$/u;
/** Terms shorter than this, once compacted, are never near-matched: a one-letter slip on a short word is a different word. */
const NEAR_MATCH_MIN_LENGTH = 7;
const MAX_FORM_WORDS = 6;

const lexicons = new WeakMap<RecognitionContext, Lexicon>();

export function normalizeTranscript(input: string, context: RecognitionContext): NormalizationResult {
  const text = input.normalize("NFC");
  const tokens = tokenize(text);
  const lexicon = lexiconFor(context);
  const codeSwitched = VIETNAMESE_LETTERS.test(text);

  type Hit = { from: number; to: number; candidates: Form[]; near: boolean };
  const hits: Hit[] = [];
  for (let index = 0; index < tokens.length; ) {
    const hit = matchAt(tokens, text, index, lexicon);
    if (hit === undefined) {
      index += 1;
      continue;
    }
    hits.push(hit);
    index = hit.to;
  }

  // Evidence that the utterance is about code, by position, so a span never counts as its own evidence.
  const anchors: number[] = [];
  tokens.forEach((token, index) => {
    if (TECHNICAL_CUES.has(token.lower)) anchors.push(index);
  });
  for (const hit of hits) {
    const unique = distinctTerms(hit.candidates);
    const source = text.slice(tokens[hit.from]!.start, tokens[hit.to - 1]!.end);
    // Only a term heard in its own spelling, case aside, is evidence: a corrected span supporting another correction
    // would let two guesses vouch for each other.
    const term = unique[0];
    if (unique.length === 1 && term !== undefined && !hit.near && source.toLowerCase() === term.text.toLowerCase() && (source === term.text || isDistinctive(term))) {
      for (let at = hit.from; at < hit.to; at += 1) anchors.push(at);
    }
  }
  const supported = (from: number, to: number): boolean => codeSwitched || anchors.some((at) => at < from || at >= to);

  const result: NormalizationResult = { text, changes: [], abstained: [], technical: [] };
  const replacements: Array<{ start: number; end: number; to: string }> = [];
  for (const hit of hits) {
    const start = tokens[hit.from]!.start;
    const end = tokens[hit.to - 1]!.end;
    const source = text.slice(start, end);
    const terms = distinctTerms(hit.candidates);
    if (terms.length > 1) {
      result.abstained.push({ start, end, text: source, candidates: terms.map((term) => term.text).slice(0, 8) });
      continue;
    }
    const term = terms[0]!;
    result.technical.push({ start, end });
    if (source === term.text) continue;

    const literal = strongestRule(hit.candidates);
    // A casing form heard with different separators ("node js" for Node.js) is a spacing change, not a casing one.
    const rule: Rule = literal === "casing" && source.toLowerCase() !== term.text.toLowerCase() ? "spacing" : literal;
    if (term.kind === "command" && rule !== "casing") continue;
    if (rule === "casing" && !raisesCaseOnly(source, term.text)) continue;
    const needsContext = rule !== "casing" || !isDistinctive(term);
    if (needsContext && !supported(hit.from, hit.to)) continue;
    if (result.changes.length >= MAX_NORMALIZATION_CHANGES) continue;

    replacements.push({ start, end, to: term.text });
    result.changes.push({ from: source.slice(0, MAX_RECOGNITION_TERM_LENGTH * 2), to: term.text, rule, kind: term.kind });
  }

  if (replacements.length > 0) {
    let output = "";
    let cursor = 0;
    for (const replacement of replacements) {
      output += text.slice(cursor, replacement.start) + replacement.to;
      cursor = replacement.end;
    }
    result.text = output + text.slice(cursor);
  }
  return result;
}

/** The longest known form starting at `index`, or a near match when no form starts there. */
function matchAt(
  tokens: readonly Token[],
  text: string,
  index: number,
  lexicon: Lexicon,
): { from: number; to: number; candidates: Form[]; near: boolean } | undefined {
  const longest = Math.min(lexicon.longest, tokens.length - index);
  for (let length = longest; length >= 1; length -= 1) {
    if (!joinedBySeparators(tokens, text, index, length)) continue;
    const key = tokens.slice(index, index + length).map((token) => token.lower).join(" ");
    const forms = lexicon.forms.get(key);
    if (forms !== undefined) return { from: index, to: index + length, candidates: forms, near: false };
  }
  for (let length = Math.min(3, tokens.length - index); length >= 1; length -= 1) {
    if (!joinedBySeparators(tokens, text, index, length)) continue;
    const compact = tokens.slice(index, index + length).map((token) => token.lower).join("");
    // Words that run together into the term exactly ("clark cant web" for clarkcant-web) are a spacing variant.
    const joined = length > 1 ? lexicon.compacts.filter((entry) => entry.compact === compact && entry.term.kind !== "command") : [];
    if (joined.length > 0) {
      return { from: index, to: index + length, candidates: joined.map((entry) => ({ term: entry.term, rule: "spacing" })), near: false };
    }
    if (compact.length < NEAR_MATCH_MIN_LENGTH - 1) continue;
    const near = lexicon.nearMatchable.filter(
      (entry) =>
        Math.abs(entry.compact.length - compact.length) <= 1 &&
        entry.compact !== compact &&
        // A plural is the same word used correctly, not a slip.
        compact !== `${entry.compact}s` &&
        withinOneEdit(entry.compact, compact),
    );
    if (near.length > 0) {
      return { from: index, to: index + length, candidates: near.map((entry) => ({ term: entry.term, rule: "near-match" })), near: true };
    }
  }
  return undefined;
}

function joinedBySeparators(tokens: readonly Token[], text: string, index: number, length: number): boolean {
  for (let at = index; at < index + length - 1; at += 1) {
    if (!SEPARATOR_BETWEEN_WORDS.test(text.slice(tokens[at]!.end, tokens[at + 1]!.start))) return false;
  }
  return true;
}

function lexiconFor(context: RecognitionContext): Lexicon {
  const cached = lexicons.get(context);
  if (cached !== undefined) return cached;
  const forms = new Map<string, Form[]>();
  let longest = 1;
  const add = (words: readonly string[], form: Form): void => {
    if (words.length === 0 || words.length > MAX_FORM_WORDS) return;
    // A form of digits alone ("468" for #468) would rewrite every number said near a technical word.
    if (words.every((word) => /^\p{N}+$/u.test(word))) return;
    const key = words.join(" ");
    const list = forms.get(key) ?? [];
    if (!list.some((existing) => existing.term === form.term)) list.push(form);
    forms.set(key, list);
    longest = Math.max(longest, words.length);
  };
  const nearMatchable: Lexicon["nearMatchable"] = [];
  const compacts: Lexicon["compacts"] = [];
  for (const term of context.terms) {
    add(tokenize(term.text).map((token) => token.lower), { term, rule: "casing" });
    add(spokenWords(term.text), { term, rule: "spacing" });
    if (term.text.includes(".")) {
      for (const dot of ["dot", "chấm"]) add(spokenWords(term.text.replaceAll(".", ` ${dot} `)), { term, rule: "spacing" });
    }
    if (/^[A-Z]{2,5}$/u.test(term.text)) add([...term.text.toLowerCase()], { term, rule: "spacing" });
    for (const alias of term.aliases ?? []) add(tokenize(alias).map((token) => token.lower), { term, rule: "alias" });
    const compact = tokenize(term.text).map((token) => token.lower).join("");
    if (!/^\p{N}+$/u.test(compact)) compacts.push({ term, compact });
    if (term.kind !== "command" && compact.length >= NEAR_MATCH_MIN_LENGTH) nearMatchable.push({ term, compact });
  }
  const lexicon = { forms, longest, nearMatchable, compacts };
  lexicons.set(context, lexicon);
  return lexicon;
}

/** Letters and digits, as words, with their offsets. Everything else is a separator. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.normalize("NFC").matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    tokens.push({ lower: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** A spelling's words as speech says them: identifiers split at their case changes. */
function spokenWords(text: string): string[] {
  return text
    .normalize("NFC")
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

/** A term nobody writes by accident: inner capitals, an acronym, digits, or code punctuation. */
function isDistinctive(term: RecognitionTerm): boolean {
  return /\p{Ll}\p{Lu}|\p{Lu}{2}|\p{N}|[._/-]/u.test(term.text);
}

/** Whether `to` differs from `from` only by raising letters to capitals. Lowering is never a correction here. */
function raisesCaseOnly(from: string, to: string): boolean {
  if (from.length !== to.length || from.toLowerCase() !== to.toLowerCase()) return true;
  for (let index = 0; index < from.length; index += 1) {
    const before = from[index]!;
    const after = to[index]!;
    if (before !== after && before !== before.toLowerCase()) return false;
  }
  return true;
}

function distinctTerms(forms: readonly Form[]): RecognitionTerm[] {
  const seen = new Map<string, RecognitionTerm>();
  for (const form of forms) if (!seen.has(form.term.text)) seen.set(form.term.text, form.term);
  return [...seen.values()];
}

/** The rule a single-term hit is reported under: the most literal one that matched. */
function strongestRule(forms: readonly Form[]): Rule {
  const order: Rule[] = ["casing", "spacing", "alias", "near-match"];
  return order.find((rule) => forms.some((form) => form.rule === rule)) ?? "near-match";
}

/** Damerau-Levenshtein distance of at most one, without building the matrix. */
export function withinOneEdit(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  if (left.length === right.length) {
    if (left.slice(start + 1) === right.slice(start + 1)) return true;
    return left[start] === right[start + 1] && left[start + 1] === right[start] && left.slice(start + 2) === right.slice(start + 2);
  }
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  return shorter.slice(start) === longer.slice(start + 1);
}
