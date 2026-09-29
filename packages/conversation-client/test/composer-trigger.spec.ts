import { describe, expect, it } from "vitest";

import type { ComposerReference } from "@clarkcant/contracts";

import { activeTrigger, liveReferences, replaceToken, tokenPresent, withoutToken } from "../src/composer-trigger.ts";

const skill: ComposerReference = { kind: "skill", skillId: "review", source: "personal", revision: "a".repeat(64), label: "review" };
const project: ComposerReference = { kind: "project", projectId: "proj_1", label: "clarkcant" };
const file: ComposerReference = { kind: "file", projectId: "proj_1", path: "src/app.ts", label: "clarkcant/src/app.ts" };

function at(draft: string, caret = draft.length) {
  return activeTrigger(draft, caret);
}

describe("where a trigger opens the picker", () => {
  it("opens for a slash at the start of the message or after a space", () => {
    expect(at("/rev")).toEqual({ trigger: "/", start: 0, end: 4, query: "rev" });
    expect(at("xem giúp /")).toEqual({ trigger: "/", start: 9, end: 10, query: "" });
  });

  it("opens for an at sign at the start, after a space, or after opening punctuation", () => {
    expect(at("@")).toEqual({ trigger: "@", start: 0, end: 1, query: "" });
    expect(at("đọc @clark")).toMatchObject({ trigger: "@", start: 4, query: "clark" });
    expect(at("so với (@clark")).toMatchObject({ trigger: "@", start: 8, query: "clark" });
  });

  it("keeps a path typed after a project as the query", () => {
    expect(at("@clarkcant/src/a")).toMatchObject({ trigger: "@", query: "clarkcant/src/a" });
  });

  it("stays shut inside an email address, a URL, a path and plain words", () => {
    expect(at("gửi cho an@example.com")).toBeUndefined();
    expect(at("xem https://x.com/@clark")).toBeUndefined();
    expect(at("mở /usr/bin")).toBeUndefined();
    expect(at("không có gì")).toBeUndefined();
    expect(at("a/b")).toBeUndefined();
    expect(at("")).toBeUndefined();
  });

  it("reads the token under the caret, not the one at the end of the draft", () => {
    const draft = "@clark và /rev";
    expect(activeTrigger(draft, 6)).toEqual({ trigger: "@", start: 0, end: 6, query: "clark" });
    // A caret in the middle of a word: the query is what is before it, the replacement covers the whole word.
    expect(activeTrigger("@clarkcant rồi", 3)).toEqual({ trigger: "@", start: 0, end: 10, query: "cl" });
    // Right after a space the token is empty.
    expect(activeTrigger(draft, 7)).toBeUndefined();
    expect(activeTrigger(draft, 99)).toBeUndefined();
  });
});

describe("choosing a row", () => {
  it("replaces exactly the token and leaves a space after it", () => {
    const draft = "đọc @cla giúp";
    const active = activeTrigger(draft, 8);
    if (active === undefined) throw new Error("expected a trigger");
    expect(replaceToken(draft, active, "@clarkcant")).toEqual({ draft: "đọc @clarkcant giúp", caret: 15 });
  });

  it("adds the space at the end of the draft", () => {
    const active = at("/re");
    if (active === undefined) throw new Error("expected a trigger");
    expect(replaceToken("/re", active, "/review")).toEqual({ draft: "/review ", caret: 8 });
  });

  it("keeps the caret right after a directory being opened, with no space", () => {
    const active = at("@clark");
    if (active === undefined) throw new Error("expected a trigger");
    expect(replaceToken("@clark", active, "@clarkcant/")).toEqual({ draft: "@clarkcant/", caret: 11 });
  });
});

describe("what a message carries", () => {
  it("keeps a reference while its token stands in the text as a whole token", () => {
    expect(tokenPresent("/review xem", "/review")).toBe(true);
    expect(tokenPresent("xem /review.", "/review")).toBe(true);
    expect(tokenPresent("xem /reviewer", "/review")).toBe(false);
    expect(tokenPresent("@clarkcant/src/app.ts", "@clarkcant")).toBe(false);
    expect(tokenPresent("so với (@clarkcant)", "@clarkcant")).toBe(true);
  });

  it("drops a reference whose token was deleted, and keeps several that are still there", () => {
    const chosen = [{ ref: skill }, { ref: project }, { ref: file }];
    expect(liveReferences("/review @clarkcant/src/app.ts", chosen).map((entry) => entry.ref)).toEqual([skill, file]);
    expect(liveReferences("/review và @clarkcant", chosen).map((entry) => entry.ref)).toEqual([skill, project]);
    expect(liveReferences("", chosen)).toEqual([]);
  });

  it("takes a token and its trailing space out of the draft", () => {
    expect(withoutToken("/review xem @clarkcant nhé", "@clarkcant")).toBe("/review xem nhé");
    expect(withoutToken("@clarkcant/src và @clarkcant", "@clarkcant")).toBe("@clarkcant/src và ");
    expect(withoutToken("không có", "@x")).toBe("không có");
  });
});
