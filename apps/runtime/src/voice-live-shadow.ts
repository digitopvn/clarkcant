/**
 * The live session's reading of the person's words, kept while a dedicated recognizer is the source.
 *
 * It is only ever read once: if the recognizer fails, what it had not delivered is answered from here. Two streams hear
 * the same audio but neither delivers at the same instants nor cuts sentences in the same places: the live reading of
 * a sentence can arrive after the recognizer finalized it, one live utterance can hold two of the recognizer's
 * sentences, and either stream can pause mid-sentence.
 *
 * So the live reading is kept as the live session cut it - a sentence ends only at its own final fragment or a new
 * utterance id, never at a pause - and a cursor marks how far the recognizer has delivered. A recognizer final moves
 * the cursor when its words are, in order, the beginning of what the live reading holds after the cursor; it may cover
 * a whole live sentence or only its first part, and the rest stays undelivered. Finals arrive in order, so a match
 * further on also settles the live sentences it passes: the recognizer delivered them in a reading too different to
 * match.
 *
 * Every rule leans towards answering words twice over losing them:
 * - a final shorter than three words never moves the cursor, because short common sentences ("cái này không") look
 *   alike whatever was said;
 * - two readings match only when they differ by a few characters, never by a whole word;
 * - a final whose live reading has not arrived waits only for the live sentence in progress and the next one, and only
 *   for a few seconds, so it cannot match an unrelated sentence later;
 * - when a final never found its live reading, or matched only after passing over a live sentence it did not match,
 *   the alignment is unclear: every live sentence after the last one a final fully covered is answered, whole and in
 *   order, since the live session may have cut the sentence the recognizer was in the middle of into several
 *   utterances; a sentence already delivered whole is not answered again;
 * - a final that expired without finding its live reading is still remembered for a while, because the live reading
 *   often arrives only after the recognizer finalized the next sentence: in unclear mode a live sentence heard close
 *   in time to it that reads as it, or as its beginning, under the same three-word and few-character rule, was
 *   delivered and is not answered again. Each remembered final excuses one live sentence at most.
 */

const MAX_SENTENCES = 16;
const MAX_SENTENCE_CHARS = 8000;
/** Recognizer finals still waiting for their live reading to arrive. */
const MAX_PENDING = 4;
/** How long a recognizer final waits for its live reading. */
const PENDING_MS = 5000;
/** Fewer words than this are too common to tell two sentences apart. */
const MIN_MATCH_WORDS = 3;
/** Character edits allowed per character of the delivered final: "closer" for "closure", not another word. */
const EDITS_PER_CHAR = 0.15;
/** Longest stretch compared, so one alignment stays cheap; anything past it stays undelivered. */
const MAX_COMPARE_CHARS = 1200;
/**
 * Expired finals remembered: one can only excuse a live sentence still kept, and at most MAX_SENTENCES are kept.
 */
const MAX_EXPIRED = MAX_SENTENCES;
/**
 * How far apart in time an expired final and the live sentence it excuses may be. The live reading of a final lags it
 * by a few seconds, a few sentences at worst; half a minute covers that while a sentence said again later is answered.
 */
const EXPIRED_MATCH_MS = 30_000;

interface Sentence {
  ordinal: number;
  utteranceId: string;
  text: string;
  closed: boolean;
  /** When its first fragment was heard. */
  heardMs: number;
}

interface Pending {
  words: string[];
  deliveredMs: number;
  deadlineMs: number;
  /** The last live sentence this final may still be the reading of. */
  lastOrdinal: number;
}

interface Word {
  text: string;
  end: number;
}

export interface LiveFragment {
  utteranceId: string;
  text: string;
  isFinal: boolean;
}

export class LiveShadow {
  readonly #nowMs: () => number;
  #sentences: Sentence[] = [];
  #nextOrdinal = 0;
  /** Everything before this point of the live reading was delivered by the recognizer. */
  #cursor = { ordinal: 0, offset: 0 };
  #pending: Pending[] = [];
  /** A recognizer final never found its live reading, so what lies after the cursor is not known to be undelivered. */
  #unclear = false;
  /** Finals that left the waiting list without finding their live reading, oldest first. */
  #expired: Pending[] = [];

  constructor(options: { nowMs?: () => number } = {}) {
    this.#nowMs = options.nowMs ?? Date.now;
  }

