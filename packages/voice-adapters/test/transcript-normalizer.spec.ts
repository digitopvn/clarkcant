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

  it("keeps one spelling of a word the session and the glossary spell differently: the heavier one, aliases and all", () => {
    const glossary = CODING_GLOSSARY.find((entry) => entry.text === "pnpm");
    expect(glossary?.aliases).toContain("pnp m");
    // A tool outweighs the glossary, so its spelling stays and the glossary's entry, with its aliases, does not.
    const heavierSession = buildRecognitionContext({ tools: ["PNPM"] });
    expect(heavierSession.terms.filter((term) => term.text.toLowerCase() === "pnpm")).toEqual([
      expect.objectContaining({ text: "PNPM", kind: "tool" }),
    ]);
    expect(heavierSession.terms.find((term) => term.text === "PNPM")?.aliases).toBeUndefined();
    // A repository listed after another outweighs nothing: the glossary's ClarkCant stays, with its aliases.
    const heavierGlossary = buildRecognitionContext({ repositories: ["other-app", "clarkcant", "web"] });
    expect(heavierGlossary.terms.filter((term) => term.text.toLowerCase() === "clarkcant")).toEqual([
      expect.objectContaining({ text: "ClarkCant", kind: "repository", aliases: expect.arrayContaining(["clark cant"]) }),
    ]);
  });

  it("adds no glossary spelling beside a word the session already spells two ways by case", () => {
    const context = buildRecognitionContext({ tools: ["PNPM"], packages: ["Pnpm"] });
    expect(context.terms.filter((term) => term.text.toLowerCase() === "pnpm").map((term) => term.text).sort()).toEqual(["PNPM", "Pnpm"]);
  });

  it("keeps every spelling the session uses when two differ only by case, and each exact spelling once", () => {
    const context = buildRecognitionContext({ symbols: ["UserService", "userService", "userService"] });
    expect(context.terms.filter((term) => term.text.toLowerCase() === "userservice").map((term) => term.text).sort()).toEqual([
      "UserService",
      "userService",
    ]);
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
  });

  it("writes a scoped package's own punctuation once, not twice", () => {
    expect(normalized("cài @clarkcant/voice-adapters đi")).toBe("cài @clarkcant/voice-adapters đi");
    expect(normalized("cài clarkcant voice adapters đi")).toBe("cài @clarkcant/voice-adapters đi");
  });

  it("detects a Vietnamese sentence by any tone-marked vowel, not only the rarer ones", () => {
    // "cái" and "là" carry only marks that French or Spanish also use, and are still Vietnamese.
    expect(normalized("cái này là use effect")).toBe("cái này là useEffect");
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

  it("raises casing for a known name", () => {
    expect(normalized("dùng Json để lưu")).toBe("dùng JSON để lưu");
  });
});

