import { MEMORY_BRIEF_MAX_CHARS, MEMORY_BRIEF_MAX_ROWS } from "@clarkcant/contracts";
import {
  countMemoryRecordsForBrief,
  historyEntry,
  memoryRecordsForBrief,
  searchHistory,
  type Database,
  type MemoryRecordInput,
} from "@clarkcant/storage";

import { type DecideDeps, decideContextFocus, rankGapIsClear } from "./jev-decider.ts";
import { briefFromRows } from "./memory.ts";

/**
 * The context planner: which of the things a turn could be told it is actually told, and how much of each.
 *
 * A projection over state the node already keeps — memory rows, the history index and the transcript — and never a
 * store of its own. Every read is scoped in SQL to the principal (and, for memory, to node scope or this conversation)
 * before anything is ranked, so a record the turn may not see is never a candidate in the first place.
 *
 * The ranking is deterministic and cheap: term overlap for memory, BM25 for earlier messages. Jev may reorder a
 * bounded top-K when the ranking is too close to call, and that is all it may do: it never adds a candidate, never
 * removes one and never decides what the turn is allowed to do.
 *
 * When nothing matches what was asked, the planner says exactly what the node said before it existed. Relevance is
 * only claimed when there is evidence of it.
 */

/** How much of one block a turn sees. */
export type ContextVisibility = "hide" | "short" | "full";

/** One candidate the planner considered. */
export interface ContextBlock {
  /** `memory:<id>`, `message:<id>` or `recent:<position>`. */
  id: string;
  kind: "memory" | "recent-message" | "earlier-message";
  text: string;
  /** Higher is more relevant to this turn's text; 0 means no evidence of relevance. */
  score: number;
  /** A pinned block is shown in full whatever the budget, because it is where the conversation is. */
  pinned: boolean;
}

/** What the planner decided for one turn, kept for telemetry and tests. */
export interface ContextPlan {
  entries: readonly { block: ContextBlock; visibility: ContextVisibility }[];
  /** Candidates that matched but were left out for the budget, stated in the brief rather than swallowed. */
  omitted: number;
  /** False when nothing matched and the previous behaviour was used unchanged. */
  focused: boolean;
  /** True when Jev moved a candidate to the front. */
  reranked: boolean;
}

export const CONTEXT_LIMITS = {
  /** The recap's window of newest messages, as before. */
  recapRecent: 12,
  /** The newest messages always shown in full. */
  recapPinned: 2,
  recapLineFull: 400,
  recapLineShort: 160,
  /** Earlier messages of this conversation, outside the window, that match the turn. */
  earlierShown: 4,
  earlierCandidates: 12,
  /** Memory rows considered for one turn; the brief itself keeps its own row and character caps. */
  memoryCandidates: 200,
  memoryLineShort: 240,
  /** The most Jev is ever shown. */
  rerankTopK: 8,
  /** Terms read from the turn's text. */
  queryTerms: 24,
} as const;

/** `off` restores the previous brief and recap exactly; anything else, including unset, is `on`. */
export function contextPlannerFromEnv(env: NodeJS.ProcessEnv = process.env): "on" | "off" {
  return env.CLARKCANT_CONTEXT_PLANNER?.trim().toLowerCase() === "off" ? "off" : "on";
}

/** `jev` lets the selector reorder a close top-K; anything else keeps the deterministic order. */
export function contextDeciderFromEnv(env: NodeJS.ProcessEnv = process.env): "rank" | "jev" {
  return env.CLARKCANT_CONTEXT_DECIDER?.trim().toLowerCase() === "jev" ? "jev" : "rank";
}

/*
 * Words that carry no subject, in both languages the product speaks. Compared after diacritics are folded, so the
 * Vietnamese entries are written without them.
 */
const STOPWORDS = new Set([
  "the", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "be", "it", "this", "that", "with", "what",
  "how", "do", "does", "can", "you", "me", "my", "we", "our", "please", "at", "as", "by", "from", "about", "so",
  "la", "va", "cua", "cho", "voi", "nay", "co", "khong", "mot", "nhung", "cac", "thi", "ma", "de", "duoc", "toi",
  "ban", "minh", "gi", "nao", "sao", "nhe", "oi", "roi", "da", "dang", "se", "lai", "nua", "di", "ra", "vao",
  "len", "xuong", "hay", "giup", "trong", "ve", "khi", "neu", "vay", "ah", "ok",
]);

