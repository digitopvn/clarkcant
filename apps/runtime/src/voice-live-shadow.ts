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
 *   alike whatever was said. It still accounts for one sentence under three words that the match of a final delivered
 *   after it passes over, so a short reply ("ừ") before a command is not answered again;
 * - two readings match only when they differ by a few characters, never by a whole word;
 * - a final whose live reading has not arrived waits only for the live sentence in progress and the next one, and only
 *   for a few seconds, so it cannot match an unrelated sentence later;
 * - when a final never found its live reading, or matched only after passing over a live sentence it did not match,
 *   the alignment is unclear: every live sentence after the last one a final fully covered is answered, whole and in
 *   order, since the live session may have cut the sentence the recognizer was in the middle of into several
 *   utterances;
 * - a final that expired without finding its live reading is still remembered for a while, because the live reading
 *   often arrives only after the recognizer finalized the next sentence. A final passed over by a later match is not
 *   remembered: its reading already went by.
 *
 * Which live sentence is withheld follows one count: each recognizer final accounts for at most one live sentence. A
 * live sentence is withheld only when one final accounts for it and for no other withheld sentence: the sentence it
 * matched, its late reading, or the first sentence in its turn that reads as nothing. A sentence no final accounts for
 * is answered, and when a match passed over such a sentence the matched one is answered too, since one of the two was
 * never delivered. Readings arrive in the order the finals were delivered, so a sentence that reads as a later final,
 * or that a later final matched, ends an earlier final's turn.
 *
 * Three losses are accepted, each of a sentence that says again the words of a final delivered within thirty seconds
 * of it, because the stream cannot tell it from that final's own reading:
 * - the final's live reading never arrived, and the sentence reads as the whole of it: it is taken for that late
 *   reading. Answering it would re-send every sentence of a lagging stretch;
 * - the final's live reading arrived misread, in its turn and in order, while an earlier final's never arrived: the
 *   misread reading is taken for the earlier final's, and the sentence for this final's late reading. The stream is the
 *   same as one where the earlier final's reading arrived misread and this final's arrived late;
 * - the live session was still reading the sentence when the recognizer failed, and the final's own live reading
 *   arrived misread or split: what it has so far is taken for that final's reading still arriving.
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
/**
 * Letter pairs compared while looking for the late readings of expired finals, so a backlog of long sentences cannot
 * stall the recognizer's failure: a few tens of milliseconds. Spoken sentences of a few dozen words stay far below it.
 */
const MAX_LATE_COMPARISONS = 4_000_000;

interface Sentence {
  ordinal: number;
  utteranceId: string;
  text: string;
  closed: boolean;
  /** When its first fragment was heard. */
  heardMs: number;
  /** A recognizer final moved the cursor into it, so it is not the late reading of an expired final. */
  aligned: boolean;
  /** When the latest final that moved the cursor into it was delivered. */
  alignedMs: number;
}

interface Pending {
  words: string[];
  /** Its place among every final delivered, short ones too. */
  sequence: number;
  deliveredMs: number;
  deadlineMs: number;
  /** The last live sentence this final may still be the reading of. */
  lastOrdinal: number;
}

