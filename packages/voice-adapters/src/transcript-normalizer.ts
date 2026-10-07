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
 * - `casing`: the same word in the wrong case ("Github" -> GitHub). A letter is lowered only to restore a code-like
 *   term heard exactly, case aside ("RedactSecrets" -> redactSecrets, "PNPM verify" -> pnpm verify, "Git stash" ->
 *   git stash); any other word, such as an ordinary word starting a sentence, keeps the capital it was written with.
 * - `spacing`: the term's own words, split the way speech splits them ("use effect" -> useEffect, "voice session dot
 *   ts" -> voice-session.ts).
 * - `alias`: a mis-hearing recorded for that term and no other ("stale closer" -> stale closure).
 * - `near-match`: a single-character slip in one word of a long glossary, provider or model name ("playwrigt" ->
 *   Playwright). Never into a symbol, path, branch or package, whose near neighbours are other real names, and never
 *   from text already written as code.
 *
 * Part of a longer written word (`live` in `gemini-live.tsx`) is never touched, and punctuation the spelling carries
 * is not written twice.
 *
 * It abstains rather than guesses. When a span reads as more than one known term it is left exactly as heard and
 * reported, so a targeted retry or the person can settle it. Every rule but a distinctive casing fix also needs the
 * utterance to be about code: another technical term in it, a coding word, or a Vietnamese sentence carrying the
 * English span - which is the code-switched case this exists for. "Use effect" in an English sentence about
 * something else is left alone.
 *
 * A command is never the result of a guess. Commands are recognized and kept, but no alias, spacing variant or near
 * match is ever rewritten into one: `git status` and `git stash` differ by what they do, and a normaliser that picked
 * between them would be deciding what runs. For the same reason no respelled word is allowed to complete a command
 * with its neighbours ("git re base" stays as heard). Restoring case is the one exception, because it changes how a
 * command is written and never which command it is: "Git stash" becomes `git stash`, but `npm` never becomes `pnpm`,
 * even in a project whose vocabulary says pnpm. That is a product decision (#574): only case is restored, and a
 * command is never guessed.
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
  nearMatchable: Array<{ term: RecognitionTerm; words: string[] }>;
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

/**
 * Vietnamese letters: every vowel with a tone mark, plus ă â đ ê ô ơ ư. A sentence with one is not English. A few of
 * them (à é ó ...) also occur in borrowed English words; that only makes the evidence weaker, never a rewrite on its own.
 */
const VIETNAMESE_LETTERS = /[àáãảạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/iu;

const SEPARATOR_BETWEEN_WORDS = /^[\s._/-]*$/u;
/** Terms shorter than this, once compacted, are never near-matched: a one-letter slip on a short word is a different word. */
const NEAR_MATCH_MIN_LENGTH = 7;
const MAX_FORM_WORDS = 6;
/**
 * The kinds a one-character slip may be corrected into. Names people say - glossary words, providers, models - have one
 * spelling and no near neighbours that mean something else. Symbols, paths, branches and packages do: `setUser` and
 * `getUser`, `app.ts` and `app.tsx` are one edit apart and are different things, so for them only an exact spoken form
 * counts.
 */
const NEAR_MATCHABLE_KINDS: ReadonlySet<RecognitionTerm["kind"]> = new Set(["glossary", "provider", "model"]);
/** Characters that join a word to the next inside one written token: `gemini-live.tsx`, `@scope/name`, `a/b`. */
const JOINER = /[._/\\@#:-]/u;
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u;
/** Text that is already written as code: inner capitals, a joiner between letters, or digits in a word. */
const IDENTIFIER_SHAPED = /\p{Ll}\p{Lu}|[\p{L}\p{N}][._/\\@#-][\p{L}\p{N}]|\p{L}\p{N}|\p{N}\p{L}/u;
/** A version or number: never near-matched, since one character is the whole difference between two of them. */
const HAS_DIGIT = /\p{N}/u;

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
    const terms = distinctTerms(hit.candidates);
    // Punctuation the spelling itself carries ("@" of a scoped package, a trailing "/") belongs to the span when the
    // text already has it, so a replacement never writes it twice.
    const single = terms.length === 1 ? terms[0] : undefined;
    const start = tokens[hit.from]!.start - (single === undefined ? 0 : presentBefore(text, tokens[hit.from]!.start, leadingMarks(single.text)));
    const end = tokens[hit.to - 1]!.end + (single === undefined ? 0 : presentAfter(text, tokens[hit.to - 1]!.end, trailingMarks(single.text)));
    // Part of a longer written word - `gemini-live.tsx`, `src/app.ts` - is somebody's own spelling of something else,
    // not this term: it is neither corrected nor reported.
    if (embeddedInWord(text, start, end)) continue;
    const source = text.slice(start, end);
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
    // Nor is a command assembled from a guess: "git re base" stays as heard rather than becoming `git rebase` because
    // its last word was respelled. Which command runs is never the normaliser's decision.
    if (rule !== "casing" && completesCommand(tokens, hit.from, hit.to, term, lexicon)) continue;
    // Lowering a letter restores a code-like term heard exactly, case aside, and nothing else: "RedactSecrets" is
    // `redactSecrets`, but "Rebase" starting a sentence is the word rebase written as a sentence starts.
    const lowers = rule === "casing" && !raisesCaseOnly(source, term.text);
    if (lowers && !isCodeLike(term)) continue;
    // A command heard in its own words is evidence enough for its own case: "Git stash" names no other command. A
    // lowercase tool name that is code-like only for a hyphen or digit ("follow-up", "s3") may also be an ordinary
    // word starting a sentence, so lowering it needs the same evidence as any plain word.
    const needsContext =
      rule !== "casing" || (lowers && isWordLikeTool(term)) || !(isDistinctive(term) || (lowers && term.kind === "command"));
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
    // Something already written as code was written on purpose; a slip is a spoken word, not an identifier.
    if (IDENTIFIER_SHAPED.test(text.slice(tokens[index]!.start, tokens[index + length - 1]!.end))) continue;
    const heard = tokens.slice(index, index + length).map((token) => token.lower);
    const near = lexicon.nearMatchable.filter((entry) => isSlipOf(entry.words, heard));
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
    if (NEAR_MATCHABLE_KINDS.has(term.kind) && compact.length >= NEAR_MATCH_MIN_LENGTH) {
      nearMatchable.push({ term, words: tokenize(term.text).map((token) => token.lower) });
    }
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

/**
 * A term only ever written as code, so a capital it does not have is a recognizer's, not the person's: mixed case
 * (`redactSecrets`, `OAuth`), a digit (`gpt-4o`), code punctuation (`git-stash`, `voice-session.ts`), or a command
 * (`git stash`, `pnpm verify`). A plain word - `rebase`, `worktree`, `pnpm`, a repository called `clarkcant`, a symbol
 * called `update` - is also an ordinary word, and a sentence may start with it. A tool is judged by its spelling like
 * every other kind: the session's tools include installed skill and extension names, which are often plain words
 * (`test`, `review`, `weather`, `deploy`, `tasks`).
 */
function isCodeLike(term: RecognitionTerm): boolean {
  return term.kind === "command" || /\p{Ll}\p{Lu}|\p{Lu}{2}\p{Ll}|\p{N}|[._/\\@#:-]/u.test(term.text);
}

/**
 * A tool name that is all lowercase and code-like only because of a hyphen or a digit: `follow-up`, `check-in`, `s3`,
 * `daily-notes`. Skill names like these are often ordinary English ("Follow-up with the team", "S3 is down"), so the
 * spelling alone does not say a capital was the recognizer's.
 */
function isWordLikeTool(term: RecognitionTerm): boolean {
  return term.kind === "tool" && /^[\p{Ll}\p{N}-]+$/u.test(term.text);
}

/** Whether `to` differs from `from` only by raising letters to capitals. Lowering is decided separately. */
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

/**
 * Whether the heard words are the term's own words with exactly one of them slipped by one character.
 *
 * Word for word, so a slip never absorbs a neighbour: "a pull request" is three words and `pull request` two, and the
 * "a" is the person's, not a typo in the term.
 *
 * A word carrying a digit never slips: one character is the whole difference between two versions, so "claude opus 3"
 * is another model the person named, not a mis-hearing of `claude-opus-4`.
 */
function isSlipOf(termWords: readonly string[], heard: readonly string[]): boolean {
  if (termWords.length !== heard.length) return false;
  let slips = 0;
  for (let index = 0; index < heard.length; index += 1) {
    const want = termWords[index]!;
    const got = heard[index]!;
    if (want === got) continue;
    if (HAS_DIGIT.test(want) || HAS_DIGIT.test(got)) return false;
    // A plural is the same word used correctly, not a slip.
    if (got === `${want}s` || !withinOneEdit(want, got)) return false;
    slips += 1;
  }
  return slips === 1;
}

/** The punctuation a spelling starts with, such as the `@` of a scoped package. */
function leadingMarks(spelling: string): string {
  return /^[^\p{L}\p{M}\p{N}]*/u.exec(spelling)?.[0] ?? "";
}

/** The punctuation a spelling ends with. */
function trailingMarks(spelling: string): string {
  return /[^\p{L}\p{M}\p{N}]*$/u.exec(spelling)?.[0] ?? "";
}

/** How much of `marks` the text already has just before `at`, taken whole or not at all. */
function presentBefore(text: string, at: number, marks: string): number {
  return marks !== "" && text.slice(Math.max(0, at - marks.length), at) === marks ? marks.length : 0;
}

/** How much of `marks` the text already has just after `at`, taken whole or not at all. */
function presentAfter(text: string, at: number, marks: string): number {
  return marks !== "" && text.slice(at, at + marks.length) === marks ? marks.length : 0;
}

/** Whether the span is glued to more of the same written word on either side, as `live` is in `gemini-live.tsx`. */
function embeddedInWord(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  const wordBefore = before !== undefined && (WORD_CHARACTER.test(before) || (JOINER.test(before) && WORD_CHARACTER.test(text[start - 2] ?? "")));
  const wordAfter = after !== undefined && (WORD_CHARACTER.test(after) || (JOINER.test(after) && WORD_CHARACTER.test(text[end + 1] ?? "")));
  return wordBefore || wordAfter;
}

/** Whether writing `term` over tokens `from..to` would make it, with a word or two around it, a known command. */
function completesCommand(tokens: readonly Token[], from: number, to: number, term: RecognitionTerm, lexicon: Lexicon): boolean {
  const words = tokenize(term.text).map((token) => token.lower);
  for (let before = 0; before <= 2; before += 1) {
    for (let after = 0; after <= 2; after += 1) {
      if ((before === 0 && after === 0) || from - before < 0 || to + after > tokens.length) continue;
      const key = [
        ...tokens.slice(from - before, from).map((token) => token.lower),
        ...words,
        ...tokens.slice(to, to + after).map((token) => token.lower),
      ].join(" ");
      if (lexicon.forms.get(key)?.some((form) => form.term.kind === "command") === true) return true;
    }
  }
  return false;
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
