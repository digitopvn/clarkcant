import { describe, expect, it } from "vitest";

import { markDraft, type DraftLine } from "../src/composer-markdown.ts";

const text = (lines: DraftLine[]): string => lines.map((line) => line.map((part) => part.text).join("")).join("\n");
const marked = (draft: string): [string, string][] =>
  markDraft(draft).flatMap((line) => line.map((part): [string, string] => [part.text, part.marks.join("+")]));

describe("the composer's live Markdown", () => {
  it("gives back exactly what was typed, character for character, so the mirror lines up with the field", () => {
    const drafts = [
      "",
      "plain words",
      "**bold** and *em* and `code` and ~~gone~~",
      "# Title\n- one\n- two\n> quoted **strong**\n",
      "```ts\nconst a = `x`;\n```\nafter",
      "[link](https://example.com) and https://clark.test/path.",
      "**unclosed and `half",
      "snake_case_name 2*3*4",
      "\n\n",
    ];
    for (const draft of drafts) expect(text(markDraft(draft))).toBe(draft);
  });

  it("marks the syntax apart from what it marks", () => {
    expect(marked("a **b** c")).toEqual([
      ["a ", ""],
      ["**", "strong+syntax"],
      ["b", "strong"],
      ["**", "strong+syntax"],
      [" c", ""],
    ]);
    expect(marked("`x*y*`")).toEqual([
      ["`", "code+syntax"],
      ["x*y*", "code"],
      ["`", "code+syntax"],
    ]);
  });

  it("leaves an unclosed marker and a marker inside a word as typed", () => {
    expect(marked("**open")).toEqual([["**open", ""]]);
    expect(marked("snake_case_name")).toEqual([["snake_case_name", ""]]);
  });

  it("reads headings, lists, quotes and links by their lines and brackets", () => {
    expect(marked("## Plan")).toEqual([
      ["## ", "heading+syntax"],
      ["Plan", "heading"],
    ]);
    expect(marked("  - item")).toEqual([
      ["  ", ""],
      ["- ", "list"],
      ["item", ""],
    ]);
    expect(marked("> note")).toEqual([
      ["> ", "quote+syntax"],
      ["note", "quote"],
    ]);
    expect(marked("[Clark](https://x.test)")).toEqual([
      ["[", "syntax"],
      ["Clark", "link"],
      ["](", "syntax"],
      ["https://x.test", "url"],
      [")", "syntax"],
    ]);
  });

  it("takes everything inside a fence literally until the fence closes", () => {
    expect(marked("```\n**not bold**\n```\n**bold**")).toEqual([
      ["```", "fence+syntax"],
      ["**not bold**", "fence"],
      ["```", "fence+syntax"],
      ["**", "strong+syntax"],
      ["bold", "strong"],
      ["**", "strong+syntax"],
    ]);
  });
});