describe("restoring the case of a code-like term heard exactly", () => {
  const SESSION = buildRecognitionContext({
    symbols: ["redactSecrets", "update", "test"],
    repositories: ["clarkcant"],
    paths: ["voice-session.ts"],
  });
  const restored = (text: string): string => normalizeTranscript(text, SESSION).text;

  it("lowers a symbol, a path and a command written with a recognizer's capitals", () => {
    expect(restored("RedactSecrets có bắt được GitHub token không")).toBe("redactSecrets có bắt được GitHub token không");
    expect(restored("chạy PNPM verify trước khi mở pull request")).toBe("chạy pnpm verify trước khi mở pull request");
    expect(restored("PNPM install rồi chạy test")).toBe("pnpm install rồi chạy test");
    expect(restored("run PNPM install before the build")).toBe("run pnpm install before the build");
    expect(restored("Git stash my changes before switching branches")).toBe("git stash my changes before switching branches");
    expect(restored("mở Voice-Session.ts giúp tôi")).toBe("mở voice-session.ts giúp tôi");
    expect(restored("dùng TYPESCRIPT cho file này")).toBe("dùng TypeScript cho file này");
  });

  it("reports the restored case as a casing change of that term", () => {
    expect(normalizeTranscript("RedactSecrets có bắt được token không", SESSION).changes).toEqual([
      { from: "RedactSecrets", to: "redactSecrets", rule: "casing", kind: "symbol" },
    ]);
  });

  it("never turns npm into pnpm: only case is restored, and a command is never guessed", () => {
    const pnpmCount = (text: string): number => text.match(/\bpnpm\b/giu)?.length ?? 0;
    for (const sentence of ["chạy npm install đi", "repo cũ vẫn chạy NPM install", "run npm install then npm verify", "Npm hay PNPM cũng được"]) {
      expect(pnpmCount(restored(sentence))).toBe(pnpmCount(sentence));
    }
    expect(restored("chạy npm install đi")).toBe("chạy npm install đi");
    expect(restored("repo cũ vẫn chạy NPM install")).toBe("repo cũ vẫn chạy NPM install");
  });

  it("restores only an exact match, never a near one", () => {
    // One letter off a code-like term is a different name, whatever its case.
    for (const sentence of ["RedactSecret có bắt được token không", "dùng PNPMX để cài", "Git stashes my changes"]) {
      expect(restored(sentence)).toBe(sentence);
    }
  });

  it("leaves an ordinary word that starts a sentence alone, even when the vocabulary has it", () => {
    for (const sentence of [
      // English prose: a plain symbol, a glossary word and an ordinary word, each starting the sentence.
      "Update the build script before the release",
      "Rebase onto main before you merge",
      "Worktree support landed last week",
      "Test the build on Windows first",
      // Vietnamese prose: the same words starting a Vietnamese sentence.
      "Test này chạy bằng Vitest hay Playwright",
      "Rebase nhánh này lên main rồi push",
      // A proper noun matching a plain lowercase vocabulary entry.
      "ClarkCant có bản cho Windows chưa",
      // A plain name in capitals for emphasis is not a code-like term.
      "REACT hay Vue thì nhanh hơn cho script này",
    ]) {
      expect(restored(sentence)).toBe(sentence);
    }
  });

  it("leaves a plain word in capitals alone outside a command: pnpm on its own is also a word", () => {
    expect(restored("dùng PNPM để cài")).toBe("dùng PNPM để cài");
  });

  it("keeps the capital of a skill or extension name that is an ordinary word starting a sentence", () => {
    // The session's tools include installed skill and extension names, chosen by people and the marketplace.
    const tools = buildRecognitionContext({ tools: ["test", "review", "weather", "deploy", "tasks", "git"] });
    for (const sentence of [
      // English, with cue words ("build", "merge", "server") that make the sentence read as about code.
      "Test the build on Windows first",
      "Review this code before the merge",
      "Weather widget broke the build again",
      "Deploy the server tonight",
      "Tasks for today: fix the build",
      "Git broke the build again",
      // Vietnamese, where the code-switched sentence itself counts as support.
      "Test này chạy bằng Vitest hay Playwright",
      "Review đoạn code này trước khi merge nhé",
      "Weather hôm nay thế nào",
      "Deploy server tối nay được không",
      "Tasks hôm nay gồm những gì",
    ]) {
      expect(normalizeTranscript(sentence, tools).text).toBe(sentence);
    }
    // A command is still restored in the same session.
    expect(normalizeTranscript("PNPM verify trước khi merge", tools).text).toBe("pnpm verify trước khi merge");
  });

  it("lowers a hyphenated or digit skill name only with the evidence a plain word needs", () => {
    const tools = buildRecognitionContext({ tools: ["follow-up", "check-in", "s3", "daily-notes", "todo.app"] });
    const heard = (text: string): string => normalizeTranscript(text, tools).text;
    // English prose with no technical anchor: an ordinary compound or brand keeps the capital it was written with.
    for (const sentence of ["Follow-up with the team tomorrow", "Check-in at the hotel", "S3 is down", "Daily-notes for today"]) {
      expect(heard(sentence)).toBe(sentence);
    }
    // With a technical anchor (a coding word, or a Vietnamese sentence carrying the name), the name is restored.
    expect(heard("Daily-notes skill chạy lỗi khi build")).toBe("daily-notes skill chạy lỗi khi build");
    expect(heard("Daily-notes skill broke the build")).toBe("daily-notes skill broke the build");
    expect(heard("S3 bucket bị lỗi rồi")).toBe("s3 bucket bị lỗi rồi");
    // Code punctuation other than a single hyphen is not an ordinary word.
    expect(heard("Todo.app is open")).toBe("todo.app is open");
  });

  it("is idempotent once case is restored", () => {
    for (const sentence of ["RedactSecrets có bắt được GitHub token không", "chạy PNPM verify trước khi push", "Git stash my changes before switching branches"]) {
      const once = restored(sentence);
      expect(restored(once)).toBe(once);
      expect(normalizeTranscript(once, SESSION).changes).toEqual([]);
    }
  });
});

