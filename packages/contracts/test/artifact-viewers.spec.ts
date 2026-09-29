import { describe, expect, it } from "vitest";

import {
  ARTIFACT_TEXT_LIMIT,
  MAX_CODE_LINES,
  MAX_DIFF_CHARS,
  MAX_DIFF_LINES,
  artifactViewerProblems,
  artifactViewerSemantic,
  artifactViewerText,
  codeLanguage,
  codeLineRange,
  codeLines,
  diffCounts,
  hunkHeader,
  numberedHunkLines,
  readArtifactViewer,
  type DiffHunk,
} from "../src/index.ts";

/**
 * The rules the node and the page share for code, diff and file cards: what a card may hold, what is refused and why,
 * and the counts and text worked out from the props rather than taken from the model.
 */

const hunk = (oldStart: number, newStart: number, lines: DiffHunk["lines"]): DiffHunk => ({ oldStart, newStart, lines });

describe("code", () => {
  it("counts lines the way an editor shows them", () => {
    expect(codeLines("a\nb\n")).toEqual(["a", "b"]);
    expect(codeLines("a\r\nb")).toEqual(["a", "b"]);
    expect(codeLines("\n")).toEqual([""]);
    expect(codeLineRange({ code: "a\nb\nc", startLine: 10 })).toEqual({ first: 10, last: 12, count: 3 });
  });

  it("takes the language from the path's extension only when none is named", () => {
    expect(codeLanguage({ path: "src/app.TSX" })).toBe("tsx");
    expect(codeLanguage({ path: "src/app.ts", language: "python" })).toBe("python");
    expect(codeLanguage({ path: "Makefile" })).toBeUndefined();
    expect(codeLanguage({ path: ".env" })).toBeUndefined();
    expect(codeLanguage({})).toBeUndefined();
  });

  it("refuses more lines than a card shows, and asks for truncated instead", () => {
    const code = Array.from({ length: MAX_CODE_LINES + 1 }, () => "x").join("\n");
    expect(artifactViewerProblems("code", { code })).toEqual([
      `the code has ${String(MAX_CODE_LINES + 1)} lines; a card shows at most ${String(MAX_CODE_LINES)}: cut it and set truncated`,
    ]);
    expect(readArtifactViewer("code", { code })).toBeUndefined();
    expect(readArtifactViewer("code", { code: "x", truncated: true })?.kind).toBe("code");
  });

  it("refuses markup where a name goes, and a key the card does not have", () => {
    expect(artifactViewerProblems("code", { code: "x", language: "<b>" })).toEqual(["the props do not describe a code card"]);
    expect(artifactViewerProblems("code", { code: "x", html: "<b>x</b>" })).toEqual(["the props do not describe a code card"]);
    expect(artifactViewerProblems("code", { code: "" })).toEqual(["the props do not describe a code card"]);
  });
});

