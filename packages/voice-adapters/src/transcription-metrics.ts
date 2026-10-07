/**
 * How a transcript is scored against what was said.
 *
 * WER and CER are the usual measures and are kept, but they are not the measure that matters for a coding assistant:
 * "use effect" for `useEffect` costs one word of WER and changes what the agent is asked about, while a dropped
 * "nhé" costs the same word and changes nothing. So technical terms are scored on their own, by exact,
 * case-sensitive preservation, per kind - a symbol, a command, a path - because a lower WER that loses a command is
 * a worse recognizer.
 */

export const BENCHMARK_TERM_KINDS = [
  "symbol",
  "command",
  "path",
  "package",
  "model",
  "provider",
  "acronym",
  "glossary",
  "version",
  "branch",
  "issue",
] as const;
export type BenchmarkTermKind = (typeof BENCHMARK_TERM_KINDS)[number];

export interface BenchmarkTerm {
  text: string;
  kind: BenchmarkTermKind;
}

export interface ScoredTranscript {
  reference: string;
  hypothesis: string;
  terms: readonly BenchmarkTerm[];
}

export interface TranscriptScore {
  utterances: number;
  /** Corpus-level: total word edits over total reference words. */
  wer: number;
  cer: number;
  /** Reference technical terms not preserved exactly, over all reference technical terms. */
  technicalTermErrorRate: number;
  /** Preservation per kind: exact, case-sensitive, on word boundaries. */
  preservation: Partial<Record<BenchmarkTermKind, { preserved: number; total: number; rate: number }>>;
  /** Utterances whose hypothesis equals the reference after whitespace is collapsed. */
  exactUtteranceRate: number;
}

/** Words for WER: lower case, punctuation at the edges of a word dropped, punctuation inside one (a path) kept. */
export function wordTokens(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(/\s+/u)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word !== "");
}

/** Levenshtein distance over any sequence, two rows at a time. */
export function editDistance<T>(left: readonly T[], right: readonly T[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current.push(Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost));
    }
    previous = current;
  }
  return previous[right.length]!;
}

export function wordErrorRate(reference: string, hypothesis: string): number {
  const words = wordTokens(reference);
  if (words.length === 0) return wordTokens(hypothesis).length === 0 ? 0 : 1;
  return editDistance(words, wordTokens(hypothesis)) / words.length;
}

function characters(text: string): string[] {
  return [...text.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim()];
}

export function characterErrorRate(reference: string, hypothesis: string): number {
  const expected = characters(reference);
  if (expected.length === 0) return characters(hypothesis).length === 0 ? 0 : 1;
  return editDistance(expected, characters(hypothesis)) / expected.length;
}

/** Whether `term` appears in `text` exactly, case included, not as part of a longer word. */
export function termPreserved(term: string, text: string): boolean {
  const haystack = text.normalize("NFC");
  const needle = term.normalize("NFC");
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if ((before === undefined || !/[\p{L}\p{N}_]/u.test(before)) && (after === undefined || !/[\p{L}\p{N}_]/u.test(after))) return true;
  }
  return false;
}

export function scoreTranscripts(items: readonly ScoredTranscript[]): TranscriptScore {
  let wordEdits = 0;
  let referenceWords = 0;
  let characterEdits = 0;
  let referenceCharacters = 0;
  let exact = 0;
  let termsTotal = 0;
  let termsLost = 0;
  const preservation: TranscriptScore["preservation"] = {};

  for (const item of items) {
    const words = wordTokens(item.reference);
    wordEdits += editDistance(words, wordTokens(item.hypothesis));
    referenceWords += words.length;
    const expected = characters(item.reference);
    characterEdits += editDistance(expected, characters(item.hypothesis));
    referenceCharacters += expected.length;
    if (collapse(item.reference) === collapse(item.hypothesis)) exact += 1;
    for (const term of item.terms) {
      const kept = termPreserved(term.text, item.hypothesis);
      termsTotal += 1;
      if (!kept) termsLost += 1;
      const bucket = preservation[term.kind] ?? { preserved: 0, total: 0, rate: 0 };
      bucket.total += 1;
      if (kept) bucket.preserved += 1;
      bucket.rate = bucket.preserved / bucket.total;
      preservation[term.kind] = bucket;
    }
  }

  return {
    utterances: items.length,
    wer: referenceWords === 0 ? 0 : wordEdits / referenceWords,
    cer: referenceCharacters === 0 ? 0 : characterEdits / referenceCharacters,
    technicalTermErrorRate: termsTotal === 0 ? 0 : termsLost / termsTotal,
    preservation,
    exactUtteranceRate: items.length === 0 ? 0 : exact / items.length,
  };
}

function collapse(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}