/** Lower-case, diacritics folded, so "dự án" and "du an" are the same words. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
}

/** The subject-bearing terms of a text, at most `cap` of them. */
export function contextTerms(text: string, cap: number = CONTEXT_LIMITS.queryTerms): Set<string> {
  const terms = new Set<string>();
  for (const term of fold(text).split(/[^\p{L}\p{N}]+/u)) {
    if (term.length < 2 || STOPWORDS.has(term)) continue;
    terms.add(term);
    if (terms.size >= cap) break;
  }
  return terms;
}

/**
 * How much of the query a text covers, and whether that is evidence of relevance.
 *
 * One shared word between a long question and a memory is noise in a language of short syllables, so a match needs
 * two terms — or the only term, when the question has one.
 */
export function relevance(query: ReadonlySet<string>, text: string): { score: number; relevant: boolean } {
  if (query.size === 0) return { score: 0, relevant: false };
  const doc = contextTerms(text, Number.MAX_SAFE_INTEGER);
  let hits = 0;
  for (const term of query) if (doc.has(term)) hits += 1;
  return { score: hits / query.size, relevant: hits >= Math.min(2, query.size) };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Move the candidate Jev chose to the front, or leave the order alone.
 *
 * Only asked when the deterministic order is too close to call: a clear winner needs no second opinion, and a call
 * that changes nothing is latency for nothing. Whatever Jev answers, the set is the same set.
 */
export async function rerankTop<T extends { id: string; text: string; score: number }>(
  candidates: readonly T[],
  query: string,
  decider: DecideDeps | undefined,
): Promise<{ ordered: T[]; reranked: boolean }> {
  const ordered = [...candidates];
  if (decider === undefined || ordered.length < 2) return { ordered, reranked: false };
  const [first, second] = ordered;
  if (first === undefined || second === undefined || rankGapIsClear(first.score, second.score)) {
    return { ordered, reranked: false };
  }
  const top = ordered.slice(0, CONTEXT_LIMITS.rerankTopK);
  const decision = await decideContextFocus(decider, { query, candidates: top }).catch(() => undefined);
  if (decision?.status !== "chosen") return { ordered, reranked: false };
  const index = ordered.findIndex((candidate) => candidate.id === decision.id);
  if (index <= 0) return { ordered, reranked: false };
  const [chosen] = ordered.splice(index, 1);
  if (chosen === undefined) return { ordered, reranked: false };
  return { ordered: [chosen, ...ordered], reranked: true };
}

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

/**
 * The memory brief for one turn, with what this turn is about first.
 *
 * `records` are the eligible rows newest first, already scoped by principal and conversation. Without a match the
 * result is the previous brief byte for byte, because the previous brief is newest-first and nothing here has better
 * evidence than that.
 */
export async function planMemoryBrief(input: {
  records: readonly MemoryRecordInput[];
  total: () => number;
  query: string;
  decider?: DecideDeps;
}): Promise<{ text: string; plan: ContextPlan }> {
  const terms = contextTerms(input.query);
  const blocks = input.records.map((record) => {
    const { score, relevant } = relevance(terms, record.text);
    return { record, relevant, id: `memory:${record.memoryId}`, text: record.text, score };
  });
  const matched = blocks.filter((block) => block.relevant).sort((left, right) => right.score - left.score);
  if (matched.length === 0) {
    const text = briefFromRows(input.records.slice(0, MEMORY_BRIEF_MAX_ROWS), input.total);
    return { text, plan: { entries: [], omitted: 0, focused: false, reranked: false } };
  }

  const { ordered: first, reranked } = await rerankTop(matched, input.query, input.decider);
  const rest = blocks.filter((block) => !block.relevant);
  const lines: string[] = [];
  const entries: { block: ContextBlock; visibility: ContextVisibility }[] = [];
  let used = 0;
  let omitted = 0;
  for (const block of [...first, ...rest]) {
    const full = `- (${block.record.kind}) ${block.record.text}`;
    const short = `- (${block.record.kind}) ${clip(block.record.text, CONTEXT_LIMITS.memoryLineShort)}`;
    const fits = (line: string): boolean => lines.length < MEMORY_BRIEF_MAX_ROWS && used + line.length <= MEMORY_BRIEF_MAX_CHARS;
    let visibility: ContextVisibility = "hide";
    if (fits(full)) visibility = "full";
    else if (block.relevant && fits(short)) visibility = "short";
    const contextBlock: ContextBlock = { id: block.id, kind: "memory", text: block.text, score: block.score, pinned: false };
    entries.push({ block: contextBlock, visibility });
    if (visibility === "hide") {
      if (block.relevant) omitted += 1;
      continue;
    }
    const line = visibility === "full" ? full : short;
    lines.push(line);
    used += line.length + 1;
  }
  const remaining = input.total() - lines.length;
  const text = [
    "[Điều đã ghi nhớ cho người dùng này]",
    ...lines,
    ...(remaining > 0 ? [`[còn ${remaining} điều đã ghi nhớ khác]`] : []),
  ].join("\n");
  return { text, plan: { entries, omitted, focused: true, reranked } };
}

/** The node's memory brief, read fresh for this turn and focused on its text. */
export async function focusedMemoryBrief(
  deps: { db: Database; decider?: DecideDeps },
  input: { principalId: string; conversationId: string; query: string },
): Promise<{ text: string; plan: ContextPlan }> {
  const records = memoryRecordsForBrief(deps.db, input.principalId, input.conversationId, CONTEXT_LIMITS.memoryCandidates);
  if (records.length === 0) return { text: "", plan: { entries: [], omitted: 0, focused: false, reranked: false } };
  return await planMemoryBrief({
    records,
    total: () => countMemoryRecordsForBrief(deps.db, input.principalId, input.conversationId),
    query: input.query,
    ...(deps.decider === undefined ? {} : { decider: deps.decider }),
  });
}

/* ------------------------------------------------------------------ *
 * Recap
 * ------------------------------------------------------------------ */

export interface RecapMessage {
  role: "user" | "assistant";
  text: string;
  messageId?: string;
}

export interface EarlierMessage {
  id: string;
  text: string;
  /** Higher is better. */
  score: number;
}

const RECAP_HEADER = "Mạch hội thoại trước đó, để bạn tiếp tục đúng việc đang làm:";

function recapLine(message: RecapMessage, max: number): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  const shown = max === CONTEXT_LIMITS.recapLineFull ? text.slice(0, max) : clip(text, max);
  return `${message.role === "user" ? "Người dùng" : "Trợ lý"}: ${shown}`;
}