describe("diff", () => {
  it("numbers each line in the old and the new file", () => {
    const lines = numberedHunkLines(
      hunk(10, 20, [
        { kind: "context", text: "a" },
        { kind: "remove", text: "b" },
        { kind: "add", text: "c" },
        { kind: "add", text: "d" },
        { kind: "context", text: "e" },
      ]),
    );
    expect(lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["context", 10, 20],
      ["remove", 11, undefined],
      ["add", undefined, 21],
      ["add", undefined, 22],
      ["context", 12, 23],
    ]);
  });

  it("writes each hunk's header from its lines", () => {
    expect(hunkHeader({ ...hunk(0, 1, [{ kind: "add", text: "a" }]), section: "fn main()" })).toBe("@@ -0,0 +1,1 @@ fn main()");
    expect(
      hunkHeader(
        hunk(5, 5, [
          { kind: "context", text: "a" },
          { kind: "remove", text: "b" },
        ]),
      ),
    ).toBe("@@ -5,2 +5,1 @@");
  });

  it("counts what was added and removed itself", () => {
    const card = {
      files: [
        { path: "a", hunks: [hunk(1, 1, [{ kind: "add", text: "x" }, { kind: "remove", text: "y" }, { kind: "remove", text: "z" }])] },
        { path: "b", hunks: [hunk(0, 1, [{ kind: "add", text: "x" }])] },
      ],
    } as const;
    const content = readArtifactViewer("diff", card);
    if (content?.kind !== "diff") throw new Error("refused");
    expect(diffCounts(content.card)).toEqual({ files: 2, additions: 2, deletions: 2 });
  });

  it("allows a new file, a deleted file and a rename", () => {
    expect(
      artifactViewerProblems("diff", {
        files: [
          { path: "new", hunks: [hunk(0, 1, [{ kind: "add", text: "a" }])] },
          { path: "gone", hunks: [hunk(1, 0, [{ kind: "remove", text: "a" }])] },
          { path: "b", oldPath: "a", hunks: [hunk(3, 3, [{ kind: "remove", text: "x" }, { kind: "add", text: "y" }])] },
        ],
      }),
    ).toEqual([]);
  });

  it("refuses more lines or characters than a card shows", () => {
    const many = Array.from({ length: 3 }, (_, index) =>
      hunk(index * 1000 + 1, index * 1000 + 1, Array.from({ length: 201 }, () => ({ kind: "add" as const, text: "x" }))),
    );
    expect(artifactViewerProblems("diff", { files: [{ path: "a", hunks: many }] })).toEqual([
      `the diff has 603 lines; a card shows at most ${String(MAX_DIFF_LINES)}: cut it and set truncated`,
    ]);
    const wide = Array.from({ length: 41 }, (_, index) => ({
      path: `f${String(index)}`,
      hunks: [hunk(1, 1, [{ kind: "add", text: "x".repeat(1000) }])],
    }));
    expect(artifactViewerProblems("diff", { files: wide.slice(0, 20) })).toEqual([]);
    expect(artifactViewerProblems("diff", { files: wide.slice(0, 20).map((file) => ({ ...file, hunks: [hunk(1, 1, Array.from({ length: 3 }, () => ({ kind: "add" as const, text: "x".repeat(1000) })))] })) })).toEqual([
      `the diff holds 60000 characters; a card shows at most ${String(MAX_DIFF_CHARS)}: cut it and set truncated`,
    ]);
  });
});

describe("file", () => {
  it("names a file with no link, and refuses one that tries to be a link", () => {
    expect(artifactViewerProblems("file", { name: "a.pdf", path: "Documents/a.pdf" })).toEqual([]);
    expect(artifactViewerProblems("file", { name: "a.pdf", path: "file:///etc/passwd" })).toEqual([
      "a file card names a file and does not link one; a path that is a URL is refused",
    ]);
    expect(artifactViewerProblems("file", { name: "a.pdf", href: "https://x" })).toEqual(["the props do not describe a file card"]);
    expect(artifactViewerProblems("file", { name: "a.pdf", mediaType: "text/html; charset=utf-8" })).toEqual([
      "the props do not describe a file card",
    ]);
  });
});

describe("text and meaning", () => {
  it("keeps the text alternative within its limit and says what was left out", () => {
    const content = readArtifactViewer("code", { code: "y".repeat(10_000) });
    if (content === undefined) throw new Error("refused");
    const text = artifactViewerText(content);
    expect(text.length).toBe(ARTIFACT_TEXT_LIMIT);
    expect(text).toMatch(/\n… \d+ more characters are on the card$/u);
    expect(artifactViewerText(content, 200).length).toBe(200);
  });

  it("never puts a code body in the semantic document", () => {
    const content = readArtifactViewer("code", { code: "const token = 'abc';", language: "js" });
    if (content === undefined) throw new Error("refused");
    expect(JSON.stringify(artifactViewerSemantic(content))).not.toContain("abc");
  });
});
