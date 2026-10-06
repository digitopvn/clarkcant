import {
  type RecognitionContext,
  type RecognitionProvenance,
  type RecognizedUtterance,
  recognitionProvenanceSchema,
} from "@clarkcant/contracts";

import type { SpeechRecognitionAdapter } from "./recognition.ts";
import { type NormalizationResult, normalizeTranscript } from "./transcript-normalizer.ts";
import { wordErrorRate } from "./transcription-metrics.ts";

/**
 * From a final recognition result to the canonical utterance.
 *
 * Three steps, all deterministic in what they decide: normalise against the session vocabulary; look for a technical
 * span the recognizer was unsure of, or one the normaliser could read two ways; and, only then, recognize that one
 * completed utterance again with a context focused on the candidates, and keep whichever reading is better by a fixed
 * comparison. Nothing here asks a model to rewrite a sentence, and nothing here sends a transcript to Jev: the
 * selector decides between bounded options elsewhere, and a transcript is not one.
 *
 * Asking the person is not done here either. A span that stays ambiguous stays as heard, and the provenance says so;
 * whether that is worth a question is for the conversation to decide, not for every technical word.
 */

/** Below this, a provider's span confidence counts as unsure. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;
/** A retry slower than this is abandoned and the original reading kept: the person is waiting. */
export const DEFAULT_RETRY_TIMEOUT_MS = 4000;
/** A retry that differs from the original by more than this share of words heard a different sentence. */
const MAX_RETRY_DIVERGENCE = 0.5;

export type RetryReason = NonNullable<RecognitionProvenance["retry"]>["reason"];

/**
 * Recognize one completed utterance again.
 *
 * Given the utterance's own audio, bounded and never stored, and a context focused on what was uncertain. Returns the
 * recognized text, or nothing when it heard nothing. `signal` aborts when the caller stops waiting: a retry past its
 * bound must close whatever it opened, not keep running unseen.
 */
export type UtteranceRetry = (input: {
  audio: Uint8Array;
  context: RecognitionContext;
  reason: RetryReason;
  signal: AbortSignal;
}) => Promise<string | undefined>;

export interface SettledUtterance {
  /** The reading that was kept, before normalisation. */
  heard: string;
  /** The canonical text: what becomes the person's message. */
  text: string;
  provenance: RecognitionProvenance;
}

export interface SettleInput {
  utterance: RecognizedUtterance;
  context: RecognitionContext;
  /** The utterance's audio, when it was kept for a retry. */
  audio?: Uint8Array;
  retry?: UtteranceRetry;
  retryTimeoutMs?: number;
  nowMs?: () => number;
}

export async function settleUtterance(input: SettleInput): Promise<SettledUtterance> {
  const clock = input.nowMs ?? (() => performance.now());
  const startedAt = clock();
  const { utterance, context } = input;
  const assessed = assess(utterance, context);
  const { original, lowTechnical, reason } = assessed;

  let heard = utterance.text;
  let chosen = original;
  let retry: RecognitionProvenance["retry"];
  if (reason !== undefined) {
    if (input.retry === undefined || input.audio === undefined || input.audio.byteLength === 0) {
      retry = { reason, outcome: "unavailable" };
    } else {
      const focused = focusContext(context, original.abstained.flatMap((span) => span.candidates));
      const abort = new AbortController();
      try {
        const alternative = await withTimeout(
          input.retry({ audio: input.audio, context: focused, reason, signal: abort.signal }),
          input.retryTimeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS,
          abort,
        );
        if (alternative !== undefined && preferAlternative(utterance.text, alternative, context, lowTechnical.length)) {
          heard = alternative;
          chosen = normalizeTranscript(alternative, context);
          retry = { reason, outcome: "used-retry" };
        } else {
          retry = { reason, outcome: "kept-original" };
        }
      } catch {
        retry = { reason, outcome: "failed" };
      }
    }
  }
  return {
    heard,
    text: chosen.text,
    provenance: provenanceOf(utterance, context, assessed, chosen, retry, Math.max(0, clock() - startedAt)),
  };
}

