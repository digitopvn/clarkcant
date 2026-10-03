import { describe, expect, it } from "vitest";

import type { Timeline, TimelineAction, ViewStateWriteResult } from "../src/api.ts";
import { createStateOnlyWriter, type SequencedStateOnlyWrite, type StateOnlyWrite } from "../src/state-only-writes.ts";

/**
 * The page's side of a player's state-only writes (#380): one in flight, only the latest waiting write sent, the leaving
 * write sent at once with nothing older after it, every write stamped with a sequence that keeps growing, and the
 * node's answer held for the next draw.
 */

const ACTION = { actionBindingId: "act_view", bindingDigest: "sha256:view" } as unknown as TimelineAction;

function write(position: number, revision = 4): StateOnlyWrite {
  return {
    conversation: "conv_1",
    instanceId: "winst_video",
    revision,
    action: ACTION,
    view: { status: "playing", position, duration: 600 },
    refused: "widgets.action.refusedGeneric",
  };
}

interface Sent {
  write: SequencedStateOnlyWrite;
  keepalive: boolean;
  resolve: (result: ViewStateWriteResult) => void;
  reject: (cause: unknown) => void;
}

function harness(clock: { at: number } = { at: 1_000 }) {
  const sent: Sent[] = [];
  const timelines: Timeline[] = [];
  const refused: unknown[] = [];
  let ids = 0;
  const writer = createStateOnlyWriter({
    send: (sequenced, _invocationId, { keepalive }) =>
      new Promise<ViewStateWriteResult>((resolve, reject) => {
        sent.push({ write: sequenced, keepalive, resolve, reject });
      }),
    newInvocationId: () => `inv_${String(++ids)}`,
    onSending: () => undefined,
    onTimeline: (timeline) => timelines.push(timeline),
    onRefused: (_write, cause) => refused.push(cause),
    now: () => clock.at,
  });
  return { writer, sent, timelines, refused, clock };
}

function answer(sent: Sent, stateRevision: number, revision = sent.write.revision, extra: Partial<ViewStateWriteResult> = {}): void {
  sent.resolve({ duplicate: false, instanceId: "winst_video", revision, stateRevision, state: sent.write.view, ...extra });
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("a player's state-only writes from the page", () => {
  it("keeps one write in flight and sends only the latest waiting one, at the revision the node answered with", async () => {
    const { writer, sent } = harness();
    writer.send(write(3), false);
    writer.send(write(6), false);
    writer.send(write(9), false);
    expect(sent).toHaveLength(1);

    answer(sent[0] as Sent, 1);
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.write.view).toMatchObject({ position: 9 });
    expect(sent[1]?.keepalive).toBe(false);
  });

  it("sends the leaving write at once and nothing older after it, even when the write in flight answers late", async () => {
    const { writer, sent, clock } = harness();
    writer.send(write(100), false); // T, in flight
    clock.at += 1;
    writer.send({ ...write(240), view: { status: "playing", position: 240, duration: 600 } }, false); // S, a seek, waits
    clock.at += 1;
    writer.send({ ...write(241), view: { status: "paused", position: 241, duration: 600 } }, true); // L, the page leaves
    expect(sent.map((entry) => entry.write.view.position)).toEqual([100, 241]);
    expect(sent[1]?.keepalive).toBe(true);

    // T finishes after L: the seek that waited behind it is not sent after the leaving write.
    answer(sent[0] as Sent, 1);
    await settle();
    expect(sent).toHaveLength(2);
    // Stamped when the player made them, so the node can tell the leaving write is the newest whatever arrives last.
    const [inFlight, leaving] = sent.map((entry) => entry.write.sequence);
    expect(leaving).toBeGreaterThan(inFlight ?? Number.POSITIVE_INFINITY);
  });

  it("stamps a sequence that grows on every write, within one millisecond and across a reload", () => {
    const clock = { at: 5_000 };
    const first = harness(clock);
    first.writer.send(write(1), false);
    first.writer.send(write(2), true);
    first.writer.send(write(3), true);
    const sequences = first.sent.map((entry) => entry.write.sequence);
    expect(sequences).toEqual([5_000, 5_001, 5_002]);

    // A reload starts a new writer; the clock has moved on, so its first write is newer than anything before it.
    clock.at = 9_000;
    const reloaded = harness(clock);
    reloaded.writer.send(write(4), false);
    expect(reloaded.sent[0]?.write.sequence).toBeGreaterThan(sequences[2] ?? Number.POSITIVE_INFINITY);
  });

  it("holds what the node answered for the next draw, until a timeline carries a newer state", async () => {
    const { writer, sent } = harness();
    writer.send(write(30), false);
    answer(sent[0] as Sent, 7);
    await settle();
    const fromTimeline = { status: "paused", position: 0, duration: 600 };
    expect(writer.nodeState("winst_video", 6, fromTimeline)).toMatchObject({ position: 30 });
    expect(writer.nodeState("winst_video", 8, fromTimeline)).toBe(fromTimeline);
    expect(writer.nodeState("winst_other", 1, fromTimeline)).toBe(fromTimeline);
  });

  it("applies the timeline an older node answers with, and sends the next write at the revision it moved to", async () => {
    const { writer, sent, timelines } = harness();
    writer.send(write(3, 4), false);
    writer.send(write(6, 4), false);
    const timeline = { items: [] } as unknown as Timeline;
    // A node from before the variant took it as an ordinary action: the revision moved and the conversation came back.
    answer(sent[0] as Sent, 2, 5, { timeline });
    await settle();
    expect(timelines).toEqual([timeline]);
    expect(sent[1]?.write.revision).toBe(5);
  });

  it("says a refusal beside the player and sends the next write afresh", async () => {
    const { writer, sent, refused } = harness();
    writer.send(write(3), false);
    sent[0]?.reject(new Error("REVISION_MISMATCH"));
    await settle();
    expect(refused).toHaveLength(1);
    writer.send(write(6), false);
    expect(sent).toHaveLength(2);
  });
});
