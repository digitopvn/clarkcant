import { describe, expect, it } from "vitest";

import { type MemoryRecord } from "@clarkcant/contracts";

import { memoryRow, memoryView, scopeLabel, sourceLabel, timeLabel } from "../src/memory-groups.ts";
import { MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";

/**
 * How a remembered thing reads.
 *
 * The labels are computed from the record rather than written down beside it, because a fixed word for a moving
 * fact is wrong within a day. And the source names an id rather than quoting the message: the row exists so
 * somebody can go and look at where something came from, not so their own words are shown back to them.
 */

/** The Vietnamese catalog lookup, standing in for `useT()` since these are plain-function tests. */
const t = (key: MessageKey): string => MESSAGES_VI[key];

const NOW = "2026-09-19T12:00:00.000Z";

function record(overrides: Record<string, unknown> = {}): MemoryRecord {
  return {
    memoryId: "mem_one",
    kind: "decision",
    scope: "conversation",
    text: "Dùng SQLite cho node cục bộ.",
    sourceConversationId: "conv_localnode",
    at: NOW,
    ...overrides,
  } as MemoryRecord;
}

describe("what a record says about itself", () => {
  it("each kind is named in words a person reads", () => {
    expect(memoryRow(record({ kind: "preference" }), NOW, t).kindLabel).toBe("Sở thích");
    expect(memoryRow(record({ kind: "project-fact" }), NOW, t).kindLabel).toBe("Dự án");
    expect(memoryRow(record({ kind: "decision" }), NOW, t).kindLabel).toBe("Quyết định");
  });

  it("how long ago is computed rather than written down", () => {
    expect(timeLabel(NOW, NOW, t)).toBe("hôm nay");
    expect(timeLabel("2026-09-18T12:00:00.000Z", NOW, t)).toBe("hôm qua");
    expect(timeLabel("2026-09-16T12:00:00.000Z", NOW, t)).toBe("3 ngày trước");
    // Past a week the date is more use than a count of days.
    expect(timeLabel("2026-08-01T12:00:00.000Z", NOW, t)).toBe("2026-08-01");
  });

  it("the scope says whether it is about the person or about this conversation", () => {
    expect(scopeLabel("node", t)).toBe("Mọi cuộc trò chuyện");
    expect(scopeLabel("conversation", t)).toBe("Chỉ cuộc trò chuyện này");
  });

  it("the source names where it came from without quoting it", () => {
    const fromMessage = sourceLabel(record({ sourceMessageId: "msg_abcdefghijklm" }), t);
    // The id, shortened. A full id is noise in a row; no id at all would make the source unverifiable.
    expect(fromMessage.startsWith("từ tin nhắn msg_")).toBe(true);
    expect(fromMessage).not.toContain("ghijklm");
    expect(fromMessage).not.toContain("SQLite");

    const fromConversation = sourceLabel(record(), t);
    expect(fromConversation.startsWith("từ phiên conv_")).toBe(true);
    expect(fromConversation).not.toContain("SQLite");
  });
});

describe("grouping a list", () => {
  it("kinds with nothing in them are left out, and the count is everything", () => {
    const view = memoryView(
      [
        record({ memoryId: "mem_a", kind: "decision" }),
        record({ memoryId: "mem_b", kind: "preference", scope: "node" }),
        record({ memoryId: "mem_c", kind: "decision" }),
      ],
      NOW,
      t,
    );

    // The order is fixed rather than whatever the records arrived in, so the sections do not move around.
    expect(view.groups.map((group) => group.kind)).toEqual(["preference", "decision"]);
    expect(view.groups.find((group) => group.kind === "project-fact")).toBeUndefined();
    expect(view.groups.find((group) => group.kind === "decision")?.rows).toHaveLength(2);
    expect(view.count).toBe(3);
  });

  it("an empty list is an empty view rather than a list of empty sections", () => {
    expect(memoryView([], NOW, t)).toEqual({ groups: [], count: 0 });
  });
});