/**
 * Settle an utterance that cannot be recognized again: normalise it and record what was done.
 *
 * Synchronous, for a transcript that arrives without audio of its own - the live session's input transcription - where
 * a retry has nothing to run on. A span that would have earned one is reported as `unavailable`, never hidden.
 */
export function settleUtteranceNow(input: { utterance: RecognizedUtterance; context: RecognitionContext }): SettledUtterance {
  const assessed = assess(input.utterance, input.context);
  const retry = assessed.reason === undefined ? undefined : { reason: assessed.reason, outcome: "unavailable" as const };
  return {
    heard: input.utterance.text,
    text: assessed.original.text,
    provenance: provenanceOf(input.utterance, input.context, assessed, assessed.original, retry, 0),
  };
}

type RecognitionSpan = NonNullable<RecognizedUtterance["spans"]>[number];

interface Assessment {
  original: NormalizationResult;
  lowSpans: RecognitionSpan[];
  lowTechnical: RecognitionSpan[];
  reason: RetryReason | undefined;
}

function assess(utterance: RecognizedUtterance, context: RecognitionContext): Assessment {
  const original = normalizeTranscript(utterance.text, context);
  const lowSpans = (utterance.spans ?? []).filter((span) => span.confidence < LOW_CONFIDENCE_THRESHOLD);
  const lowTechnical = lowSpans.filter(
    (span) => original.technical.some((technical) => overlaps(span, technical)) || looksLikeCode(utterance.text.slice(span.start, span.end)),
  );
  const reason: RetryReason | undefined =
    original.abstained.length > 0 ? "ambiguous-technical-span" : lowTechnical.length > 0 ? "low-confidence-technical-span" : undefined;
  return { original, lowSpans, lowTechnical, reason };
}

function provenanceOf(
  utterance: RecognizedUtterance,
  context: RecognitionContext,
  assessed: Assessment,
  chosen: NormalizationResult,
  retry: RecognitionProvenance["retry"],
  settleMs: number,
): RecognitionProvenance {
  const spanConfidences = (utterance.spans ?? []).map((span) => span.confidence);
  return recognitionProvenanceSchema.parse({
    utteranceId: utterance.utteranceId,
    provider: utterance.provider,
    model: utterance.model,
    contextApplied: utterance.contextApplied,
    termCount: context.terms.length,
    ...(utterance.languages === undefined ? {} : { languages: utterance.languages }),
    ...(utterance.confidence === undefined && spanConfidences.length === 0
      ? {}
      : {
          confidence: {
            ...(utterance.confidence === undefined ? {} : { utterance: utterance.confidence }),
            ...(spanConfidences.length === 0 ? {} : { lowestSpan: Math.min(...spanConfidences) }),
            lowSpans: assessed.lowSpans.length,
          },
        }),
    normalization: chosen.changes,
    abstained: chosen.abstained.length,
    ...(retry === undefined ? {} : { retry }),
    settleMs,
  });
}

/**
 * Whether a retried reading replaces the original. Fixed rules, original wins ties:
 *
 * - the retry must be the same sentence (at most half its words differ), so a retry that misheard everything cannot
 *   replace one that misheard one word;
 * - it must leave fewer ambiguous technical spans, or, when the trigger was low confidence, recognize more known
 *   terms without adding ambiguity.
 */
export function preferAlternative(original: string, alternative: string, context: RecognitionContext, lowTechnicalSpans = 0): boolean {
  if (alternative.trim() === "" || wordErrorRate(original, alternative) > MAX_RETRY_DIVERGENCE) return false;
  const before = normalizeTranscript(original, context);
  const after = normalizeTranscript(alternative, context);
  if (after.abstained.length < before.abstained.length && after.technical.length >= before.technical.length) return true;
  return lowTechnicalSpans > 0 && after.abstained.length <= before.abstained.length && after.technical.length > before.technical.length;
}