describe("a term the vocabulary spells two ways by case alone", () => {
  // A class and its instance: two real symbols, so the heard case is the only evidence of which one was meant.
  const SESSION = buildRecognitionContext({ symbols: ["UserService", "userService", "redactSecrets"] });
  const heard = (text: string) => normalizeTranscript(text, SESSION);

  it("leaves userservice, UserService and userService exactly as heard, as a known term", () => {
    for (const spelling of ["userservice", "UserService", "userService", "USERSERVICE"]) {
      const sentence = `sửa lỗi trong ${spelling} trước khi build`;
      const result = heard(sentence);
      expect(result.text).toBe(sentence);
      expect(result.changes).toEqual([]);
      expect(result.abstained).toEqual([]);
      expect(result.technical).toEqual([{ start: 14, end: 14 + spelling.length }]);
    }
    expect(heard("Rename UserService before the build").text).toBe("Rename UserService before the build");
  });

  it("does not pick a case for the term's spoken words, and says which spellings it could be", () => {
    const result = heard("sửa lỗi trong user service");
    expect(result.text).toBe("sửa lỗi trong user service");
    expect(result.abstained).toEqual([{ start: 14, end: 26, text: "user service", candidates: ["UserService", "userService"] }]);
  });

  it("still restores the case of an unambiguous term in the same vocabulary", () => {
    expect(heard("RedactSecrets có bắt được token không").text).toBe("redactSecrets có bắt được token không");
    expect(heard("userService gọi RedactSecrets").text).toBe("userService gọi redactSecrets");
  });
});

describe("words that run together into a longer term than a form starting the same way", () => {
  it("writes the run-together package rather than the two-word name inside it", () => {
    const session = buildRecognitionContext({ repositories: ["ClarkCant"], packages: ["clarkcant", "clarkcant-web"] });
    const result = normalizeTranscript("sửa clark cant web trước", session);
    expect(result.text).toBe("sửa clarkcant-web trước");
    expect(result.changes).toEqual([{ from: "clark cant web", to: "clarkcant-web", rule: "spacing", kind: "package" }]);
    expect(result.abstained).toEqual([]);
  });

  it("still abstains on the two-word name alone when the session spells it two ways by case", () => {
    const session = buildRecognitionContext({ repositories: ["ClarkCant"], packages: ["clarkcant", "clarkcant-web"] });
    const result = normalizeTranscript("sửa clark cant trước", session);
    expect(result.text).toBe("sửa clark cant trước");
    expect(result.abstained).toEqual([{ start: 4, end: 14, text: "clark cant", candidates: ["ClarkCant", "clarkcant"] }]);
  });

  it("still writes the shorter term when the next word does not complete the longer one", () => {
    const session = buildRecognitionContext({ packages: ["clarkcant-web"] });
    expect(normalizeTranscript("sửa clark cant trước", session).text).toBe("sửa ClarkCant trước");
    expect(normalizeTranscript("sửa clark cant web trước", session).text).toBe("sửa clarkcant-web trước");
  });

  describe("still counts the words a run-together term absorbed as evidence for the rest of the sentence", () => {
    // `web` and `Web` are both real names, so "web" heard exactly is a known term and says the sentence is about code.
    // Folded into `webapp`, it says so still: the run-together match is no weaker evidence than the words it took in.
    const SESSION = buildRecognitionContext({
      symbols: ["UserService", "userService", "Web", "web", "userserviceApi"],
      packages: ["userservice-api", "webapp"],
    });

    it("restores ClarkCant beside a run-together web app, and leaves web app as heard", () => {
      const result = normalizeTranscript("fix the clark cant web app now", SESSION);
      expect(result.text).toBe("fix the ClarkCant web app now");
      expect(result.changes).toEqual([{ from: "clark cant", to: "ClarkCant", rule: "spacing", kind: "repository" }]);
      expect(result.abstained).toEqual([]);
    });

    it("restores React after a run-together web app", () => {
      const result = normalizeTranscript("fix the web app react now", SESSION);
      expect(result.text).toBe("fix the web app React now");
      expect(result.changes).toEqual([{ from: "react", to: "React", rule: "casing", kind: "glossary" }]);
    });

    it("abstains on user service api, which reads as either run-together term", () => {
      const result = normalizeTranscript("fix the user service api now", SESSION);
      expect(result.text).toBe("fix the user service api now");
      expect(result.changes).toEqual([]);
      expect(result.abstained).toEqual([
        { start: 8, end: 24, text: "user service api", candidates: ["userservice-api", "userserviceApi"] },
      ]);
    });

    // A span rewritten into a run-together term would take its absorbed word with it, so that word never vouches for
    // another span rewritten the same way: two guesses must not support each other.
    it("leaves two run-together spans as heard when only each other's absorbed words support them", () => {
      const session = buildRecognitionContext({ tools: ["web"], packages: ["webapp"] });
      const result = normalizeTranscript("the web app and the web app", session);
      expect(result.text).toBe("the web app and the web app");
      expect(result.changes).toEqual([]);
    });

    it("leaves set up the web app for grandma as heard", () => {
      const session = buildRecognitionContext({ tools: ["set", "web"], packages: ["setup", "webapp"] });
      const result = normalizeTranscript("set up the web app for grandma", session);
      expect(result.text).toBe("set up the web app for grandma");
      expect(result.changes).toEqual([]);
    });

    it("leaves the front end of the web app as heard", () => {
      const session = buildRecognitionContext({ tools: ["front", "web"], packages: ["frontend", "webapp"] });
      const result = normalizeTranscript("the front end of the web app", session);
      expect(result.text).toBe("the front end of the web app");
      expect(result.changes).toEqual([]);
    });

    // A capitalised hyphenated or digit tool name is evidence, yet lowering it needs evidence too: the word a
    // run-together span absorbed on its strength is not that evidence, or each change would rest only on the other.
    it("keeps Follow-up when the only support for lowering it is the web that webapp absorbed", () => {
      const session = buildRecognitionContext({ tools: ["follow-up", "web"], packages: ["webapp"] }, { glossary: false });
      const result = normalizeTranscript("Follow-up on the web app", session);
      expect(result.text).toBe("Follow-up on the webapp");
      expect(result.changes).toEqual([{ from: "web app", to: "webapp", rule: "spacing", kind: "package" }]);
    });

    it("keeps S3 when the only support for lowering it is the web that webapp absorbed", () => {
      const session = buildRecognitionContext({ tools: ["s3", "web"], packages: ["webapp"] }, { glossary: false });
      const result = normalizeTranscript("S3 is on the web app", session);
      expect(result.text).toBe("S3 is on the webapp");
      expect(result.changes).toEqual([{ from: "web app", to: "webapp", rule: "spacing", kind: "package" }]);
    });
  });
});

