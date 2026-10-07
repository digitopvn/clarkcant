import { describe, expect, it } from "vitest";

import type { TimelinePageQuery } from "@clarkcant/contracts";

import type { Timeline } from "../src/api.ts";
import { mergeTimeline, olderPageCursor, pageForInstance, windowOf } from "../src/timeline-window.ts";

/**
 * A conversation as the node stores it, answering pages with the contract the node's `messagePage` follows: the page,
 * and the range of sequences it is the whole truth about, bounded by the next message it left out.
 */
class StoredConversation {
  readonly messages: { sequence: number; messageId: string }[] = [];
  cursor = 0;

  constructor(count: number) {
    for (let index = 0; index < count; index += 1) this.say();
  }

  say(): string {
    const sequence = (this.messages.at(-1)?.sequence ?? 0) + 1;
    const messageId = `msg_${String(sequence)}`;
    this.messages.push({ sequence, messageId });
    this.cursor += 1;
    return messageId;
  }

  remove(sequence: number): void {
    const index = this.messages.findIndex((message) => message.sequence === sequence);
    if (index >= 0) this.messages.splice(index, 1);
    this.cursor += 1;
  }

  page(query: TimelinePageQuery, limit = 200): Timeline {
    const all = this.messages;
    let kept: typeof all;
    let fromSequence: number;
    let toSequence: number;
    let hasOlder: boolean;
    let hasNewer: boolean;
    if (query.kind === "after") {
      const later = all.filter((message) => message.sequence > query.afterSequence);
      kept = later.slice(0, limit);
      const next = later[limit];
      fromSequence = query.afterSequence + 1;
      toSequence = next !== undefined ? next.sequence - 1 : Math.max(query.afterSequence, kept.at(-1)?.sequence ?? 0);
      hasOlder = all.some((message) => message.sequence <= query.afterSequence);
      hasNewer = next !== undefined;
    } else {
      const earlier = query.kind === "latest" ? all : all.filter((message) => message.sequence < query.beforeSequence);
      kept = earlier.slice(-limit);
      const previous = earlier.at(-limit - 1);
      fromSequence = earlier.length > limit && previous !== undefined ? previous.sequence + 1 : 0;
      toSequence = query.kind === "latest" ? (kept.at(-1)?.sequence ?? 0) : query.beforeSequence - 1;
      hasOlder = earlier.length > limit;
      hasNewer = all.some((message) => message.sequence > toSequence);
    }
    return {
      conversationId: "conv_long",
      cursor: this.cursor,
      messages: kept.map((message) => ({ messageId: message.messageId, role: "assistant", blocks: [], createdAt: "2026-10-06T00:00:00.000Z" })),
      pins: [],
      instances: [],
      snapshots: [],
      metadata: { messageCount: all.length, taskCount: 0, updatedAt: "2026-10-06T00:00:00.000Z" },
      activeTaskIds: [],
      window: { version: 1, fromSequence, toSequence, hasOlder, hasNewer, sequences: kept.map((message) => message.sequence) },
    };
  }
}

const idsOf = (timeline: Timeline): string[] => timeline.messages.map((message) => message.messageId);
const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, index) => `msg_${String(from + index)}`);

/** Scroll all the way back, as a reader at the top of the transcript would, merging each older page in front. */
function scrollToStart(stored: StoredConversation, held: Timeline, limit = 200): { held: Timeline; reads: number } {
  let reads = 0;
  for (let cursor = olderPageCursor(held); cursor !== undefined; cursor = olderPageCursor(held)) {
    held = mergeTimeline(held, stored.page({ kind: "before", beforeSequence: cursor }, limit));
    reads += 1;
  }
  return { held, reads };
}