/** The recap the node sent before the planner existed: the newest twelve messages, each clipped to 400 characters. */
/**
 * The messages a recap repeats: the newest twelve of those read.
 *
 * Only these are excluded from the search for earlier messages. A message that was read but falls outside this window
 * is not in the recap, so it must stay findable — excluding everything read hid a decision made 13 to 40 messages ago.
 */
export function recapWindow<T>(messages: readonly T[]): readonly T[] {
  return messages.slice(-CONTEXT_LIMITS.recapRecent);
}

export function legacyRecap(messages: readonly RecapMessage[]): string {
  const recent = recapWindow(messages);
  if (recent.length === 0) return "";
  return `${RECAP_HEADER}\n${recent.map((message) => recapLine(message, CONTEXT_LIMITS.recapLineFull)).join("\n")}`;
}

/**
 * The recap for a session that has just been created, focused on the message it is about to answer.
 *
 * The newest messages stay, because they are where the conversation is; the last two are always whole. When the new
 * message matches something, older lines in the window that do not match are shortened, and earlier messages of this
 * conversation that do match are added under their own heading. When nothing matches, this is `legacyRecap`.
 */
export function planRecap(input: {
  messages: readonly RecapMessage[];
  query: string;
  earlier: readonly EarlierMessage[];
  /** Messages the conversation holds in all, so the recap can say how many it did not repeat. */
  total?: number;
}): { text: string; plan: ContextPlan } {
  const recent = recapWindow(input.messages);
  const terms = contextTerms(input.query);
  const pinnedFrom = recent.length - CONTEXT_LIMITS.recapPinned;
  const scored = recent.map((message, index) => ({
    message,
    pinned: index >= pinnedFrom,
    ...relevance(terms, message.text),
  }));
  const earlier = input.earlier.slice(0, CONTEXT_LIMITS.earlierShown);
  const anyRecentMatch = scored.some((entry) => !entry.pinned && entry.relevant);
  if (earlier.length === 0 && !anyRecentMatch) {
    return { text: legacyRecap(input.messages), plan: { entries: [], omitted: 0, focused: false, reranked: false } };
  }

  const entries: { block: ContextBlock; visibility: ContextVisibility }[] = [];
  const earlierLines = earlier.map((message) => {
    entries.push({
      block: { id: message.id, kind: "earlier-message", text: message.text, score: message.score, pinned: false },
      visibility: "full",
    });
    return `- ${clip(message.text, CONTEXT_LIMITS.recapLineFull)}`;
  });
  const recentLines = scored.map((entry, index) => {
    const visibility: ContextVisibility = entry.pinned || entry.relevant ? "full" : "short";
    entries.push({
      block: {
        id: entry.message.messageId === undefined ? `recent:${index}` : `message:${entry.message.messageId}`,
        kind: "recent-message",
        text: entry.message.text,
        score: entry.score,
        pinned: entry.pinned,
      },
      visibility,
    });
    return recapLine(entry.message, visibility === "full" ? CONTEXT_LIMITS.recapLineFull : CONTEXT_LIMITS.recapLineShort);
  });
  const notRepeated = Math.max(0, (input.total ?? input.messages.length) - recent.length - earlier.length);
  const omittedMatches = Math.max(0, input.earlier.length - earlier.length);
  const parts = [
    RECAP_HEADER,
    ...(earlierLines.length === 0 ? [] : ["[Đoạn cũ hơn trong hội thoại này, liên quan tới tin mới:]", ...earlierLines]),
    ...(earlierLines.length === 0 ? [] : ["[Gần nhất:]"]),
    ...recentLines,
    ...(notRepeated > 0
      ? [`[Còn ${notRepeated} tin cũ hơn không nhắc lại ở đây; dùng search_history nếu cần đọc lại.]`]
      : []),
  ];
  return { text: parts.join("\n"), plan: { entries, omitted: omittedMatches, focused: true, reranked: false } };
}

