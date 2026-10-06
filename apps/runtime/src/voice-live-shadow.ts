/**
 * The live session's reading of the person's words, kept while a dedicated recognizer is the source.
 *
 * It is only ever read once: if the recognizer fails, the sentence it was in the middle of is answered from here. Two
 * streams hear the same audio but do not deliver it at the same instants: the live reading of a sentence can arrive
 * after the recognizer has already finalized it, and the start of the next sentence can arrive before. Clearing one
 * shared buffer at every recognizer final therefore both doubled sentences (late words re-attached to the next one) and
 * lost them (early words wiped).
 *
 * So the live reading is kept as sentences of its own - closed by the live session's own boundaries: its final
 * fragment, a new utterance id, or a pause - and a recognizer final covers the live sentence that reads like it,
 * whether that sentence is already here or arrives later. Matching on the words rather than on timing or on counting
 * sentences is what survives one stream being late, early, or missing a sentence the other heard. What is not covered
 * when the recognizer fails is exactly what it had not delivered.
 */

const MAX_SENTENCES = 16;
const MAX_SENTENCE_CHARS = 8000;
/** Recognizer finals still waiting for their live reading to arrive. */
const MAX_AWAITING = 4;
/** Share of the shorter reading's words the two must have in common to be the same sentence. */
const SAME_SENTENCE_OVERLAP = 0.5;

interface Sentence {
  utteranceId: string;
  text: string;
  lastHeardMs: number;
  closed: boolean;
  covered: boolean;
}

export interface LiveFragment {
  utteranceId: string;
  text: string;
  isFinal: boolean;
}

export class LiveShadow {
  readonly #pauseMs: number;
  readonly #nowMs: () => number;
  #sentences: Sentence[] = [];
  /** Words of recognizer finals whose live reading has not arrived yet. */
  #awaiting: string[][] = [];

  constructor(options: { pauseMs: number; nowMs?: () => number }) {
    this.#pauseMs = options.pauseMs;
    this.#nowMs = options.nowMs ?? Date.now;
  }

  /** One fragment of the live reading. */
  hear(fragment: LiveFragment): void {
    const now = this.#nowMs();
    const last = this.#sentences.at(-1);
    const continues = last !== undefined && !last.closed && last.utteranceId === fragment.utteranceId && now - last.lastHeardMs < this.#pauseMs;
    let sentence: Sentence;
    if (continues) {
      sentence = last;
      sentence.text = `${sentence.text}${fragment.text}`.slice(-MAX_SENTENCE_CHARS);
      sentence.lastHeardMs = now;
      if (fragment.isFinal) sentence.closed = true;
    } else {
      if (last !== undefined) last.closed = true;
      // A close with no words of its own only ends the sentence it belongs to.
      if (fragment.text.trim() === "") return;
      sentence = { utteranceId: fragment.utteranceId, text: fragment.text.slice(-MAX_SENTENCE_CHARS), lastHeardMs: now, closed: fragment.isFinal, covered: false };
      this.#sentences.push(sentence);
      if (this.#sentences.length > MAX_SENTENCES) this.#sentences.shift();
    }
    if (!sentence.covered) {
      const heard = words(sentence.text);
      const match = this.#awaiting.findIndex((delivered) => sameSentence(delivered, heard));
      if (match >= 0) {
        sentence.covered = true;
        this.#awaiting.splice(match, 1);
      }
    }
  }

  /** The recognizer delivered a sentence: the live reading of it, now or when it arrives, is covered. */
  delivered(text: string): void {
    const said = words(text);
    if (said.length === 0) return;
    const match = this.#sentences.find((sentence) => !sentence.covered && sameSentence(said, words(sentence.text)));
    if (match !== undefined) {
      match.covered = true;
      return;
    }
    this.#awaiting.push(said);
    if (this.#awaiting.length > MAX_AWAITING) this.#awaiting.shift();
  }

  /** What the recognizer had not delivered, oldest first, and an empty shadow afterwards. */
  take(): string {
    const pending = this.#sentences
      .filter((sentence) => !sentence.covered)
      .map((sentence) => sentence.text.trim())
      .filter((text) => text !== "");
    this.#sentences = [];
    this.#awaiting = [];
    return pending.join(" ");
  }
}

function words(text: string): string[] {
  return [...text.toLowerCase().matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map((match) => match[0]);
}

/** Whether two readings are of the same sentence: enough of the shorter one's words appear in the other. */
function sameSentence(left: readonly string[], right: readonly string[]): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length === 0) return false;
  const pool = new Map<string, number>();
  for (const word of longer) pool.set(word, (pool.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of shorter) {
    const remaining = pool.get(word) ?? 0;
    if (remaining === 0) continue;
    pool.set(word, remaining - 1);
    shared += 1;
  }
  return shared / shorter.length >= SAME_SENTENCE_OVERLAP;
}
