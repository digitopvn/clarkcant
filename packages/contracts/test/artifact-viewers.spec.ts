import { describe, expect, it } from "vitest";

import {
  ARTIFACT_TEXT_LIMIT,
  MAX_CODE_CHARS,
  MAX_CODE_LINES,
  MAX_DIFF_CHARS,
  MAX_DIFF_FILES,
  MAX_DIFF_HUNKS,
  MAX_DIFF_LINE_CHARS,
  MAX_DIFF_LINES,
  artifactViewerProblems,
  artifactViewerSemantic,
  artifactViewerText,
  codeLanguage,
  codeLineRange,
  codeLines,
  diffCounts,
  hiddenCharacterCount,
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
/** A character by its code point, so no hidden character sits in this file's own source. */
const ch = (codePoint: number): string => String.fromCodePoint(codePoint);

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

  it("refuses markup where a name goes, and a key the card does not have, saying where", () => {
    expect(artifactViewerProblems("code", { code: "x", language: "<b>" })).toEqual([
      expect.stringMatching(/^"language": /u),
    ]);
    expect(artifactViewerProblems("code", { code: "x", html: "<b>x</b>" })).toEqual(['props: Unrecognized key: "html"']);
    expect(artifactViewerProblems("code", { code: "" })).toEqual([expect.stringMatching(/^"code": /u)]);
  });

  it("says by how much code is over its limit, once, and asks for truncated", () => {
    expect(artifactViewerProblems("code", { code: "x".repeat(MAX_CODE_CHARS + 1) })).toEqual([
      `the code is ${String(MAX_CODE_CHARS + 1)} characters; a card shows at most ${String(MAX_CODE_CHARS)}: cut it and set truncated`,
    ]);
  });

  it("counts every kind of line break as one line, so the numbers stay beside their lines", () => {
    const code = ["a", "b", "c", "d", "e", "f"].join("\r\n").replace("c\r\nd", `c${ch(0x2028)}d`).replace("e\r\nf", `e${ch(0x85)}f`);
    const content = readArtifactViewer("code", { code: `${code}\rg${ch(0x2029)}h` });
    if (content?.kind !== "code") throw new Error("refused");
    expect(content.card.code).toBe("a\nb\nc\nd\ne\nf\ng\nh");
    expect(codeLineRange(content.card)).toEqual({ first: 1, last: 8, count: 8 });
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
    expect(artifactViewerProblems("diff", { files: wide })).toEqual([
      `the diff has 41 files; a card shows at most ${String(MAX_DIFF_FILES)}: leave some out and set truncated`,
      `the diff holds 41000 characters; a card shows at most ${String(MAX_DIFF_CHARS)}: cut it and set truncated`,
    ]);
    expect(
      artifactViewerProblems("diff", { files: [{ path: "src/a.ts", hunks: [hunk(1, 1, [{ kind: "add", text: "y".repeat(1001) }])] }] }),
    ).toEqual([
      `line 1 of hunk 1 of src/a.ts is 1001 characters; a card shows at most ${String(MAX_DIFF_LINE_CHARS)} a line: cut it and set truncated`,
    ]);
    const hunks = Array.from({ length: MAX_DIFF_HUNKS + 1 }, (_, index) => hunk(index * 10 + 1, index * 10 + 1, [{ kind: "add", text: "x" }]));
    expect(artifactViewerProblems("diff", { files: [{ path: "src/a.ts", hunks }] })).toEqual([
      `src/a.ts has ${String(MAX_DIFF_HUNKS + 1)} hunks; a card shows at most ${String(MAX_DIFF_HUNKS)} a file: leave some out and set truncated`,
    ]);
  });

  it("names a file whose path is not safe to repeat by its place instead", () => {
    const path = `a${ch(0x202e)}b`;
    const problems = artifactViewerProblems("diff", { files: [{ path, hunks: [hunk(1, 1, [{ kind: "add", text: "y".repeat(1001) }])] }] });
    expect(problems[0]).toMatch(/^line 1 of hunk 1 of file 1 is 1001 characters/u);
    expect(problems.join("\n")).not.toContain(ch(0x202e));
  });

  it("holds hunks of one file to the same numbering, unless part of the change is left out", () => {
    const first = hunk(10, 10, [
      { kind: "context", text: "a" },
      { kind: "add", text: "b" },
      { kind: "add", text: "c" },
    ]);
    // Two lines added above: old line 30 is now new line 32.
    const follows = hunk(30, 32, [
      { kind: "context", text: "d" },
      { kind: "remove", text: "e" },
      { kind: "add", text: "f" },
    ]);
    expect(artifactViewerProblems("diff", { files: [{ path: "a", hunks: [first, follows] }] })).toEqual([]);
    const drifted = { ...follows, newStart: 31 };
    expect(artifactViewerProblems("diff", { files: [{ path: "a", hunks: [first, drifted] }] })).toEqual([
      "hunk 2 of a starts at new line 31, but the hunks above it move old line 30 to new line 32; fix the numbers, or set truncated if part of the change between them is left out",
    ]);
    expect(artifactViewerProblems("diff", { files: [{ path: "a", hunks: [first, drifted] }], truncated: true })).toEqual([]);
    // A hunk that only adds is numbered from the line before it in unified diffs, so it is not held to the rule.
    const onlyAdds = hunk(30, 31, [{ kind: "add", text: "g" }]);
    expect(artifactViewerProblems("diff", { files: [{ path: "a", hunks: [first, onlyAdds] }] })).toEqual([]);
  });

  it("refuses a line break of any kind inside a diff line, naming it", () => {
    for (const [codePoint, label] of [
      [0x0a, "U+000A"],
      [0x0d, "U+000D"],
      [0x85, "U+0085"],
      [0x2028, "U+2028"],
      [0x2029, "U+2029"],
    ] as const) {
      const props = { files: [{ path: "a", hunks: [hunk(1, 1, [{ kind: "add", text: `b${ch(codePoint)}c` }])] }] };
      expect(artifactViewerProblems("diff", props), label).toEqual([
        `"files.0.hunks.0.lines.0.text": contains ${label}, a line break; give each line of the diff as a line of its own`,
      ]);
    }
  });
});

