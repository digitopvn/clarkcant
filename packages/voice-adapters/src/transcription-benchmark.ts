import type { RecognitionContext } from "@clarkcant/contracts";

import { type VocabularySources, buildRecognitionContext } from "./coding-vocabulary.ts";
import { normalizeTranscript } from "./transcript-normalizer.ts";
import {
  BENCHMARK_TERM_KINDS,
  type BenchmarkTerm,
  type BenchmarkTermKind,
  type TranscriptScore,
  scoreTranscripts,
  termPreserved,
} from "./transcription-metrics.ts";

/**
 * The transcription benchmark, as data and a scorer.
 *
 * A corpus holds what was said (`reference`, canonical spelling), the technical terms in it, and what each recognizer
 * produced. Every recognizer is scored twice: as it heard, and after the deterministic normaliser with the corpus's
 * own session vocabulary. The same scorer serves the text-level corpus checked into this package and an audio run
 * that adds measured outputs, so a provider comparison is the same table with more rows.
 */

export interface CorpusUtterance {
  id: string;
  categories: string[];
  reference: string;
  terms: BenchmarkTerm[];
  recognizers: Record<string, string>;
}

export interface BenchmarkCorpus {
  version: 1;
  description: string;
  context: VocabularySources & { languageHints?: string[] };
  utterances: CorpusUtterance[];
}

export interface RecognizerBenchmark {
  recognizer: string;
  raw: TranscriptScore;
  normalized: TranscriptScore;
  /** Normalisation changes applied across the corpus. */
  changes: number;
  /** Spans the normaliser read two ways and left as heard. */
  abstained: number;
  /** Utterances where normalisation lost a term the raw text had, or changed one that needed no change. */
  regressions: string[];
  /**
   * Utterances whose raw text holds a session term the person did not say: a vocabulary term heard but not said.
   *
   * This does not say what put the term there. On a recognizer biased with the vocabulary it may be the bias writing
   * over speech, which the `vocabulary-bias` entries (a person's name, another model version, a near-neighbour symbol)
   * exist to catch in an audio run; it may equally be an ordinary mishearing of a term never sent (`git stash` heard
   * as `git status`).
   */
  substitutions: string[];
}

/** Validate a parsed corpus at the boundary, so a malformed file fails with the utterance that is wrong. */
export function parseCorpus(value: unknown): BenchmarkCorpus {
  const record = asObject(value, "corpus");
  if (record["version"] !== 1) throw new Error("corpus: version must be 1");
  const utterances = record["utterances"];
  if (!Array.isArray(utterances)) throw new Error("corpus: utterances must be an array");
  const seen = new Set<string>();
  return {
    version: 1,
    description: typeof record["description"] === "string" ? record["description"] : "",
    context: parseContext(record["context"]),
    utterances: utterances.map((raw, index) => {
      const item = asObject(raw, `utterances[${index}]`);
      const id = asText(item["id"], `utterances[${index}].id`);
      if (seen.has(id)) throw new Error(`corpus: duplicate utterance id ${id}`);
      seen.add(id);
      const terms = item["terms"];
      if (!Array.isArray(terms)) throw new Error(`corpus: ${id}.terms must be an array`);
      const recognizers = asObject(item["recognizers"], `${id}.recognizers`);
      return {
        id,
        categories: Array.isArray(item["categories"]) ? item["categories"].filter((entry): entry is string => typeof entry === "string") : [],
        reference: asText(item["reference"], `${id}.reference`),
        terms: terms.map((term, termIndex) => {
          const entry = asObject(term, `${id}.terms[${termIndex}]`);
          const kind = asText(entry["kind"], `${id}.terms[${termIndex}].kind`);
          if (!(BENCHMARK_TERM_KINDS as readonly string[]).includes(kind)) throw new Error(`corpus: ${id} has unknown term kind ${kind}`);
          return { text: asText(entry["text"], `${id}.terms[${termIndex}].text`), kind: kind as BenchmarkTermKind };
        }),
        recognizers: Object.fromEntries(Object.entries(recognizers).map(([name, text]) => [name, asText(text, `${id}.recognizers.${name}`)])),
      };
    }),
  };
}

export function corpusContext(corpus: BenchmarkCorpus): RecognitionContext {
  const { languageHints, ...sources } = corpus.context;
  return buildRecognitionContext(sources, { languageHints: languageHints ?? [] });
}

