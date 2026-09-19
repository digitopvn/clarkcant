import { describe, expect, it } from "vitest";

import {
  SELECTION_MAX_CHARS,
  attachedPrompt,
  backgroundPrompt,
  backgroundTitle,
  explainPrompt,
  selectedText,
} from "../src/selection.ts";

describe("what a highlighted passage can be turned into", () => {
  it("treats a click that happened to drag as no selection", () => {
    expect(selectedText("  ")).toBeUndefined();
    expect(selectedText("ab")).toBeUndefined();
  });

  it("collapses the whitespace a browser hands over", () => {
    // A selection taken across elements arrives full of newlines and indentation; the words are what matter.
    expect(selectedText("  lệnh   đã\n\nchạy  xong ")).toBe("lệnh đã chạy xong");
  });

  it("clips a wall of text rather than quoting all of it", () => {
    const clipped = selectedText("x".repeat(SELECTION_MAX_CHARS + 50));
    expect(clipped?.length).toBe(SELECTION_MAX_CHARS + 1);
    expect(clipped?.endsWith("…")).toBe(true);
  });

  it("quotes the passage above whatever was already typed", () => {
    expect(attachedPrompt("dòng một\ndòng hai", "tại sao?")).toBe("> dòng một\n> dòng hai\n\ntại sao?");
  });

  it("attaches to an empty draft as well, because a quote alone is still a question", () => {
    expect(attachedPrompt("một đoạn", "   ")).toBe("> một đoạn\n");
  });

  it("names a background session after the passage's own opening words", () => {
    expect(backgroundTitle("kiểm thử lại phần thanh toán\nvà báo lại")).toBe("kiểm thử lại phần thanh toán");
    expect(backgroundTitle(`${"d".repeat(120)}`)).toHaveLength(81);
    // A title that is a list of identical labels tells nobody which worker is which.
    expect(backgroundTitle("   \n  ")).toBe("Việc nền từ đoạn được chọn");
  });

  it("asks for an explanation and for background work in the words the model receives", () => {
    expect(explainPrompt("một đoạn")).toContain("một đoạn");
    expect(explainPrompt("một đoạn")).toContain("Giải thích");
    expect(backgroundPrompt("một đoạn")).toContain("phiên nền");
  });
});
