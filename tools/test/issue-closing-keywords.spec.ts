import { describe, expect, it } from "vitest";

import { closingKeywordMatches } from "../issue-closing-keywords.mjs";

/**
 * The pattern that closed #93 and #125 by accident, and the prose it must leave alone.
 *
 * Both directions matter here. A check that misses the defensive sentence is the bug it exists to prevent, and a
 * check that fires on a body merely naming an issue would make the honest sentence impossible to write.
 */
describe("closingKeywordMatches", () => {
  it("matches a keyword followed by a reference, which is what GitHub closes on", () => {
    expect(closingKeywordMatches("This PR does not close #93.")).toEqual([
      { line: 1, keyword: "close", reference: 93, matched: "close #93" },
    ]);
  });

  it("matches every closing keyword GitHub acts on", () => {
    const keywords = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];
    for (const keyword of keywords) {
      const matches = closingKeywordMatches(`It ${keyword} #12`);
      expect(matches.map((match) => match.keyword), keyword).toEqual([keyword]);
      expect(matches[0]?.reference, keyword).toBe(12);
    }
  });

  it("matches case-insensitively, because the parser does", () => {
    expect(closingKeywordMatches("Closes #7").map((match) => match.reference)).toEqual([7]);
  });

  it("matches a colon between the keyword and the reference", () => {
    expect(closingKeywordMatches("Fixes: #7").map((match) => match.matched)).toEqual(["Fixes: #7"]);
  });

  it("reports the line the pair is on", () => {
    const body = "line one\nline two\nThis does not close #93, #2 or #3.\n";
    expect(closingKeywordMatches(body).map((match) => match.line)).toEqual([3]);
  });

  it("does not match a word that merely contains a keyword", () => {
    expect(closingKeywordMatches("closing keywords for them")).toEqual([]);
    expect(closingKeywordMatches("an unclosed question")).toEqual([]);
    expect(closingKeywordMatches("prefixes #1")).toEqual([]);
  });

  it("does not match an issue number with no keyword beside it", () => {
    expect(closingKeywordMatches("#2, #3, #4 and #5 stay open")).toEqual([]);
    expect(closingKeywordMatches("part of #125 (Phase 1 of 6)")).toEqual([]);
    expect(closingKeywordMatches("#93 is CLOSED, and nothing here claims otherwise")).toEqual([]);
  });

  it("does not match a reference on the following line, which GitHub does not close either", () => {
    expect(closingKeywordMatches("This does not close\n#93.")).toEqual([]);
  });

  it("finds every pair on a line, not only the first", () => {
    expect(closingKeywordMatches("closes #1 and fixes #2").map((match) => match.reference)).toEqual([1, 2]);
  });

  it("finds nothing in a body that names its issues without a closing keyword", () => {
    const rewritten =
      "This PR **completes no external gate**. Issues #93, #2, #3, #4 and #5 stay as they were, and this body " +
      "carries no closing keyword for any of them.\n";
    expect(closingKeywordMatches(rewritten)).toEqual([]);
  });
});
