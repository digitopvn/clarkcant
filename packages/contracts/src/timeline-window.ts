import { z } from "zod";

/**
 * Which messages of a conversation a timeline read returns, and which part of the conversation that page stands for.
 *
 * A conversation is one ever-growing record, so a reader holds a window of it rather than all of it. Pages are chosen
 * by message sequence - the per-conversation order the node stores messages in - never by array index, and never by
 * the event `cursor` a timeline also carries: that one says which events a client has seen, which is a different
 * question from which messages it holds.
 *
 * Every page states the closed range of sequences it is the whole truth about (`fromSequence..toSequence`). Two pages
 * whose ranges meet or overlap merge into one range with no gap and no duplicate; a page whose range does not meet the
 * window a client holds cannot be stitched to it, and the client knows that from the numbers alone.
 */
export const TIMELINE_WINDOW_VERSION = 1;

/** Messages per page when the reader does not say. The size the timeline has always answered with. */
export const TIMELINE_PAGE_DEFAULT_LIMIT = 200;
/** The most messages one page may carry, so one read stays bounded however long the conversation is. */
export const TIMELINE_PAGE_MAX_LIMIT = 500;

/**
 * The page a reader asks for.
 *
 * - `latest`: the newest `limit` messages, which is what reopening a conversation shows.
 * - `before`: the `limit` messages just older than `beforeSequence`, for scrolling back.
 * - `after`: the `limit` messages just newer than `afterSequence`, oldest first. `afterSequence: 0` is the read every
 *   timeline route answered before windows existed, and is still what a bare read gets.
 */
export type TimelinePageQuery =
  | { kind: "latest" }
  | { kind: "before"; beforeSequence: number }
  | { kind: "after"; afterSequence: number };

export const timelineWindowSchema = z.strictObject({
  version: z.literal(TIMELINE_WINDOW_VERSION),
  /**
   * The page holds every stored message of the conversation with `fromSequence <= sequence <= toSequence`, and no
   * other. `fromSequence` is 0 when the page reaches the conversation's first message.
   */
  fromSequence: z.number().int().min(0),
  /** For a page that reaches the newest message, the newest sequence the node held when it read the page. */
  toSequence: z.number().int().min(0),
  /** Older messages exist: ask with `before = fromSequence` (or the first entry of `sequences`). */
  hasOlder: z.boolean(),
  /** Newer messages existed when the page was read: ask with `after = toSequence`. */
  hasNewer: z.boolean(),
  /** Each message's sequence, in the same order as the page's `messages`. */
  sequences: z.array(z.number().int().min(1)),
});

export type TimelineWindow = z.infer<typeof timelineWindowSchema>;

/**
 * Read the query string of a timeline read into a page and a size, or say what is wrong with it.
 *
 * - no parameter: `after=0`, the shape existing readers already send;
 * - `after=N`, `before=N` and `window=latest` each pick one page, and at most one of them may be given;
 * - `limit=N` sizes it, between 1 and `TIMELINE_PAGE_MAX_LIMIT`.
 */
export function parseTimelinePageQuery(
  query: Readonly<Record<string, string | undefined>>,
): { ok: true; page: TimelinePageQuery; limit: number } | { ok: false; message: string } {
  const after = query.after;
  const before = query.before;
  const windowName = query.window;
  const chosen = [after, before, windowName].filter((value) => value !== undefined).length;
  if (chosen > 1) return { ok: false, message: "ask for one page: `after`, `before` or `window=latest`, not several" };

  let limit = TIMELINE_PAGE_DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = wholeNumber(query.limit);
    if (parsed === undefined || parsed < 1 || parsed > TIMELINE_PAGE_MAX_LIMIT) {
      return { ok: false, message: `the \`limit\` must be a whole number from 1 to ${String(TIMELINE_PAGE_MAX_LIMIT)}` };
    }
    limit = parsed;
  }

  if (windowName !== undefined) {
    if (windowName !== "latest") return { ok: false, message: "the only named window is `latest`" };
    return { ok: true, page: { kind: "latest" }, limit };
  }
  if (before !== undefined) {
    const parsed = wholeNumber(before);
    if (parsed === undefined || parsed < 1) return { ok: false, message: "the `before` cursor must be a positive integer" };
    return { ok: true, page: { kind: "before", beforeSequence: parsed }, limit };
  }
  const parsed = wholeNumber(after ?? "0");
  if (parsed === undefined) return { ok: false, message: "the `after` cursor must be a non-negative integer" };
  return { ok: true, page: { kind: "after", afterSequence: parsed }, limit };
}

/** A non-negative safe integer written in decimal digits, or `undefined`: "1e3", "0x10", "-1" and "2.5" are not one. */
function wholeNumber(value: string): number | undefined {
  if (!/^\d{1,15}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