describe("merging timeline pages into the held window", () => {
  it("opens on the newest page and scrolls back through thousands of messages, each merged exactly once", () => {
    const stored = new StoredConversation(4_321);
    const opened = mergeTimeline(undefined, stored.page({ kind: "latest" }));
    expect(idsOf(opened)).toEqual(range(4_122, 4_321));

    const { held, reads } = scrollToStart(stored, opened);
    expect(reads).toBe(21);
    expect(idsOf(held)).toEqual(range(1, 4_321));
    expect(windowOf(held)).toMatchObject({ fromSequence: 0, toSequence: 4_321, hasOlder: false, hasNewer: false });
    expect(olderPageCursor(held)).toBeUndefined();
  });

  it("keeps the history scrolled back to when a refresh answers with the newest page", () => {
    const stored = new StoredConversation(700);
    let held = mergeTimeline(undefined, stored.page({ kind: "latest" }));
    held = mergeTimeline(held, stored.page({ kind: "before", beforeSequence: olderPageCursor(held)! }));
    expect(idsOf(held)).toEqual(range(301, 700));

    // A turn is sent; the send's answer, a voice refresh and a widget action each carry the newest page.
    stored.say();
    stored.say();
    for (let refresh = 0; refresh < 3; refresh += 1) held = mergeTimeline(held, stored.page({ kind: "latest" }));

    expect(idsOf(held)).toEqual(range(301, 702));
    expect(held.messages.at(-1)?.messageId).toBe("msg_702");
    expect(windowOf(held)).toMatchObject({ fromSequence: 301, toSequence: 702, hasOlder: true });
  });

  it("takes the newest page as the window when more was said than one page holds, rather than leaving a gap", () => {
    const stored = new StoredConversation(250);
    const held = mergeTimeline(undefined, stored.page({ kind: "latest" }));
    // A long disconnect: 300 messages arrive, more than the 200 the newest page carries.
    for (let index = 0; index < 300; index += 1) stored.say();
    const reconnected = mergeTimeline(held, stored.page({ kind: "latest" }));
    expect(idsOf(reconnected)).toEqual(range(351, 550));
    // The history in between is read again by scrolling back, without a duplicate or a gap.
    expect(idsOf(scrollToStart(stored, reconnected).held)).toEqual(range(1, 550));
  });

  it("drops an older page that cannot be stitched to the held window", () => {
    const stored = new StoredConversation(900);
    const held = mergeTimeline(undefined, stored.page({ kind: "latest" }));
    const stray = stored.page({ kind: "before", beforeSequence: 300 });
    const merged = mergeTimeline(held, stray);
    expect(idsOf(merged)).toEqual(idsOf(held));
    expect(windowOf(merged)).toEqual(windowOf(held));
  });

  it("lets the page decide what is inside its own range, so a removed message goes", () => {
    const stored = new StoredConversation(450);
    let held = mergeTimeline(undefined, stored.page({ kind: "latest" }));
    held = mergeTimeline(held, stored.page({ kind: "before", beforeSequence: olderPageCursor(held)! }));
    stored.remove(440);
    held = mergeTimeline(held, stored.page({ kind: "latest" }));
    expect(idsOf(held)).not.toContain("msg_440");
    expect(idsOf(held)).toHaveLength(399);
  });

  it("keeps the newer read of what is the conversation's as a whole when an older answer arrives late", () => {
    const stored = new StoredConversation(10);
    const early = stored.page({ kind: "latest" });
    stored.say();
    const late = { ...stored.page({ kind: "latest" }), pins: [{ pinId: "pin_1", instanceId: "winst_1", displayMode: "compact", position: 0, refreshPolicy: "live" }] };
    const merged = mergeTimeline(mergeTimeline(undefined, late), early);
    expect(merged.pins).toHaveLength(1);
    expect(merged.cursor).toBe(late.cursor);
    expect(idsOf(merged)).toEqual(range(1, 11));
  });

  it("keeps the instances and snapshots of the held window, the newer read winning for one in both", () => {
    const stored = new StoredConversation(5);
    const instance = (revision: number): Timeline["instances"][number] => ({
      instanceId: "winst_1",
      definitionId: "chart.bar@1",
      definitionVersion: "1",
      lifecycle: "active",
      revision,
      props: {},
    });
    const first = { ...stored.page({ kind: "latest" }), instances: [instance(1), { ...instance(1), instanceId: "winst_far" }] };
    stored.say();
    const second = { ...stored.page({ kind: "latest" }), instances: [instance(2)] };
    const merged = mergeTimeline(first, second);
    expect(merged.instances.find((entry) => entry.instanceId === "winst_1")?.revision).toBe(2);
    expect(merged.instances.map((entry) => entry.instanceId)).toContain("winst_far");
  });

  it("keeps an already held message as the same object, so a settled row does not draw again", () => {
    const stored = new StoredConversation(30);
    const held = mergeTimeline(undefined, stored.page({ kind: "latest" }));
    stored.say();
    const merged = mergeTimeline(held, stored.page({ kind: "latest" }));
    expect(merged.messages[0]).toBe(held.messages[0]);
    expect(merged.messages.at(-2)).toBe(held.messages.at(-1));
  });

  it("takes a page as it is from a node older than windows, or for another conversation", () => {
    const stored = new StoredConversation(20);
    const held = mergeTimeline(undefined, stored.page({ kind: "latest" }));
    const { window: _dropped, ...legacy } = stored.page({ kind: "after", afterSequence: 0 }, 5);
    expect(mergeTimeline(held, legacy)).toBe(legacy);
    const other = { ...stored.page({ kind: "latest" }), conversationId: "conv_other" };
    expect(mergeTimeline(held, other)).toBe(other);
    // A window that does not account for its own messages is no window.
    const broken = { ...stored.page({ kind: "latest" }) };
    broken.window = { ...broken.window!, sequences: broken.window!.sequences.slice(1) };
    expect(windowOf(broken)).toBeUndefined();
  });
});

describe("reading one widget's view again", () => {
  it("reads the one-message page of the newest held message drawing the widget", () => {
    const stored = new StoredConversation(400);
    const held = mergeTimeline(undefined, stored.page({ kind: "latest" }));
    const index = 17;
    const target = held.messages[index]!;
    held.messages[index] = { ...target, blocks: [{ type: "widget-ref", instanceId: "winst_far" }] };
    expect(pageForInstance(held, "winst_far")).toEqual({ page: { kind: "after", afterSequence: held.window!.sequences[index]! - 1 }, limit: 1 });
    expect(pageForInstance(held, "winst_elsewhere")).toEqual({ page: { kind: "latest" } });
    expect(pageForInstance(undefined, "winst_far")).toEqual({ page: { kind: "latest" } });
  });
});
