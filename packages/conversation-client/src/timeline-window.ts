import { type TimelinePageQuery, type TimelineWindow, timelineWindowSchema } from "@clarkcant/contracts";

import type { Timeline } from "./api.ts";

/**
 * Merging one timeline page into the window of the conversation a page holds.
 *
 * Every route that answers a change - a send, a widget action, an answered card, a voice turn's refresh - answers with
 * the newest page, and scrolling back reads older ones. A page used to replace whatever was held, which was right only
 * while a whole conversation fitted on one page; past that, a refresh threw away the history the person had scrolled
 * back to, and a reopen showed the oldest page instead of the newest.
 *
 * A page now says which range of message sequences it is the whole truth about (`TimelineWindow`), so merging is
 * arithmetic on that range rather than a guess:
 *
 * - ranges that meet or overlap become one range: the page replaces what was held inside its own range (so a message
 *   removed on the node goes) and everything held outside it stays, with no message twice and no gap;
 * - a page past the newest held message that does not meet it means more was said than one page holds - after a long
 *   disconnect, say. The held window cannot be stitched to it without a gap, so the page is taken as the window and
 *   the older history is read again when the person scrolls back to it;
 * - a page before the oldest held message that does not meet it is dropped, since it could only be stitched with a
 *   gap, and asking again with the held window's own cursor gets the page that does meet it.
 *
 * What is the conversation's as a whole rather than one page's - pins, tasks in flight, counts, the event cursor - and
 * an instance's or snapshot's current view, come from whichever of the two reads is the more recent by event cursor,
 * so an answer that arrives late does not draw an older state over a newer one.
 */
export function mergeTimeline(current: Timeline | undefined, incoming: Timeline): Timeline {
  if (current === undefined || current.conversationId !== incoming.conversationId) return incoming;
  const held = windowOf(current);
  const page = windowOf(incoming);
  // A node from before windows answers whole pages with nothing to merge by: taken as they are, as they always were.
  if (held === undefined || page === undefined) return incoming;

  const incomingIsNewer = incoming.cursor >= current.cursor;
  if (page.fromSequence > held.toSequence + 1) return incoming;
  if (page.toSequence + 1 < held.fromSequence) return withConversationFields(current, incoming, incomingIsNewer);

  const heldById = new Map(current.messages.map((message) => [message.messageId, message]));
  const messages: Timeline["messages"] = [];
  const sequences: number[] = [];
  const keep = (from: Timeline, window: TimelineWindow, inside: (sequence: number) => boolean): void => {
    window.sequences.forEach((sequence, index) => {
      const message = from.messages[index];
      if (message === undefined || !inside(sequence)) return;
      // A stored message never changes, so the one already held is kept as the same object: a settled row's
      // memoised render then sees nothing new and does not draw again.
      messages.push(heldById.get(message.messageId) ?? message);
      sequences.push(sequence);
    });
  };
  keep(current, held, (sequence) => sequence < page.fromSequence);
  keep(incoming, page, () => true);
  keep(current, held, (sequence) => sequence > page.toSequence);

  const fromSequence = Math.min(held.fromSequence, page.fromSequence);
  const toSequence = Math.max(held.toSequence, page.toSequence);
  const shared = withConversationFields(current, incoming, incomingIsNewer);
  return {
    ...shared,
    messages,
    window: {
      version: page.version,
      fromSequence,
      toSequence,
      hasOlder: page.fromSequence <= held.fromSequence ? page.hasOlder : held.hasOlder,
      hasNewer: page.toSequence >= held.toSequence ? page.hasNewer : held.hasNewer,
      sequences,
    },
  };
}

/**
 * The held timeline with what is the conversation's as a whole, and the instances and snapshots, merged with a page's.
 *
 * Instances and snapshots are kept from both, keyed by their ids, because a page carries only those its own messages
 * (and the pins) reference; for one in both, the more recent read wins.
 */
function withConversationFields(current: Timeline, incoming: Timeline, incomingIsNewer: boolean): Timeline {
  const [older, newer] = incomingIsNewer ? [current, incoming] : [incoming, current];
  const instances = new Map(older.instances.map((instance) => [instance.instanceId, instance]));
  for (const instance of newer.instances) instances.set(instance.instanceId, instance);
  const snapshots = new Map(older.snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  for (const snapshot of newer.snapshots) snapshots.set(snapshot.snapshotId, snapshot);
  return {
    ...current,
    cursor: newer.cursor,
    pins: newer.pins,
    metadata: newer.metadata,
    activeTaskIds: newer.activeTaskIds,
    instances: [...instances.values()],
    snapshots: [...snapshots.values()],
  };
}

/** A page's window when it has a readable one that accounts for every message on it, or `undefined`. */
export function windowOf(timeline: Timeline): TimelineWindow | undefined {
  const parsed = timelineWindowSchema.safeParse(timeline.window);
  if (!parsed.success) return undefined;
  const window = parsed.data;
  if (window.sequences.length !== timeline.messages.length) return undefined;
  for (let index = 1; index < window.sequences.length; index += 1) {
    if ((window.sequences[index] ?? 0) <= (window.sequences[index - 1] ?? 0)) return undefined;
  }
  const first = window.sequences[0];
  const last = window.sequences.at(-1);
  if (first !== undefined && first < window.fromSequence) return undefined;
  if (last !== undefined && last > window.toSequence) return undefined;
  return window;
}

/**
 * The read that brings one instance's current view back: the one-message page of the newest held message drawing it,
 * or the newest page when no held message does (it is pinned, or not on screen at all).
 *
 * A refusal that says a widget's view is out of date is about that widget, which may be far up the conversation and so
 * on no newest page; reading its own message's page gets it, and merges like any other page.
 */
export function pageForInstance(
  timeline: Timeline | undefined,
  instanceId: string,
): { page: TimelinePageQuery; limit?: number } {
  const window = timeline === undefined ? undefined : windowOf(timeline);
  if (timeline !== undefined && window !== undefined) {
    for (let index = timeline.messages.length - 1; index >= 0; index -= 1) {
      const blocks = timeline.messages[index]?.blocks ?? [];
      const draws = blocks.some((block) => {
        if (block.type === "widget-ref") return block.instanceId === instanceId;
        if (block.type !== "surface") return false;
        const snapshot = block.snapshot as { instanceId?: unknown } | undefined;
        return snapshot?.instanceId === instanceId;
      });
      const sequence = window.sequences[index];
      if (draws && sequence !== undefined) return { page: { kind: "after", afterSequence: sequence - 1 }, limit: 1 };
    }
  }
  return { page: { kind: "latest" } };
}

/** Whether older messages than the held window exist on the node, and the cursor that reads the page just before it. */
export function olderPageCursor(timeline: Timeline | undefined): number | undefined {
  if (timeline === undefined) return undefined;
  const window = windowOf(timeline);
  if (window === undefined || !window.hasOlder || window.fromSequence < 1) return undefined;
  return window.fromSequence;
}