/** A match that passed over live sentences it did not match: they may be its reading, and the matched one a repeat. */
interface Unsure {
  /** The live sentence the final matched. */
  matched: number;
  /** The live sentences it passed over on the way, which may be its misread reading. */
  passedOver: number[];
  /**
   * Finals that may each own one of the passed-over sentences: the waiting finals the match discarded, and the short
   * finals delivered before it, up to the number of short sentences it passed over.
   */
  explained: number;
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
  /** Matches that passed over more live sentences than the waiting finals they discarded, kept until `take()`. */
  #unsure: Unsure[] = [];
  /** Finals that left the waiting list without finding their live reading, oldest first. */
  #expired: Pending[] = [];
  /** Finals delivered so far, short ones too, so a match knows which finals came before it. */
  #deliveries = 0;
  /**
   * The places of short finals delivered since a match last passed them: too short to match, but each is still the
   * reading of one live sentence, which a later match may pass over.
   */
  #short: number[] = [];

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
          aligned: false,
          alignedMs: Number.NEGATIVE_INFINITY,
        });
        this.#nextOrdinal += 1;
        if (this.#sentences.length > MAX_SENTENCES) this.#evict(this.#sentences.shift()!.ordinal);
        this.#expire();
      }
    }
    this.#settlePending();
  }

  /** The recognizer delivered a sentence: its live reading, now or when it arrives, is covered. */
  delivered(text: string): void {
    this.#expire();
    const said = words(text).map((word) => word.text);
    if (said.length === 0) return;
    const sequence = this.#deliveries;
    this.#deliveries += 1;
    if (said.length < MIN_MATCH_WORDS) {
      // Too short to match, but it still accounts for one short live sentence a later match passes over.
      this.#short.push(sequence);
      if (this.#short.length > MAX_SENTENCES) this.#short.shift();
      return;
    }
    if (this.#align(said, Number.POSITIVE_INFINITY, this.#pending.length, this.#nowMs(), sequence)) {
      // Finals arrive in order: those still waiting were passed over, and their live reading is settled.
      this.#pending = [];
      return;
    }
    // Its live reading may be the sentence in progress, or the next one if the live session is that far behind.
    const now = this.#nowMs();
    this.#pending.push({ words: said, sequence, deliveredMs: now, deadlineMs: now + PENDING_MS, lastOrdinal: this.#nextOrdinal });
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
    // A later clean match clears the unclear mark, but not what an earlier unsure match left unaccounted for.
    const unclear = this.#unclear || this.#pending.length > 0 || this.#unsure.length > 0;
    const answer = (unclear ? this.#uncoveredWhole() : remainders.map((remainder) => remainder.text)).join(" ");
    this.#sentences = [];
    this.#pending = [];
    this.#expired = [];
    this.#cursor = { ordinal: this.#nextOrdinal, offset: 0 };
    this.#unclear = false;
    this.#unsure = [];
    this.#short = [];
    return answer;
  }

  /**
   * Every live sentence after the last fully covered one, each from its start, when the cursor cannot be trusted.
   *
   * The live session may cut the sentence in progress into several utterances, so all of them are answered, in order,
   * not only the newest. The cursor may stand partway into the first of them on the strength of a match that belonged
   * to an earlier sentence, so that one is answered whole rather than its tail. A sentence the cursor stands at the end
   * of was delivered whole and is not answered again; neither is one the live session is still reading for a final
   * already delivered, nor the late live reading of a final that expired waiting for it. Sentences a match owes, before
   * the cursor too, are answered whatever else holds.
   */
  #uncoveredWhole(): string[] {
    const { late, misread } = this.#lateReadings();
    const owed = this.#owed(late, misread);
    const answered: string[] = [];
    for (const sentence of this.#sentences) {
      const text = sentence.text.trim();
      if (owed.has(sentence.ordinal)) {
        if (words(text).length > 0) answered.push(text);
        continue;
      }
      if (sentence.ordinal < this.#cursor.ordinal) continue;
      const deliveredWhole =
        sentence.ordinal === this.#cursor.ordinal && words(sentence.text, this.#cursor.offset).length === 0;
      if (deliveredWhole) continue;
      const heard = words(text).map((word) => word.text);
      if (heard.length === 0 || this.#pending.some((pending) => coveredWords(heard, pending.words) > 0)) continue;
      if (late.has(sentence)) continue;
      answered.push(text);
    }
    return answered;
  }

  /**
   * The live sentences an unsure match owes: each final accounts for at most one live sentence, so when a match passed
   * over more sentences than other finals account for, one of those sentences or the one it matched was never
   * delivered. All of them are answered, which costs one duplicate and never loses the undelivered one. A passed-over
   * sentence is accounted for when a final moved the cursor into it, or an expired final took it as its late or misread
   * reading; each waiting final the match discarded accounts for one more.
   */
  #owed(late: ReadonlySet<Sentence>, misread: ReadonlySet<Sentence>): Set<number> {
    const accounted = new Set<number>();
    for (const sentence of this.#sentences) {
      if (sentence.aligned || late.has(sentence) || misread.has(sentence)) accounted.add(sentence.ordinal);
    }
    const owed = new Set<number>();
    for (const unsure of this.#unsure) {
      const unaccounted = unsure.passedOver.filter((ordinal) => !accounted.has(ordinal));
      if (unaccounted.length <= unsure.explained) continue;
      for (const ordinal of unaccounted) owed.add(ordinal);
      owed.add(unsure.matched);
    }
    return owed;
  }

  /**
   * The live sentences that are the late reading of a final which expired waiting for it, and those taken for its
   * misread reading.
   *
   * Live readings arrive in the order the finals were delivered, so the expired finals are matched in that order
   * against every live sentence kept, before the cursor too, so each one is used up by its own reading wherever that
   * lies. A live sentence a final moved the cursor into belongs to that final, and ends this final's turn when that
   * final was delivered after it. One that reads as an earlier expired final is left for it, and one that reads as a
   * later one ends this final's turn: its reading never arrived. The first
   * one that reads as none of them is taken to be this final's reading, misread: it uses the final up without being
   * excused, so the final cannot excuse a later sentence that only says the same words again, and it counts as
   * accounted for by that final. A sentence heard longer after the final than a late reading can take ends its turn.
   *
   * A sentence reads as a final when it reads as the whole of it, within the time a late reading can take. The newest
   * sentence, while the live session is still reading it, may read as its beginning. Anything less is answered, since a
   * new sentence often starts with the same few words as the one before.
   */
  #lateReadings(): { late: Set<Sentence>; misread: Set<Sentence> } {
    const newest = this.#sentences.at(-1);
    let budget = MAX_LATE_COMPARISONS;
    // Spends the comparison budget; past it, a pair counts as not reading alike, which leans towards answering.
    const affordable = (said: readonly string[], heard: readonly string[]): boolean => {
      const cost = comparisons(said, heard);
      if (cost > budget) return false;
      budget -= cost;
      return true;
    };
    const reads = this.#sentences.map((sentence) => {
      const heard = words(sentence.text).map((word) => word.text);
      const known: boolean[] = [];
      // Worked out only when asked, since the order of the finals settles most sentences after a few comparisons.
      return (final: number): boolean => {
        const expired = this.#expired[final]!;
        known[final] ??=
          Math.abs(sentence.heardMs - expired.deliveredMs) <= EXPIRED_MATCH_MS &&
          heard.length > 0 &&
          ((closeInLength(expired.words, heard) &&
            affordable(expired.words, heard) &&
            coveredWords(expired.words, heard) === heard.length) ||
            (sentence === newest &&
              !sentence.closed &&
              affordable(heard, expired.words) &&
              coveredWords(heard, expired.words) > 0));
        return known[final];
      };
    });
    const late = new Set<Sentence>();
    const misread = new Set<Sentence>();
    let from = 0;
    this.#expired.forEach((expired, final) => {
      for (let index = from; index < this.#sentences.length; index += 1) {
        const sentence = this.#sentences[index]!;
        if (sentence.aligned) {
          // A final delivered after this one matched it, so this final's reading, which came before, never arrived.
          if (sentence.alignedMs > expired.deliveredMs) return;
          continue;
        }
        // Too long after the final to be its reading, and so is every sentence after it.
        if (sentence.heardMs - expired.deliveredMs > EXPIRED_MATCH_MS) return;
        const readsAs = reads[index]!;
        if (readsAs(final)) {
          late.add(sentence);
          from = index + 1;
          return;
        }
        // Readings arrive in order: once a later final's reading came, this final's can no longer come.
        if (this.#expired.some((_, other) => other > final && readsAs(other))) return;
        if (!this.#expired.some((_, other) => other < final && readsAs(other))) {
          misread.add(sentence);
          from = index + 1;
          return;
        }
      }
    });
    return { late, misread };
  }

  /**
   * Move the cursor past the live reading of `said`, if one starts at or after it. `explained`: the waiting finals this
   * match discards, whose readings may be among the sentences it passes over. `deliveredMs`: when `said` was delivered,
   * and `sequence` its place among every final delivered.
   *
   * Short finals delivered before `said` are passed with it, since their readings came before its own. Each accounts
   * for one short sentence the match passed over, and for nothing longer: a short final is the reading of a short
   * sentence, never of a command read too differently to match.
   */
  #align(said: readonly string[], lastOrdinal: number, explained: number, deliveredMs: number, sequence: number): boolean {
    const passedOver: number[] = [];
    let shortPassedOver = 0;
    for (const sentence of this.#sentences) {
      if (sentence.ordinal < this.#cursor.ordinal || sentence.ordinal > lastOrdinal) continue;
      const from = sentence.ordinal === this.#cursor.ordinal ? this.#cursor.offset : 0;
      const heard = words(sentence.text, from);
      const covered = coveredWords(said, heard.map((word) => word.text));
      if (covered === 0) {
        if (heard.length > 0) passedOver.push(sentence.ordinal);
        if (heard.length > 0 && heard.length < MIN_MATCH_WORDS) shortPassedOver += 1;
        continue;
      }
      this.#cursor = { ordinal: sentence.ordinal, offset: heard[covered - 1]!.end };
      sentence.aligned = true;
      sentence.alignedMs = Math.max(sentence.alignedMs, deliveredMs);
      // Passing over an unmatched live sentence means this final may be that sentence's, read too differently to
      // match, and the one it did match only looks like it: where the cursor now stands is not known for certain.
      this.#unclear = passedOver.length > 0;
      const shortBefore = this.#short.filter((short) => short < sequence).length;
      this.#short = this.#short.filter((short) => short > sequence);
      const accounted = explained + Math.min(shortBefore, shortPassedOver);
      // A match that passes over no more sentences than the finals it discards can never owe one.
      if (passedOver.length > accounted) this.#unsure.push({ matched: sentence.ordinal, passedOver, explained: accounted });
      return true;
    }
    return false;
  }

  /** Finals waiting for their live reading, matched in the order they were delivered. */
  #settlePending(): void {
    for (let index = 0; index < this.#pending.length; index += 1) {
      const pending = this.#pending[index]!;
      if (!this.#align(pending.words, pending.lastOrdinal, index, pending.deliveredMs, pending.sequence)) continue;
      // Earlier finals were passed over: their live reading went by, too different to match, so it cannot arrive late.
      this.#pending.splice(0, index + 1);
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

  /** A live sentence no longer kept cannot be answered, nor counted against a match that passed over it. */
  #evict(ordinal: number): void {
    this.#unsure = this.#unsure.filter((unsure) => unsure.matched !== ordinal);
    for (const unsure of this.#unsure) unsure.passedOver = unsure.passedOver.filter((passed) => passed !== ordinal);
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

/** Whether `heard` is long enough, and short enough, to be a whole reading of `said`. */
function closeInLength(said: readonly string[], heard: readonly string[]): boolean {
  const target = Math.min(letterCount(said), MAX_COMPARE_CHARS);
  return Math.abs(letterCount(heard) - target) <= Math.floor(target * EDITS_PER_CHAR);
}

/** The most letter pairs `coveredWords(said, heard)` compares. */
function comparisons(said: readonly string[], heard: readonly string[]): number {
  const target = Math.min(letterCount(said), MAX_COMPARE_CHARS);
  return target * Math.min(letterCount(heard), target + Math.floor(target * EDITS_PER_CHAR));
}

function letterCount(text: readonly string[]): number {
  return text.reduce((count, word) => count + word.length, 0);
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
