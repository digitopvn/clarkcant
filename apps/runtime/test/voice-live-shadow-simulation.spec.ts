import { describe, expect, it } from "vitest";

import { LiveShadow } from "../src/voice-live-shadow.ts";

// A seeded simulation of the recognizer failing mid-session, judged without reference to any implementation: what the
// person said and the recognizer had not delivered must come back, in order, apart from the one accepted loss, and the
// duplicates stay bounded by how ambiguous the readings were.
const COMMANDS = [
  "chạy lại test đi nha",
  "mở file voice session giúp tui",
  "xem log lỗi hôm qua đi",
  "sửa cái hàm đọc cấu hình",
  "thêm một test cho trường hợp này",
  "đẩy nhánh này lên github nhé",
];
const REPLIES = ["ừ", "được", "đúng rồi"];
const GARBLE = ["tét", "mà", "xử", "cài", "ham", "độc", "câu", "hinh", "lóc", "nhờ", "bé", "vồi", "kho", "lun"];
/** How far apart a final and a live sentence taken for its late reading may be. */
const LATE_MS = 30_000;

interface Fragment {
  utteranceId: string;
  text: string;
  isFinal: boolean;
}

interface Spoken {
  /** The command said, or undefined for a short reply. */
  command: string | undefined;
  finalText: string;
  finalAt: number;
  reading: "clean" | "near" | "misread" | "dropped";
  split: boolean;
  /** The live utterances it was heard as, each in timed fragments. */
  utterances: Array<Array<{ at: number; fragment: Fragment }>>;
}

interface Session {
  spoken: Spoken[];
  failAt: number;
  /** The longest gap between a final and the first fragment of its live reading. */
  maxLagMs: number;
}

/** Mulberry32: a small seeded generator, so every seed replays the same session. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A person speaking 2 to 8 sentences, often saying a command again, while the recognizer delivers each a little after
 * it was said and the live session reads it late, a few letters off, misread, split in two, streamed in pieces, left
 * open, or not at all. The recognizer fails at a random moment.
 */
function session(seed: number, heavyLag = false): Session {
  const random = seeded(seed);
  const between = (low: number, high: number): number => low + random() * (high - low);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const [lagLow, lagHigh] = heavyLag ? [10_000, 40_000] : pick([[200, 2000], [2000, 10_000], [10_000, 40_000]]);
  const dropRate = pick([0, 0.1, 0.25]);
  const misreadRate = pick([0, 0.2, 0.35]);
  const nearly = (text: string): string => {
    const words = text.split(" ");
    const index = words.findIndex((word) => word.length >= 4);
    if (index < 0) return text;
    const word = words[index]!;
    const at = 1 + Math.floor(random() * (word.length - 1));
    words[index] = `${word.slice(0, at)}${pick(["a", "e", "o", "i"])}${word.slice(at + 1)}`;
    return words.join(" ");
  };
  const cut = (words: readonly string[]): [string, string] => {
    const at = 1 + Math.floor(random() * (words.length - 1));
    return [words.slice(0, at).join(" "), words.slice(at).join(" ")];
  };
  const spoken: Spoken[] = [];
  let speechEnd = 0;
  let finalAt = 0;
  let liveAt = 0;
  let utterance = 0;
  const count = 2 + Math.floor(random() * 7);
  for (let index = 0; index < count; index += 1) {
    const previous = spoken.at(-1)?.command;
    const again = previous !== undefined && random() < 0.35;
    const command = again ? previous : random() < 0.25 ? undefined : pick(COMMANDS);
    const said = command ?? pick(REPLIES);
    const start = index === 0 ? between(0, 1000) : speechEnd + (again ? between(300, 14_000) : between(500, 6000));
    speechEnd = start + 600 + said.split(" ").length * 250;
    finalAt = Math.max(finalAt + 1, speechEnd + between(300, 2000));
    const roll = random();
    const reading: Spoken["reading"] =
      roll < dropRate ? "dropped" : roll < dropRate + misreadRate ? "misread" : random() < 0.2 ? "near" : "clean";
    // Only one of the two streams reads it a few letters off.
    const finalText = command !== undefined && reading !== "near" && random() < 0.3 ? nearly(said) : said;
    const heard =
      reading === "misread"
        ? said
            .split(" ")
            .map((word, at) => (at % 2 === 0 || random() < 0.6 ? pick(GARBLE) : word))
            .join(" ")
        : reading === "near"
          ? nearly(said)
          : said;
    const split = reading !== "dropped" && heard.split(" ").length >= 4 && random() < 0.15;
    const texts = split ? cut(heard.split(" ")) : [heard];
    const utterances: Spoken["utterances"] = [];
    let at = Math.max(liveAt + 1, speechEnd + between(lagLow, lagHigh)) - 400 * texts.length;
    for (const text of texts) {
      const id = `s:u${utterance}`;
      utterance += 1;
      const words = text.split(" ");
      const pieces = words.length >= 2 && random() < 0.5 ? cut(words) : [text];
      // An open utterance never gets its final fragment: the next utterance closes it.
      const open = random() < 0.2;
      utterances.push(
        pieces.map((piece, number) => {
          at = Math.max(at + 1, liveAt + 1);
          liveAt = at;
          at += 200;
          const isFinal = !open && number === pieces.length - 1;
          return { at: liveAt, fragment: { utteranceId: id, text: number === 0 ? piece : ` ${piece}`, isFinal } };
        }),
      );
    }
    spoken.push({ command, finalText, finalAt, reading, split, utterances: reading === "dropped" ? [] : utterances });
  }
  const last = Math.max(...spoken.flatMap((sentence) => [sentence.finalAt, ...sentence.utterances.flat().map((f) => f.at)]));
  const lags = spoken
    .filter((sentence) => sentence.utterances.length > 0)
    .map((sentence) => Math.abs(sentence.utterances[0]![0]!.at - sentence.finalAt));
  return { spoken, failAt: random() * (last + 2000), maxLagMs: Math.max(0, ...lags) };
}