  /** One fragment of the live reading. */
  hear(fragment: LiveFragment): void {
    this.#expire();
    const last = this.#sentences.at(-1);
    const continues =
      last !== undefined &&
      !last.closed &&
      last.utteranceId === fragment.utteranceId &&
      last.text.length + fragment.text.length <= MAX_SENTENCE_CHARS;
    if (continues) {
      last.text = `${last.text}${fragment.text}`;
      if (fragment.isFinal) last.closed = true;
    } else {
      if (last !== undefined) last.closed = true;
      // A close with no words of its own only ends the sentence it belongs to.
      if (fragment.text.trim() !== "") {
        this.#sentences.push({
          ordinal: this.#nextOrdinal,
          utteranceId: fragment.utteranceId,
          text: fragment.text.slice(0, MAX_SENTENCE_CHARS),
          closed: fragment.isFinal,
          heardMs: this.#nowMs(),
        });
        this.#nextOrdinal += 1;
        if (this.#sentences.length > MAX_SENTENCES) this.#sentences.shift();
        this.#expire();
      }
    }
    this.#settlePending();
  }

  /** The recognizer delivered a sentence: its live reading, now or when it arrives, is covered. */
  delivered(text: string): void {
    this.#expire();
    const said = words(text).map((word) => word.text);
    if (said.length < MIN_MATCH_WORDS) return;
    if (this.#align(said, Number.POSITIVE_INFINITY)) return;
    // Its live reading may be the sentence in progress, or the next one if the live session is that far behind.
    const now = this.#nowMs();
    this.#pending.push({ words: said, deliveredMs: now, deadlineMs: now + PENDING_MS, lastOrdinal: this.#nextOrdinal });
    if (this.#pending.length > MAX_PENDING) {
      this.#forget(this.#pending.splice(0, 1));
      this.#unclear = true;
    }
  }

  /** What the recognizer had not delivered, oldest first, and an empty shadow afterwards. */
  take(): string {
    this.#expire();
    const remainders: Array<{ ordinal: number; text: string }> = [];
    for (const sentence of this.#sentences) {
      if (sentence.ordinal < this.#cursor.ordinal) continue;
      const from = sentence.ordinal === this.#cursor.ordinal ? this.#cursor.offset : 0;
      const text = sentence.text.slice(from).trim();
      if (text === "") continue;
      // The live session is still reading a sentence the recognizer already delivered: what it has so far is the
      // beginning of that final.
      const heard = words(text).map((word) => word.text);
      if (this.#pending.some((pending) => coveredWords(heard, pending.words) > 0)) continue;
      remainders.push({ ordinal: sentence.ordinal, text });
    }
    const unclear = this.#unclear || this.#pending.length > 0;
    const answer = (unclear ? this.#uncoveredWhole() : remainders.map((remainder) => remainder.text)).join(" ");
    this.#sentences = [];
    this.#pending = [];
    this.#expired = [];
    this.#cursor = { ordinal: this.#nextOrdinal, offset: 0 };
    this.#unclear = false;
    return answer;
  }

  /**
   * Every live sentence after the last fully covered one, each from its start, when the cursor cannot be trusted.
   *
   * The live session may cut the sentence in progress into several utterances, so all of them are answered, in order,
   * not only the newest. The cursor may stand partway into the first of them on the strength of a match that belonged
   * to an earlier sentence, so that one is answered whole rather than its tail. A sentence the cursor stands at the end
   * of was delivered whole and is not answered again, and neither is one the live session is still reading for a final
   * already delivered, nor the late live reading of a final that expired waiting for it.
   */
  #uncoveredWhole(): string[] {
    const answered: string[] = [];
    const excused = new Set<Pending>();
    for (const sentence of this.#sentences) {
      if (sentence.ordinal < this.#cursor.ordinal) continue;
      if (sentence.ordinal === this.#cursor.ordinal && words(sentence.text, this.#cursor.offset).length === 0) continue;
      const text = sentence.text.trim();
      const heard = words(text).map((word) => word.text);
      if (heard.length === 0 || this.#pending.some((pending) => coveredWords(heard, pending.words) > 0)) continue;
      const late = this.#expired.find(
        (final) =>
          !excused.has(final) &&
          Math.abs(sentence.heardMs - final.deliveredMs) <= EXPIRED_MATCH_MS &&
          coveredWords(heard, final.words) > 0,
      );
      if (late !== undefined) {
        excused.add(late);
        continue;
      }
      answered.push(text);
    }
    return answered;
  }

  /** Move the cursor past the live reading of `said`, if one starts at or after it. */
  #align(said: readonly string[], lastOrdinal: number): boolean {
    let passedOver = false;
    for (const sentence of this.#sentences) {
      if (sentence.ordinal < this.#cursor.ordinal || sentence.ordinal > lastOrdinal) continue;
      const from = sentence.ordinal === this.#cursor.ordinal ? this.#cursor.offset : 0;
      const heard = words(sentence.text, from);
      const covered = coveredWords(said, heard.map((word) => word.text));
      if (covered === 0) {
        if (heard.length > 0) passedOver = true;
        continue;
      }
      this.#cursor = { ordinal: sentence.ordinal, offset: heard[covered - 1]!.end };
      // Passing over an unmatched live sentence means this final may be that sentence's, read too differently to
      // match, and the one it did match only looks like it: where the cursor now stands is not known for certain.
      this.#unclear = passedOver;
      return true;
    }
    return false;
  }

  /** Finals waiting for their live reading, matched in the order they were delivered. */
  #settlePending(): void {
    for (let index = 0; index < this.#pending.length; index += 1) {
      const pending = this.#pending[index]!;
      if (!this.#align(pending.words, pending.lastOrdinal)) continue;
      // Earlier finals were passed over: their live reading never matched.
      this.#forget(this.#pending.splice(0, index + 1).slice(0, -1));
      index = -1;
    }
  }

  /** Forget finals whose live reading can no longer arrive. */
  #expire(): void {
    const now = this.#nowMs();
    const newest = this.#nextOrdinal - 1;
    const kept = this.#pending.filter((pending) => pending.deadlineMs > now && newest <= pending.lastOrdinal);
    if (kept.length < this.#pending.length) this.#unclear = true;
    this.#forget(this.#pending.filter((pending) => !kept.includes(pending)));
    this.#pending = kept;
  }

  /** Remember finals that stopped waiting without their live reading, which may still arrive late. */
  #forget(finals: readonly Pending[]): void {
    this.#expired.push(...finals);
    if (this.#expired.length > MAX_EXPIRED) this.#expired.splice(0, this.#expired.length - MAX_EXPIRED);
  }
}

function words(text: string, from = 0): Word[] {
  const found: Word[] = [];
  for (const match of text.slice(from).matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    found.push({ text: match[0].toLowerCase(), end: from + match.index + match[0].length });
  }
  return found;
}

/**
 * How many of `heard`'s first words are a reading of `said`, or 0 when they are not.
 *
 * Compared as letters with the spaces taken out, so "use effect" and "useEffect" read the same, and only across whole
 * words of `heard`. A match needs `said` to be at least three words long and the two to differ by a few characters.
 */
function coveredWords(said: readonly string[], heard: readonly string[]): number {
  if (said.length < MIN_MATCH_WORDS || heard.length === 0) return 0;
  const target = said.join("").slice(0, MAX_COMPARE_CHARS);
  const allowed = Math.floor(target.length * EDITS_PER_CHAR);
  // Word ends inside the compared letters of `heard`.
  const ends: number[] = [];
  let letters = "";
  for (const word of heard) {
    if (letters.length + word.length > target.length + allowed) break;
    letters += word;
    ends.push(letters.length);
  }
  if (ends.length === 0) return 0;
  const distances = prefixDistances(target, letters);
  let best = 0;
  let bestDistance = allowed + 1;
  ends.forEach((end, index) => {
    const distance = distances[end]!;
    if (distance < bestDistance) {
      best = index + 1;
      bestDistance = distance;
    }
  });
  return bestDistance <= allowed ? best : 0;
}

/** Edit distance from `target` to every prefix of `text`: entry j is the distance to `text.slice(0, j)`. */
function prefixDistances(target: string, text: string): number[] {
  let previous = Array.from({ length: text.length + 1 }, (_, index) => index);
  for (let row = 1; row <= target.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= text.length; column += 1) {
      const substitution = previous[column - 1]! + (target[row - 1] === text[column - 1] ? 0 : 1);
      current.push(Math.min(substitution, previous[column]! + 1, current[column - 1]! + 1));
    }
    previous = current;
  }
  return previous;
}