/** The session context with the uncertain candidates first and at full weight, for a retry. */
export function focusContext(context: RecognitionContext, candidates: readonly string[]): RecognitionContext {
  if (candidates.length === 0) return context;
  const wanted = new Set(candidates);
  const focused = context.terms.filter((term) => wanted.has(term.text)).map((term) => ({ ...term, weight: 1 }));
  const rest = context.terms.filter((term) => !wanted.has(term.text));
  return { ...context, terms: [...focused, ...rest] };
}

/**
 * A recognizer as an `UtteranceRetry`: a fresh session per retry, fed one utterance's audio and closed.
 *
 * The audio is sent in 100 ms frames and then the pause signal, so the recognizer finalizes it without waiting for a
 * silence that is not in the buffer. Finals are collected until the recognizer has been quiet for `quietMs`.
 */
export function recognizerRetry(options: {
  createRecognizer: () => SpeechRecognitionAdapter;
  tokenProvider: () => Promise<string>;
  quietMs?: number;
}): UtteranceRetry {
  let count = 0;
  return async ({ audio, context, signal }) => {
    if (signal.aborted) return undefined;
    const recognizer = options.createRecognizer();
    count += 1;
    const finals: string[] = [];
    let settle: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quiet = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(settle, options.quietMs ?? 700);
    };
    const unsubscribe = recognizer.onUtterance((utterance) => {
      if (!utterance.isFinal) return;
      if (utterance.text.trim() !== "") finals.push(utterance.text.trim());
      arm();
    });
    // The caller stopped waiting: close the session now, which also releases a start still waiting for setup.
    const onAbort = (): void => {
      settle();
      void recognizer.stop().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await recognizer.start({ sessionId: `retry-${count}`, tokenProvider: options.tokenProvider, context });
      if (signal.aborted) return undefined;
      for (let at = 0; at < audio.byteLength; at += RETRY_FRAME_BYTES) recognizer.sendAudio(audio.subarray(at, at + RETRY_FRAME_BYTES));
      recognizer.endAudio?.();
      arm();
      await quiet;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      await recognizer.stop().catch(() => undefined);
    }
    if (signal.aborted) return undefined;
    const text = finals.join(" ").trim();
    return text === "" ? undefined : text;
  };
}

/** 100 ms of PCM16 at 16 kHz mono. */
const RETRY_FRAME_BYTES = 3200;

/**
 * The audio of the utterance being spoken, kept only long enough to recognize it again.
 *
 * In memory, bounded to the newest `maxBytes`, and emptied when the utterance settles. Nothing here is written
 * anywhere: a retry is the only reader.
 */
export class UtteranceAudioBuffer {
  readonly #maxBytes: number;
  #chunks: Uint8Array[] = [];
  #bytes = 0;

  /** Thirty seconds of PCM16 at 16 kHz mono by default. */
  constructor(maxBytes = 30 * 32_000) {
    this.#maxBytes = maxBytes;
  }

  push(frame: Uint8Array): void {
    if (frame.byteLength === 0 || frame.byteLength > this.#maxBytes) return;
    this.#chunks.push(frame.slice());
    this.#bytes += frame.byteLength;
    while (this.#bytes > this.#maxBytes) {
      const dropped = this.#chunks.shift();
      this.#bytes -= dropped?.byteLength ?? 0;
    }
  }

  /** Everything kept, as one buffer, and empty afterwards. */
  take(): Uint8Array {
    const out = new Uint8Array(this.#bytes);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.clear();
    return out;
  }

  clear(): void {
    this.#chunks = [];
    this.#bytes = 0;
  }

  get byteLength(): number {
    return this.#bytes;
  }
}

function overlaps(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end;
}

/** A span that is plainly code even when no vocabulary term covers it: inner capitals, separators, digits in a word. */
function looksLikeCode(text: string): boolean {
  return /\p{Ll}\p{Lu}|[_/]|\.\p{L}{1,6}\b|\p{L}\p{N}/u.test(text);
}

/** The work, or a rejection after `timeoutMs` - at which point `abort` tells the work to stop. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, abort: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The abandoned work may still reject later; that is expected and not an unhandled failure.
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("the retry took too long"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
