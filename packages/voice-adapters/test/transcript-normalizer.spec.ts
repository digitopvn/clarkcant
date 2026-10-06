import { MAX_NORMALIZATION_CHANGES, MAX_RECOGNITION_TERMS, recognitionContextSchema } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import { CODING_GLOSSARY, buildRecognitionContext, vocabularyFromText, vocabularyTerm } from "../src/coding-vocabulary.ts";
import { normalizeTranscript, withinOneEdit } from "../src/transcript-normalizer.ts";

/**
 * The vocabulary and the deterministic normaliser.
 *
 * The normaliser is allowed exactly four kinds of change and has to show evidence for each; everything here is about
 * what it changes, what it refuses to change, and that it says which.
 */

const CONTEXT = buildRecognitionContext({
  symbols: ["voiceSession", "voice_session", "useVoiceSession"],
  packages: ["@clarkcant/voice-adapters"],
  repositories: ["clarkcant", "clarkcant-web"],
  paths: ["voice-session.ts"],
});

const normalized = (text: string): string => normalizeTranscript(text, CONTEXT).text;

describe("the session vocabulary", () => {
  it("drops anything the shared redaction would touch, so a secret never becomes a vocabulary term", () => {
    // Assembled at run time, so the repository's own secret scan does not read a test fixture as a leaked key.
    const anthropicShaped = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    const githubShaped = `${"ghp"}_${"abcdefghijklmnopqrstuvwxyz0123456789AB"}`;
    expect(vocabularyTerm(anthropicShaped)).toBeUndefined();
    expect(vocabularyTerm(githubShaped)).toBeUndefined();
    const context = buildRecognitionContext({ symbols: ["useEffect", anthropicShaped] });
    expect(JSON.stringify(context)).not.toContain("sk-ant");
  });

  it("refuses sentences, overlong strings and bare numbers, but keeps an issue reference", () => {
    expect(vocabularyTerm("a b c d e")).toBeUndefined();
    expect(vocabularyTerm("x".repeat(81))).toBeUndefined();
    expect(vocabularyTerm("1234")).toBeUndefined();
    expect(vocabularyTerm("  useEffect  ")).toBe("useEffect");
    expect(vocabularyTerm("#468")).toBe("#468");
  });

  it("stays within the contract's bound however much it is given, and validates against the schema", () => {
    const many = Array.from({ length: 400 }, (_, index) => `symbolNumber${index}x`);
    const context = buildRecognitionContext({ symbols: many, packages: many.map((name) => `pkg-${name}`) });
    expect(context.terms.length).toBeLessThanOrEqual(MAX_RECOGNITION_TERMS);
    expect(recognitionContextSchema.parse(context)).toEqual(context);
  });

  it("ranks the session's own words above the generic glossary, and a mentioned term above an unmentioned one", () => {
    const context = buildRecognitionContext({
      symbols: ["quietSymbol", "talkedAbout"],
      recentText: ["we keep coming back to talkedAbout", "talkedAbout again"],
    });
    const rank = (text: string): number => context.terms.findIndex((term) => term.text === text);
    expect(rank("talkedAbout")).toBeLessThan(rank("quietSymbol"));
    expect(rank("quietSymbol")).toBeLessThan(rank("Electron"));
    // The conversation text ranks; it is never itself a term.
    expect(JSON.stringify(context)).not.toContain("coming back");
  });

  it("dedupes case-insensitively and keeps the glossary's aliases", () => {
    const context = buildRecognitionContext({ tools: ["PNPM"] });
    expect(context.terms.filter((term) => term.text.toLowerCase() === "pnpm")).toHaveLength(1);
    const glossary = CODING_GLOSSARY.find((entry) => entry.text === "pnpm");
    expect(glossary?.aliases).toContain("pnp m");
  });

  it("finds code-shaped mentions in conversation text", () => {
    const found = vocabularyFromText(["xem `useVoiceSession` trong apps/runtime/src/voice-session.ts, branch feat/468-x, issue #468, biến voice_session"]);
    expect(found.symbols).toEqual(expect.arrayContaining(["useVoiceSession", "voice_session"]));
    expect(found.paths).toContain("apps/runtime/src/voice-session.ts");
    expect(found.branches).toContain("feat/468-x");
    expect(found.issues).toContain("#468");
  });
});

