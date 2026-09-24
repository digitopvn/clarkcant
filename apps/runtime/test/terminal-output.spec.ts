import { describe, expect, it } from "vitest";

import { createMarkScanner, keepTail, plainTerminalText } from "../src/terminal-output.ts";

/**
 * The part of the terminal that reads a shell's own output: where a command starts and ends (OSC 133), and what it
 * printed once the escape sequences are gone.
 */
describe("the OSC 133 mark scanner", () => {
  it("splits text from marks and keeps their order", () => {
    const scanner = createMarkScanner();
    const events = scanner.push("before\u001b]133;C;ls -la\u0007out\u001b]133;D;0\u001b\\after");
    expect(events).toEqual([
      { kind: "text", text: "before" },
      { kind: "mark", code: "C", payload: "ls -la" },
      { kind: "text", text: "out" },
      { kind: "mark", code: "D", payload: "0" },
      { kind: "text", text: "after" },
    ]);
  });

  it("carries a mark split across two reads rather than losing it", () => {
    const scanner = createMarkScanner();
    const first = scanner.push("abc\u001b]13");
    const second = scanner.push("3;D;2\u0007def");
    const all = [...first, ...second];
    expect(all.filter((event) => event.kind === "mark")).toEqual([{ kind: "mark", code: "D", payload: "2" }]);
    expect(all.filter((event) => event.kind === "text").map((event) => (event.kind === "text" ? event.text : "")).join("")).toBe("abcdef");
  });

  it("passes other escape sequences through untouched, because the screen needs them", () => {
    const scanner = createMarkScanner();
    const events = scanner.push("\u001b[31mred\u001b[0m\u001b]0;title\u0007");
    expect(events).toEqual([{ kind: "text", text: "\u001b[31mred\u001b[0m\u001b]0;title\u0007" }]);
  });
});

describe("plain terminal text", () => {
  it("drops colour and title sequences", () => {
    expect(plainTerminalText("\u001b[1;32mok\u001b[0m\u001b]0;t\u0007 done")).toBe("ok done");
  });

  it("applies a carriage return the way the screen does", () => {
    expect(plainTerminalText("progress 10%\rprogress 100%\r\nnext")).toBe("progress 100%\nnext");
  });

  it("applies backspace", () => {
    expect(plainTerminalText("abx\bc")).toBe("abc");
  });
});

describe("keepTail", () => {
  it("keeps the end, where a result is, and says it cut", () => {
    expect(keepTail("0123456789", 4)).toEqual({ text: "6789", truncated: true });
    expect(keepTail("0123", 4)).toEqual({ text: "0123", truncated: false });
  });
});