describe("hidden characters", () => {
  const BIDI = ch(0x202e);

  it.each([
    ["code", "title", { code: "x", title: `a${BIDI}b` }, '"title"'],
    ["code", "path", { code: "x", path: `src/${BIDI}a.ts` }, '"path"'],
    ["diff", "title", { title: `a${ch(0x200b)}b`, files: [{ path: "a", hunks: [hunk(1, 1, [{ kind: "add", text: "x" }])] }] }, '"title"'],
    ["diff", "path", { files: [{ path: `a${ch(0x2066)}`, hunks: [hunk(1, 1, [{ kind: "add", text: "x" }])] }] }, '"files.0.path"'],
    ["diff", "oldPath", { files: [{ path: "a", oldPath: `b${ch(0x200e)}`, hunks: [hunk(1, 1, [{ kind: "add", text: "x" }])] }] }, '"files.0.oldPath"'],
    [
      "diff",
      "section",
      { files: [{ path: "a", hunks: [{ ...hunk(1, 1, [{ kind: "add", text: "x" }]), section: `fn${ch(0x2028)}x` }] }] },
      '"files.0.hunks.0.section"',
    ],
    ["file", "name", { name: `report${ch(0xfeff)}.pdf` }, '"name"'],
    ["file", "source", { name: "a.pdf", source: `Lan${BIDI}` }, '"source"'],
    ["file", "path", { name: "a.pdf", path: `docs${ch(0x2029)}a.pdf` }, '"path"'],
    ["file", "title", { name: "a.pdf", title: `a${ch(0x07)}` }, '"title"'],
    ["file", "summary", { name: "a.pdf", summary: `line one\nline ${BIDI}two` }, '"summary"'],
  ] as const)("refuses one in a %s card's %s, naming the character", (kind, _field, props, where) => {
    const [problem] = artifactViewerProblems(kind, props);
    expect(problem?.startsWith(`${where}: contains U+`)).toBe(true);
    expect(problem).toMatch(/; remove it$|a line break/u);
  });

  it("leaves ZWJ and ZWNJ alone, and a line break in a file's summary", () => {
    expect(artifactViewerProblems("file", { name: `gia-dinh-${ch(0x1f468)}${ch(0x200d)}${ch(0x1f469)}.png`, summary: "one\ntwo" })).toEqual([]);
    expect(artifactViewerProblems("code", { code: "x", title: `می${ch(0x200c)}خواهم` })).toEqual([]);
  });

  it("shows code and diff lines with hidden characters, drawn and written as markers rather than applied", () => {
    const code = readArtifactViewer("code", { path: "a.ts", code: `const role = "user${BIDI} // admin${ch(0x200b)}";\n\tok();` });
    if (code === undefined) throw new Error("refused");
    expect(hiddenCharacterCount(code)).toBe(2);
    const text = artifactViewerText(code);
    expect(text).toContain("Holds 2 hidden character(s)");
    expect(text).toContain('const role = "user⟨U+202E⟩ // admin⟨U+200B⟩";\n\tok();');
    expect(text).not.toContain(BIDI);
    expect(artifactViewerSemantic(code)).toMatchObject({ values: { hiddenCharacters: 2 } });

    const diff = readArtifactViewer("diff", { files: [{ path: "a", hunks: [hunk(1, 1, [{ kind: "add", text: `x${BIDI}y` }])] }] });
    if (diff === undefined) throw new Error("refused");
    expect(hiddenCharacterCount(diff)).toBe(1);
    expect(artifactViewerText(diff)).toContain("+x⟨U+202E⟩y");
    expect(artifactViewerText(diff)).not.toContain(BIDI);
  });

  it("marks a tag character in code as one character, and the other classes a line of code may hide", () => {
    // A tag character is two UTF-16 units; each of these would be invisible in a code block if it were not marked.
    const hidden = [0xe0061, 0x3164, 0x115f, 0xffa0, 0x2060, 0x2064, 0x00ad, 0x180e, 0xfffb].map(ch).join("");
    const code = readArtifactViewer("code", { code: `a${hidden}b` });
    if (code === undefined) throw new Error("refused");
    expect(hiddenCharacterCount(code)).toBe(9);
    const text = artifactViewerText(code);
    expect(text).toContain("a⟨U+E0061⟩⟨U+3164⟩⟨U+115F⟩⟨U+FFA0⟩⟨U+2060⟩⟨U+2064⟩⟨U+00AD⟩⟨U+180E⟩⟨U+FFFB⟩b");
    expect(text).not.toMatch(/[\ud800-\udfff]/u);
  });

  it("says nothing about hidden characters when there are none", () => {
    const code = readArtifactViewer("code", { code: "x\ty" });
    if (code === undefined) throw new Error("refused");
    expect(hiddenCharacterCount(code)).toBe(0);
    expect(artifactViewerText(code)).not.toContain("hidden");
    expect(artifactViewerSemantic(code).values).not.toHaveProperty("hiddenCharacters");
  });
});