/** Plays the session into a shadow until the recognizer fails, and takes what it had not delivered. */
function replay(session: Session): string {
  type Step = { at: number; deliver?: string; hear?: Fragment };
  const steps: Step[] = session.spoken.flatMap((sentence) => [
    { at: sentence.finalAt, deliver: sentence.finalText },
    ...sentence.utterances.flat().map(({ at, fragment }) => ({ at, hear: fragment })),
  ]);
  steps.sort((a, b) => a.at - b.at);
  let now = 0;
  const shadow = new LiveShadow({ nowMs: () => now });
  for (const step of steps) {
    if (step.at > session.failAt) break;
    now = step.at;
    if (step.hear !== undefined) shadow.hear(step.hear);
    else shadow.delivered(step.deliver!);
  }
  now = session.failAt;
  return shadow.take();
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

interface Judged {
  /** The answer is the live sentences, or their tails, in the order they were heard. */
  inOrder: boolean;
  /** Sentences the recognizer never delivered whose live reading arrived, and that the answer lacks. */
  lost: number[];
  /** Sentences answered beyond those, counted per command. */
  extras: number;
}

/**
 * Reads the answer as an in-order selection of live utterances, whole or a tail, that covers the most undelivered
 * words. A command is lost only when it was answered fewer times than it was said and not delivered: which of two
 * readings of the same command is answered does not matter. A misread reading is its own sentence.
 */
function judge(session: Session, answer: string): Judged {
  const utterances: Array<{ sentence: number; words: string[] }> = [];
  session.spoken.forEach((sentence, index) => {
    for (const fragments of sentence.utterances) {
      const words = wordsOf(fragments.filter(({ at }) => at <= session.failAt).map(({ fragment }) => fragment.text).join(""));
      if (words.length > 0) utterances.push({ sentence: index, words });
    }
  });
  const heard = (index: number): number =>
    utterances.filter((u) => u.sentence === index).reduce((sum, u) => sum + u.words.length, 0);
  const undelivered = new Set(
    session.spoken.flatMap((sentence, index) => (sentence.finalAt > session.failAt && heard(index) > 0 ? [index] : [])),
  );
  const said = wordsOf(answer);
  const tails = (at: number, from: number): number[] => {
    const { words } = utterances[at]!;
    const lengths: number[] = [];
    for (let start = 0; start < words.length; start += 1) {
      const length = words.length - start;
      if (from + length > said.length) continue;
      if (words.slice(start).every((word, k) => said[from + k] === word)) lengths.push(length);
    }
    return lengths;
  };
  const gain = (at: number, length: number): number => (undelivered.has(utterances[at]!.sentence) ? 2 * length : 1);
  const memo = new Map<string, number>();
  const best = (at: number, from: number): number => {
    if (at === utterances.length) return from === said.length ? 0 : Number.NEGATIVE_INFINITY;
    const key = `${at}:${from}`;
    let value = memo.get(key);
    if (value === undefined) {
      value = best(at + 1, from);
      for (const length of tails(at, from)) value = Math.max(value, best(at + 1, from + length) + gain(at, length));
      memo.set(key, value);
    }
    return value;
  };
  if (best(0, 0) === Number.NEGATIVE_INFINITY) return { inOrder: false, lost: [...undelivered], extras: 0 };
  const answered = new Map<number, number>();
  let from = 0;
  for (let at = 0; at < utterances.length; at += 1) {
    const target = best(at, from);
    if (best(at + 1, from) === target) continue;
    const length = tails(at, from).find((length) => best(at + 1, from + length) + gain(at, length) === target)!;
    const sentence = utterances[at]!.sentence;
    answered.set(sentence, (answered.get(sentence) ?? 0) + length);
    from += length;
  }
  const byMeaning = new Map<string, { missing: number[]; spare: number }>();
  session.spoken.forEach((sentence, index) => {
    if (heard(index) === 0) return;
    const meaning = sentence.reading === "misread" || sentence.command === undefined ? `#${index}` : sentence.command;
    const entry = byMeaning.get(meaning) ?? { missing: [], spare: 0 };
    const whole = (answered.get(index) ?? 0) >= heard(index);
    if (undelivered.has(index) && !whole) entry.missing.push(index);
    if (!undelivered.has(index) && whole) entry.spare += 1;
    byMeaning.set(meaning, entry);
  });
  const lost: number[] = [];
  let extras = 0;
  for (const { missing, spare } of byMeaning.values()) {
    const stoodIn = Math.min(spare, missing.length);
    extras += spare - stoodIn;
    lost.push(...missing.slice(stoodIn));
  }
  return { inOrder: true, lost, extras };
}

/**
 * The accepted loss: the lost sentence reads as a delivered final of the same command, heard within 30 s of it, while
 * the live reading of that final, or of one delivered before it, never arrived. The session is then also one where the
 * lost sentence is that final's late reading. The same holds for the sentence the live session was still reading when
 * the recognizer failed, when the final's own reading was misread or split: it is then also that final's reading in
 * progress.
 */
function acceptedLoss(session: Session, index: number): boolean {
  const lost = session.spoken[index]!;
  if (lost.command === undefined || lost.reading === "misread") return false;
  const heardAt = lost.utterances[0]![0]!.at;
  const neverArrived = (sentence: Spoken): boolean =>
    sentence.command !== undefined &&
    sentence.finalAt <= session.failAt &&
    sentence.utterances.every((fragments) => fragments[0]!.at > session.failAt);
  const fragments = lost.utterances.flat();
  const stillReading = fragments.some(({ at }) => at > session.failAt) || !fragments.at(-1)!.fragment.isFinal;
  return session.spoken.some(
    (final, at) =>
      at !== index &&
      final.command === lost.command &&
      final.finalAt <= session.failAt &&
      Math.abs(heardAt - final.finalAt) <= LATE_MS &&
      (session.spoken.some((earlier) => earlier.finalAt <= final.finalAt && neverArrived(earlier)) ||
        (stillReading && (final.reading === "misread" || final.split))),
  );
}

/** Readings that cannot be told apart from another: misread, dropped, split, a reply too short to match, a repeat. */
function ambiguous(session: Session): number {
  const repeats = session.spoken.filter(
    (sentence, index) =>
      sentence.command !== undefined && session.spoken.slice(0, index).some((earlier) => earlier.command === sentence.command),
  ).length;
  const replies = session.spoken.filter((s) => s.command === undefined && s.finalAt <= session.failAt).length;
  const readings = session.spoken.filter((s) => s.reading === "misread" || s.reading === "dropped" || s.split).length;
  return repeats + replies + readings;
}

describe("the live reading kept while a recognizer is the source, over simulated sessions", () => {
  const SEEDS = 2000;

  it("answers every undelivered sentence, in order, but for the accepted loss, and bounds the duplicates", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const simulated = session(seed, seed % 4 === 0);
      const { inOrder, lost, extras } = judge(simulated, replay(simulated));
      if (!inOrder) failures.push(`seed ${seed}: answer out of order`);
      for (const index of lost.filter((index) => !acceptedLoss(simulated, index))) {
        failures.push(`seed ${seed}: sentence ${index} lost`);
      }
      // Past 30 s a lagging reading is no longer matched, and is answered again by design.
      if (simulated.maxLagMs > LATE_MS) continue;
      // Each ambiguous reading costs at most the sentence it passed over and the one matched; the sentence the live
      // session is still reading may cost one more.
      const allowed = 2 * ambiguous(simulated) + 1;
      if (extras > allowed) failures.push(`seed ${seed}: ${extras} duplicates, at most ${allowed} expected`);
    }
    expect(failures).toEqual([]);
  });
});