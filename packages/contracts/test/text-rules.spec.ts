import { describe, expect, it } from "vitest";

import {
  ONE_LINE_PATTERN,
  ONE_LINE_REQUIRED_PATTERN,
  clipWithMarker,
  codePointLabel,
  findHiddenCharacter,
  hiddenCharacterProblem,
  sliceCodePoints,
} from "../src/index.ts";

/**
 * The characters a card refuses in the model's words, and the helpers that keep a long text honest when it is cut.
 */

const REFUSED = [
  ["a line feed", "\n", "line-break"],
  ["a carriage return", "\r", "line-break"],
  ["a tab", "\t", "control"],
  ["a NUL", "\u0000", "control"],
  ["DEL", "\u007f", "control"],
  ["NEL", "\u0085", "line-break"],
  ["the line separator", " ", "line-break"],
  ["the paragraph separator", " ", "line-break"],
  ["a right-to-left override", "‮", "bidi"],
  ["a left-to-right embedding", "‪", "bidi"],
  ["a first-strong isolate", "⁨", "bidi"],
  ["a pop directional isolate", "⁩", "bidi"],
  ["a right-to-left mark", "‏", "bidi"],
  ["an Arabic letter mark", "؜", "bidi"],
  ["a zero-width space", "​", "invisible"],
  ["a byte order mark", "﻿", "invisible"],
] as const;

describe("hidden characters", () => {
  it.each(REFUSED)("refuses %s and names it", (_name, character, kind) => {
    const value = `ab${character}cd`;
    expect(findHiddenCharacter(value)).toEqual({ codePoint: codePointLabel(character), kind, index: 2 });
    expect(hiddenCharacterProblem(value)).toBe(
      `contains ${codePointLabel(character)}, ${
        kind === "line-break"
          ? "a line break, and this field is one line"
          : kind === "bidi"
            ? "a control that changes text direction, so the text would read differently from how it is drawn"
            : kind === "invisible"
              ? "an invisible character"
              : "a control character"
      }; remove it`,
    );
    expect(new RegExp(ONE_LINE_PATTERN, "u").test(value)).toBe(false);
    expect(new RegExp(ONE_LINE_PATTERN).test(value)).toBe(false);
  });

  it("leaves the joiners people write with alone, and ordinary text of any script", () => {
    for (const value of ["نص عربي", "עברית", "नमस्ते", "👩‍💻", "می‌خواهم", "Tiếng Việt có dấu", "a b"]) {
      expect(findHiddenCharacter(value), value).toBeUndefined();
      expect(new RegExp(ONE_LINE_PATTERN, "u").test(value), value).toBe(true);
    }
  });

  it("lets a line feed and a tab through where text is many lines, and nothing else", () => {
    expect(findHiddenCharacter("a\n\tb", { lineBreaks: true })).toBeUndefined();
    expect(findHiddenCharacter("a\nb c", { lineBreaks: true })).toEqual({ codePoint: "U+2028", kind: "line-break", index: 3 });
    expect(findHiddenCharacter("a\r\nb", { lineBreaks: true })?.codePoint).toBe("U+000D");
  });

  it("requires a required line to hold more than spaces", () => {
    const required = new RegExp(ONE_LINE_REQUIRED_PATTERN, "u");
    expect(required.test("Owner")).toBe(true);
    expect(required.test("  x ")).toBe(true);
    expect(required.test("")).toBe(false);
    expect(required.test("   ")).toBe(false);
    expect(required.test("a‮b")).toBe(false);
  });
});

describe("cutting text", () => {
  it("never cuts a surrogate pair in half", () => {
    expect(sliceCodePoints("ab😀cd", 3)).toBe("ab");
    expect(sliceCodePoints("ab😀cd", 4)).toBe("ab😀");
    expect(sliceCodePoints("abc", 10)).toBe("abc");
  });

  it("says when it had to shorten, and stays within the limit", () => {
    expect(clipWithMarker("short", 10)).toBe("short");
    const clipped = clipWithMarker("x".repeat(50), 20);
    expect(clipped.length).toBeLessThanOrEqual(20);
    expect(clipped.endsWith("… (shortened)")).toBe(true);
    expect(clipWithMarker(`${"x".repeat(5)}😀${"y".repeat(20)}`, 19)).toBe("xxxxx… (shortened)");
  });
});
