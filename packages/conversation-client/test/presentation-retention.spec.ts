import { describe, expect, it } from "vitest";

import type { Timeline } from "../src/api.ts";
import { PRESENT_BEFORE_REPORT, instanceIdsOf, presentMessages, retainRecent } from "../src/presentation-retention.ts";
import { createObjectUrlSet } from "../src/use-object-urls.ts";

const message = (messageId: string, blocks: Record<string, unknown>[] = []): Timeline["messages"][number] => ({
  messageId,
  role: "assistant",
  blocks,
  createdAt: "2026-10-06T00:00:00.000Z",
});

describe("what is kept for history not on screen", () => {
  it("keeps everything drawn now and only the most recently drawn others, up to the budget", () => {
    let kept = retainRecent([], ["a", "b"], 2);
    expect(kept).toEqual(["a", "b"]);
    kept = retainRecent(kept, ["c"], 2);
    expect(kept).toEqual(["c", "a", "b"]);
    kept = retainRecent(kept, ["d", "e"], 2);
    expect(kept).toEqual(["d", "e", "c", "a"]);
    // Drawn again, a kept reference is drawn now, not counted against the budget.
    kept = retainRecent(kept, ["a"], 2);
    expect(kept).toEqual(["a", "d", "e"]);
    // Asked again with its own answer, it answers the same, so a render that runs twice keeps the same list.
    expect(retainRecent(kept, ["a"], 2)).toEqual(kept);
  });

  it("holds a bounded number of object URLs while scrolling through 2,000 pictures, revoking each it lets go", async () => {
    const live = new Set<string>();
    let fetched = 0;
    let revoked = 0;
    const set = createObjectUrlSet({
      fetchUrl: (reference) => {
        fetched += 1;
        const url = `blob:${reference}`;
        live.add(url);
        return Promise.resolve(url);
      },
      revoke: (url) => {
        revoked += 1;
        live.delete(url);
      },
      onChange: () => undefined,
    });
    const budget = 48;
    let kept: string[] = [];
    let largest = 0;
    for (let first = 0; first < 2_000; first += 5) {
      const present = Array.from({ length: 12 }, (_, offset) => `img_${String(Math.min(first + offset, 1_999))}`);
      kept = retainRecent(kept, present, budget);
      set.want(kept);
      await Promise.resolve();
      await Promise.resolve();
      largest = Math.max(largest, live.size);
      for (const reference of present) expect(set.status(reference)).not.toBe("unlisted");
    }
    expect(fetched).toBe(2_000);
    expect(largest).toBeLessThanOrEqual(12 + budget);
    expect(revoked).toBe(fetched - live.size);
    expect(live.size).toBeLessThanOrEqual(12 + budget);
    set.release();
    expect(live.size).toBe(0);
  });
});

describe("which messages' presentation is read", () => {
  const timeline = (count: number): Timeline => ({
    conversationId: "conv_1",
    cursor: count,
    messages: Array.from({ length: count }, (_, index) => message(`msg_${String(index + 1)}`)),
    pins: [],
    instances: [],
    snapshots: [],
    metadata: { messageCount: count, taskCount: 0, updatedAt: "2026-10-06T00:00:00.000Z" },
    activeTaskIds: [],
  });

  it("reads the newest few before the transcript says what it mounted, and then only what it mounted", () => {
    const held = timeline(1_200);
    expect(presentMessages(held, undefined).map((entry) => entry.messageId)).toEqual(
      held.messages.slice(-PRESENT_BEFORE_REPORT).map((entry) => entry.messageId),
    );
    expect(presentMessages(held, ["msg_3", "msg_900", "msg_gone"]).map((entry) => entry.messageId)).toEqual(["msg_3", "msg_900"]);
    expect(presentMessages(undefined, undefined)).toEqual([]);
  });

  it("names the instances a message draws, by widget reference or captured surface", () => {
    expect(
      instanceIdsOf(
        message("msg_1", [
          { type: "text", text: "hi" },
          { type: "widget-ref", instanceId: "winst_a" },
          { type: "surface", snapshot: { snapshotId: "snap_1", instanceId: "winst_b" } },
          { type: "surface", snapshot: { snapshotId: "snap_2" } },
        ]),
      ),
    ).toEqual(["winst_a", "winst_b"]);
  });
});