/** Score one recognizer over every utterance that has an output from it. */
export function benchmarkRecognizer(corpus: BenchmarkCorpus, recognizer: string, context = corpusContext(corpus)): RecognizerBenchmark {
  const raw: Array<{ reference: string; hypothesis: string; terms: BenchmarkTerm[] }> = [];
  const normalized: typeof raw = [];
  let changes = 0;
  let abstained = 0;
  const regressions: string[] = [];
  const substitutions: string[] = [];
  for (const utterance of corpus.utterances) {
    const heard = utterance.recognizers[recognizer];
    if (heard === undefined) continue;
    // Both sides ignore case: a term the reference holds in another casing (`zod` for `Zod`) was said, and a term heard
    // in another casing (`jev` for `Jev`) was still heard.
    const said = utterance.reference.toLowerCase();
    const heardLower = heard.toLowerCase();
    if (context.terms.some((term) => termPreserved(term.text.toLowerCase(), heardLower) && !termPreserved(term.text.toLowerCase(), said))) substitutions.push(utterance.id);
    const result = normalizeTranscript(heard, context);
    changes += result.changes.length;
    abstained += result.abstained.length;
    raw.push({ reference: utterance.reference, hypothesis: heard, terms: utterance.terms });
    normalized.push({ reference: utterance.reference, hypothesis: result.text, terms: utterance.terms });
    const lostTerm = utterance.terms.some((term) => termPreserved(term.text, heard) && !termPreserved(term.text, result.text));
    const changedCorrect = heard === utterance.reference && result.text !== heard;
    if (lostTerm || changedCorrect) regressions.push(utterance.id);
  }
  return { recognizer, raw: scoreTranscripts(raw), normalized: scoreTranscripts(normalized), changes, abstained, regressions, substitutions };
}

/**
 * Utterances whose canonical reference the normaliser would change.
 *
 * What was said, spelled right, must come back exactly as it is: any id here is a rewrite of a correct sentence, which
 * is the one failure a normaliser is never allowed. The corpus carries negative entries (near neighbours such as
 * `setUser` beside `getUser`, a person's name that sounds like a term) so this is a real test and not a formality.
 */
export function unstableReferences(corpus: BenchmarkCorpus, context = corpusContext(corpus)): string[] {
  return corpus.utterances.filter((utterance) => normalizeTranscript(utterance.reference, context).text !== utterance.reference).map((utterance) => utterance.id);
}

export function recognizersIn(corpus: BenchmarkCorpus): string[] {
  return [...new Set(corpus.utterances.flatMap((utterance) => Object.keys(utterance.recognizers)))].sort();
}

/** A Markdown report: one row per recognizer and stage, then preservation by kind. */
export function formatBenchmarkReport(corpus: BenchmarkCorpus, results: readonly RecognizerBenchmark[]): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const unstable = unstableReferences(corpus);
  const lines = [
    `Corpus: ${corpus.utterances.length} utterances, ${corpus.utterances.reduce((sum, utterance) => sum + utterance.terms.length, 0)} technical terms.`,
    `Canonical references the normaliser would change: ${unstable.length}${unstable.length === 0 ? "" : ` (${unstable.join(", ")})`}.`,
    "",
    "| Recognizer | Stage | WER | CER | Technical Term Error Rate | Exact utterances | Changes | Abstained | Regressions |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    for (const [stage, score] of [["raw", result.raw], ["normalized", result.normalized]] as const) {
      lines.push(
        `| ${result.recognizer} | ${stage} | ${percent(score.wer)} | ${percent(score.cer)} | ${percent(score.technicalTermErrorRate)} | ${percent(score.exactUtteranceRate)} | ${stage === "raw" ? "-" : result.changes} | ${stage === "raw" ? "-" : result.abstained} | ${stage === "raw" ? "-" : result.regressions.length} |`,
      );
    }
  }
  lines.push("", "| Recognizer | Stage | " + BENCHMARK_TERM_KINDS.join(" | ") + " |", "| --- | --- | " + BENCHMARK_TERM_KINDS.map(() => "---").join(" | ") + " |");
  for (const result of results) {
    for (const [stage, score] of [["raw", result.raw], ["normalized", result.normalized]] as const) {
      const cells = BENCHMARK_TERM_KINDS.map((kind) => {
        const bucket = score.preservation[kind];
        return bucket === undefined ? "-" : `${bucket.preserved}/${bucket.total}`;
      });
      lines.push(`| ${result.recognizer} | ${stage} | ${cells.join(" | ")} |`);
    }
  }
  lines.push("", "Session terms heard where the person said something else (raw):");
  for (const result of results) {
    lines.push(`- ${result.recognizer}: ${result.substitutions.length}${result.substitutions.length === 0 ? "" : ` (${result.substitutions.join(", ")})`}`);
  }
  return lines.join("\n");
}

const CONTEXT_LISTS = [
  "repositories",
  "packages",
  "paths",
  "branches",
  "symbols",
  "issues",
  "tools",
  "models",
  "providers",
  "recentText",
  "languageHints",
] as const;

/** Every context list, when present, must be a list of strings; an unknown key is refused rather than ignored. */
function parseContext(value: unknown): BenchmarkCorpus["context"] {
  const record = asObject(value, "corpus.context");
  const context: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(record)) {
    if (!(CONTEXT_LISTS as readonly string[]).includes(key)) throw new Error(`corpus: context.${key} is not a known vocabulary source`);
    if (!Array.isArray(list) || !list.every((entry): entry is string => typeof entry === "string")) {
      throw new Error(`corpus: context.${key} must be an array of strings`);
    }
    context[key] = list;
  }
  return context;
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`corpus: ${where} must be an object`);
  return value as Record<string, unknown>;
}

function asText(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`corpus: ${where} must be a non-empty string`);
  return value;
}