describe("file", () => {
  it("names a file with no link, and refuses one that tries to be a link", () => {
    expect(artifactViewerProblems("file", { name: "a.pdf", path: "Documents/a.pdf" })).toEqual([]);
    expect(artifactViewerProblems("file", { name: "a.pdf", path: "file:///etc/passwd" })).toEqual([
      "a file card names a file and does not link one; a path that is a URL is refused",
    ]);
    expect(artifactViewerProblems("file", { name: "a.pdf", href: "https://x" })).toEqual(['props: Unrecognized key: "href"']);
    expect(artifactViewerProblems("file", { name: "a.pdf", mediaType: "text/html; charset=utf-8" })).toEqual([
      '"mediaType": is not in the form type/subtype with no parameters, such as "application/pdf"',
    ]);
  });

  it("names a hidden character in a media type or a language rather than a pattern that failed", () => {
    expect(artifactViewerProblems("file", { name: "a.pdf", mediaType: `application/pdf${ch(0x202e)}` })).toEqual([
      expect.stringMatching(/^"mediaType": contains U\+202E/u),
    ]);
    expect(artifactViewerProblems("code", { code: "x", language: `ts${ch(0x200b)}` })).toEqual([
      expect.stringMatching(/^"language": contains U\+200B/u),
    ]);
  });

  it("refuses any URL scheme as a path, and keeps a Windows drive as the path it is", () => {
    for (const path of ["mailto:lan@example.com", "javascript:alert(1)", "data:text/html,x", "HTTPS://example.com/a.pdf", "vscode:open"]) {
      expect(artifactViewerProblems("file", { name: "a.pdf", path }), path).toEqual([
        "a file card names a file and does not link one; a path that is a URL is refused",
      ]);
    }
    for (const path of ["C:\\Users\\Lan\\a.pdf", "d:/work/a.pdf", "E:", "reports/q3:final.pdf"]) {
      expect(artifactViewerProblems("file", { name: "a.pdf", path }), path).toEqual([]);
    }
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

  it("never cuts the text alternative inside a surrogate pair", () => {
    // Every cut point from here lands either between two emoji or in the middle of one.
    for (const limit of [200, 201, 202, 203]) {
      const content = readArtifactViewer("code", { code: ch(0x1f600).repeat(3000) });
      if (content === undefined) throw new Error("refused");
      const text = artifactViewerText(content, limit);
      expect(text.length).toBeLessThanOrEqual(limit);
      expect(() => encodeURIComponent(text), String(limit)).not.toThrow();
      expect(text).toMatch(/\n… \d+ more characters are on the card$/u);
    }
  });

  it("never puts a code body in the semantic document", () => {
    const content = readArtifactViewer("code", { code: "const token = 'abc';", language: "js" });
    if (content === undefined) throw new Error("refused");
    expect(JSON.stringify(artifactViewerSemantic(content))).not.toContain("abc");
  });
});
