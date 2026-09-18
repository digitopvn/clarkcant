import { describe, expect, it } from "vitest";

import { applyLiveEvent, type LiveSegment } from "../src/live-reply.ts";

/**
 * A reply that is arriving.
 *
 * The failure this guards against is quiet: a tool that starts and whose end is never matched leaves a
 * spinner turning forever in the interface, and nothing about the code that produced it looks wrong.
 * The reducer is pure for exactly this reason — the pairing is arithmetic, so it can be asked directly.
 */

function kinds(segments: readonly LiveSegment[]): string[] {
  return segments.map((segment) => (segment.kind === "tool" ? `tool:${String(segment.block.status)}` : segment.kind));
}

describe("a reply being streamed", () => {
  it("grows one text segment rather than one per delta", () => {
    let segments: LiveSegment[] = [];
    for (const text of ["Xin ", "chào", " bạn"]) {
      segments = applyLiveEvent(segments, { type: "text-delta", text });
    }
    expect(kinds(segments)).toEqual(["text"]);
    expect(segments[0]).toEqual({ kind: "text", text: "Xin chào bạn" });
  });

  it("keeps the order the turn produced: text, a call, then text", () => {
    let segments: LiveSegment[] = [];
    segments = applyLiveEvent(segments, { type: "text-delta", text: "Để tui xem." });
    segments = applyLiveEvent(segments, {
      type: "tool-start",
      toolCallId: "t1",
      name: "show_view",
      label: "Xem bảng",
      args: { view: "canvas.table@1" },
    });
    segments = applyLiveEvent(segments, { type: "text-delta", text: "Đây rồi." });

    expect(kinds(segments)).toEqual(["text", "tool:running", "text"]);
  });

  it("closes the widget its own start opened, leaving it in place", () => {
    let segments: LiveSegment[] = [];
    segments = applyLiveEvent(segments, { type: "tool-start", toolCallId: "t1", name: "a", label: "A", args: {} });
    segments = applyLiveEvent(segments, { type: "tool-start", toolCallId: "t2", name: "b", label: "B", args: {} });
    segments = applyLiveEvent(segments, { type: "tool-end", toolCallId: "t1", status: "done", result: "xong" });

    expect(kinds(segments)).toEqual(["tool:done", "tool:running"]);
    expect(segments[0]).toMatchObject({ block: { result: "xong", toolCallId: "t1" } });
    // A second widget, not a replacement for the first: two calls are two things that happened.
    expect(segments).toHaveLength(2);
  });

  it("keeps reasoning apart from the reply", () => {
    let segments: LiveSegment[] = [];
    segments = applyLiveEvent(segments, { type: "reasoning-delta", text: "nghĩ" });
    segments = applyLiveEvent(segments, { type: "reasoning-delta", text: " tiếp" });
    segments = applyLiveEvent(segments, { type: "text-delta", text: "Trả lời." });
    segments = applyLiveEvent(segments, { type: "reasoning-delta", text: "nghĩ nữa" });

    expect(kinds(segments)).toEqual(["reasoning", "text", "reasoning"]);
    expect(segments[0]).toEqual({ kind: "reasoning", text: "nghĩ tiếp" });
  });

  it("ignores an end whose start it never saw", () => {
    // Nothing to update is not an error: the stored message is what says what happened, and inventing
    // a widget here would draw a call that nothing reported starting.
    const segments = applyLiveEvent([], { type: "tool-end", toolCallId: "t9", status: "done", result: "x" });
    expect(segments).toEqual([]);
  });
});