describe("normalising a code-switched utterance", () => {
  it("restores identifiers split the way speech splits them, and known mis-hearings", () => {
    expect(normalized("sửa lỗi stale closer trong use effect")).toBe("sửa lỗi stale closure trong useEffect");
    expect(normalized("cài core pack rồi bật p and pm")).toBe("cài Corepack rồi bật pnpm");
    expect(normalized("chạy vite test rồi mở pull request")).toBe("chạy Vitest rồi mở pull request");
    expect(normalized("dùng hook use voice session")).toBe("dùng hook useVoiceSession");
    expect(normalized("push lên clark cant web")).toBe("push lên clarkcant-web");
    expect(normalized("Jeff quyết định thế nào")).toBe("Jev quyết định thế nào");
  });

  it("records every change with its rule, bounded", () => {
    const result = normalizeTranscript("sửa lỗi stale closer trong use effect", CONTEXT);
    expect(result.changes).toEqual([
      { from: "stale closer", to: "stale closure", rule: "alias", kind: "glossary" },
      { from: "use effect", to: "useEffect", rule: "spacing", kind: "symbol" },
    ]);
    const long = Array.from({ length: 50 }, () => "use effect").join(" và ");
    expect(normalizeTranscript(`sửa ${long}`, CONTEXT).changes.length).toBeLessThanOrEqual(MAX_NORMALIZATION_CHANGES);
  });

  it("raises casing for a known name, and never lowers it", () => {
    expect(normalized("dùng Json để lưu")).toBe("dùng JSON để lưu");
    expect(normalized("dùng PNPM để cài")).toBe("dùng PNPM để cài");
  });
});

describe("refusing to guess", () => {
  it("abstains when a span could be two known terms, and says which", () => {
    const result = normalizeTranscript("đổi tên biến voice session cho rõ hơn", CONTEXT);
    expect(result.text).toBe("đổi tên biến voice session cho rõ hơn");
    expect(result.abstained).toEqual([{ start: 13, end: 26, text: "voice session", candidates: ["voiceSession", "voice_session"] }]);
    expect(result.changes).toEqual([]);
  });

  it("never turns one command into another", () => {
    expect(normalized("git stat rồi git stash")).toBe("git stat rồi git stash");
    expect(normalized("git stash my changes")).toBe("git stash my changes");
  });

  it("leaves English prose alone when nothing in it says it is about code", () => {
    expect(normalized("check the use effect cleanup")).toBe("check the use effect cleanup");
    expect(normalized("the stale closer in use effect")).toBe("the stale closer in use effect");
  });

  it("leaves ordinary Vietnamese and spoken decisions untouched", () => {
    for (const sentence of ["đồng ý", "không", "mở settings", "hôm nay trời đẹp quá", "ok làm đi"]) expect(normalized(sentence)).toBe(sentence);
  });

  it("is idempotent: canonical text normalises to itself", () => {
    for (const sentence of ["sửa lỗi stale closer trong use effect", "cài core pack rồi bật p and pm", "push lên clark cant web"]) {
      const once = normalized(sentence);
      expect(normalized(once)).toBe(once);
      expect(normalizeTranscript(once, CONTEXT).changes).toEqual([]);
    }
  });
});

describe("one edit apart", () => {
  it("allows one substitution, insertion, deletion or swap, and nothing more", () => {
    expect(withinOneEdit("playwright", "playwrigt")).toBe(true);
    expect(withinOneEdit("corepack", "corepakc")).toBe(true);
    expect(withinOneEdit("electron", "electron")).toBe(true);
    expect(withinOneEdit("electron", "elektrom")).toBe(false);
  });
});