describe("a session term spelled one way beside the glossary's spelling", () => {
  it("keeps ClarkCant when the repository clarkcant is not the active one", () => {
    const session = buildRecognitionContext({ repositories: ["other-app", "clarkcant", "web"] });
    expect(normalizeTranscript("sửa clark cant trước", session).text).toBe("sửa ClarkCant trước");
    expect(normalizeTranscript("Clarkcant build lỗi", session).text).toBe("ClarkCant build lỗi");
  });

  it("keeps Gemini when the provider gemini is not listed first", () => {
    const session = buildRecognitionContext({ providers: ["google", "gemini"] });
    expect(session.terms.filter((term) => term.text.toLowerCase() === "gemini").map((term) => term.text)).toEqual(["Gemini"]);
    expect(normalizeTranscript("gemini model", session).text).toBe("Gemini model");
  });

  it("keeps ESLint when the tool eslint comes after many others", () => {
    const tools = [...Array.from({ length: 30 }, (_, index) => `tool-number-${index}`), "eslint"];
    const session = buildRecognitionContext({ tools });
    expect(normalizeTranscript("eslint lỗi", session).text).toBe("ESLint lỗi");
    expect(normalizeTranscript("Eslint lỗi", session).text).toBe("ESLint lỗi");
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

  it("never assembles a command out of a respelled word and its neighbours", () => {
    expect(normalized("chạy git re base đi")).toBe("chạy git re base đi");
    expect(normalized("chạy pnp m install đi")).toBe("chạy pnp m install đi");
    // The same respelling away from a command is still made.
    expect(normalized("cài pnp m rồi chạy test")).toBe("cài pnpm rồi chạy test");
  });

  it("does not respell one real identifier into its neighbour", () => {
    const context = buildRecognitionContext({ symbols: ["getUser"], paths: ["src/app.tsx", "voice-session.ts"] });
    for (const sentence of ["sửa hàm setUser trong file", "mở src/app.ts giúp tui", "mở voice-sessions.ts đi", "mở src/app.tsx giúp tui"]) {
      expect(normalizeTranscript(sentence, context).text).toBe(sentence);
    }
  });

  it("never touches part of a longer written word", () => {
    const context = buildRecognitionContext({ paths: ["gemini-live.ts"] });
    expect(normalizeTranscript("sửa gemini-live.tsx nhé", context).text).toBe("sửa gemini-live.tsx nhé");
    expect(normalizeTranscript("sửa src/gemini-live.ts nhé", context).changes).toEqual([]);
  });

  it("keeps a slip correction to one word of the term, never swallowing a neighbour", () => {
    expect(normalized("open a pull request for this bug")).toBe("open a pull request for this bug");
    expect(normalized("dùng playwrigt để test")).toBe("dùng Playwright để test");
  });

  it("never turns one version into another", () => {
    const context = buildRecognitionContext({ models: ["claude-opus-4"] });
    for (const sentence of ["đổi sang claude opus 3 đi", "đổi sang claude opus 5 đi", "dùng claude opus 45 nhé"]) {
      expect(normalizeTranscript(sentence, context).text).toBe(sentence);
    }
    // The same model said as it is spelled is still written canonically.
    expect(normalizeTranscript("đổi sang claude opus 4 đi", context).text).toBe("đổi sang claude-opus-4 đi");
  });

  it("leaves a person's name alone even when it sounds like a term", () => {
    expect(normalized("Jeff quyết định thế nào")).toBe("Jeff quyết định thế nào");
    expect(normalized("hỏi anh Jeff bên design")).toBe("hỏi anh Jeff bên design");
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