/**
 * Earlier messages of this conversation that match the turn, outside the recap's window.
 *
 * Principal, conversation and source are part of the SQL, so another conversation's or another person's history is
 * never read. Each hit is read back whole through the same principal-scoped reader, and kept only when its own words
 * cover the question — BM25 over OR-ed terms finds something for almost any text.
 */
export async function earlierMessagesFor(
  deps: { db: Database; decider?: DecideDeps },
  input: { principalId: string; conversationId: string; query: string; exclude: ReadonlySet<string> },
): Promise<{ earlier: EarlierMessage[]; reranked: boolean }> {
  const terms = contextTerms(input.query);
  if (terms.size === 0) return { earlier: [], reranked: false };
  const hits = searchHistory(deps.db, {
    principalId: input.principalId,
    conversationId: input.conversationId,
    source: "message",
    text: [...terms].join(" "),
    limit: CONTEXT_LIMITS.earlierCandidates + input.exclude.size,
  });
  const earlier: EarlierMessage[] = [];
  for (const hit of hits) {
    if (input.exclude.has(hit.ref)) continue;
    const entry = historyEntry(deps.db, { principalId: input.principalId, source: "message", ref: hit.ref });
    if (entry === undefined || entry.conversationId !== input.conversationId) continue;
    if (!relevance(terms, entry.text).relevant) continue;
    // BM25 is lower-is-better and negative; flipped so every score in the planner reads the same way.
    earlier.push({ id: `message:${hit.ref}`, text: entry.text, score: -hit.score });
    if (earlier.length >= CONTEXT_LIMITS.earlierCandidates) break;
  }
  const { ordered, reranked } = await rerankTop(earlier, input.query, deps.decider);
  return { earlier: ordered, reranked };
}
