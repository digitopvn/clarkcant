import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, type MessageBlock, SEMANTIC_LIMITS, canonicalSemanticDoc } from "@clarkcant/contracts";
import { getInstance } from "@clarkcant/core";
import { CODE, DIFF, FILE } from "@clarkcant/data-canvas";

import { layoutLeafWidgets } from "../src/compose-layout.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import { buildWidgetSemantic } from "../src/widget-semantic.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/**
 * Code, diff and file cards, placed the way a model's `show_view` places them.
 *
 * What matters is what the node refuses and what it keeps: props that do not fit are refused before an instance exists,
 * the text a reader gets without the renderer is the card's own content, and what voice and `inspect_ui` read names the
 * file, its language and its line counts without the body, and never claims to be live.
 */

const AT = "2026-09-30T05:00:00.000Z" as Instant;
/** Written by code point, so no hidden character sits in this file's own source. */
const BIDI = String.fromCodePoint(0x202e);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);

let dir: string;
let services: NodeServices;
let counter = 0;

function views() {
  return buildViewCatalog(services.conductor);
}

async function place(definitionId: string, props: Record<string, unknown>, caption = "") {
  const view = views().find((entry) => entry.id === definitionId);
  if (view === undefined) throw new Error(`${definitionId} is not in the catalog`);
  return (await view.build({
    props,
    caption,
    at: AT,
    principal: { principalId: services.runtime.identity.ownerPrincipalId, kind: "user", nodeId: services.runtime.identity.nodeId } as never,
    messageId: `msg_${String(++counter)}`,
    conversationId: "conv_artifact_viewers",
  })) as Extract<MessageBlock, { type: "surface" }>;
}

function instanceRows(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number }).n;
}

function semanticOf(block: Extract<MessageBlock, { type: "surface" }>) {
  const doc = buildWidgetSemantic(services.conductor, block.snapshot.instanceId ?? "");
  if (doc === undefined) throw new Error("no document");
  return doc;
}

const DIFF_PROPS = {
  title: "Fix rounding",
  files: [
    {
      path: "src/money.ts",
      hunks: [
        {
          oldStart: 40,
          newStart: 40,
          lines: [
            { kind: "context", text: "export function money(n: number) {" },
            { kind: "remove", text: "  return n.toFixed(2);" },
            { kind: "add", text: "  return format(n);" },
            { kind: "add", text: "  // rounded" },
            { kind: "context", text: "}" },
          ],
        },
      ],
    },
    { path: "src/new.ts", hunks: [{ oldStart: 0, newStart: 1, lines: [{ kind: "add", text: "export {};" }] }] },
  ],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-artifact-viewers-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
});

afterEach(async () => {
  services.runtime.db.close();
  await removeTestDirectory(dir);
});

describe("the model's vocabulary", () => {
  it("offers the three cards, each saying its limits and that it fetches and opens nothing", () => {
    const byId = new Map(views().map((view) => [view.id, view]));
    for (const definition of [CODE, DIFF, FILE]) {
      const view = byId.get(definition.id);
      expect(view?.notes).toBeTruthy();
      expect(view?.shownText).toContain("opens and fetches nothing");
    }
    expect(byId.get(CODE.id)?.notes).toContain("at most 400 lines");
    expect(byId.get(DIFF.id)?.notes).toContain("The card counts additions and removals itself");
    expect(byId.get(FILE.id)?.notes).toContain("never a URL");
  });

  it("keeps them out of layouts: no region reads what they show", () => {
    const leaves = layoutLeafWidgets(services.compose.registry);
    for (const definition of [CODE, DIFF, FILE]) expect(leaves).not.toContain(definition.id);
  });
});

describe("placing a card", () => {
  it("keeps the code itself as the text alternative, over a caption", async () => {
    const block = await place(CODE.id, { path: "src/a.py", startLine: 7, code: "x = 1\ny = 2\n" }, "Here is the code");
    expect(block.snapshot.textAlternative).toBe("src/a.py (py, lines 7-8)\nx = 1\ny = 2\n");
    expect(block.snapshot.presentationRef).toBe(`catalog:${CODE.id}`);
    expect(getInstance(services.conductor, block.snapshot.instanceId ?? "")?.props).toMatchObject({ path: "src/a.py", startLine: 7 });
  });

  it("writes a diff's text with headers and counts worked out from its lines", async () => {
    const block = await place(DIFF.id, DIFF_PROPS);
    expect(block.snapshot.textAlternative).toBe(
      [
        "Fix rounding: 2 file(s) changed, +3 -1",
        "src/money.ts +2 -1",
        "@@ -40,3 +40,4 @@",
        " export function money(n: number) {",
        "-  return n.toFixed(2);",
        "+  return format(n);",
        "+  // rounded",
        " }",
        "src/new.ts +1 -0",
        "@@ -0,0 +1,1 @@",
        "+export {};",
      ].join("\n"),
    );
  });

  it("places code holding a bidi control, keeping it in the props and writing it as a marker in the text", async () => {
    const code = `const role = "user${BIDI} // admin";${LINE_SEPARATOR}grant();`;
    const block = await place(CODE.id, { path: "src/role.ts", code });
    expect(getInstance(services.conductor, block.snapshot.instanceId ?? "")?.props).toMatchObject({ code });
    expect(block.snapshot.textAlternative).toBe(
      [
        "src/role.ts (ts, lines 1-2)",
        "Holds 1 hidden character(s), each written here as ⟨U+…⟩ rather than applied.",
        'const role = "user⟨U+202E⟩ // admin";',
        "grant();",
      ].join("\n"),
    );
    const doc = semanticOf(block);
    expect(doc.summary).toContain("holds 1 hidden character(s), shown as markers");
    expect(doc.values).toMatchObject({ lineCount: 2, hiddenCharacters: 1 });
    expect(canonicalSemanticDoc(doc)).not.toContain(BIDI);
  });

  it("names a file in words", async () => {
    const block = await place(FILE.id, { name: "report.pdf", mediaType: "application/pdf", sizeBytes: 2048, source: "Clark" });
    expect(block.snapshot.textAlternative).toBe("report.pdf (application/pdf, 2048 bytes), from Clark");
  });

  it("keeps the text alternative within what a snapshot holds, saying how much it left out", async () => {
    const code = Array.from({ length: 400 }, (_, index) => `line ${String(index)} ${"x".repeat(40)}`).join("\n");
    const block = await place(CODE.id, { code, truncated: true });
    expect(block.snapshot.textAlternative.length).toBeLessThanOrEqual(4000);
    expect(block.snapshot.textAlternative).toMatch(/more characters are on the card$/u);
    expect(block.snapshot.textAlternative.startsWith("Code (text, lines 1-400, cut short)\nline 0 ")).toBe(true);
  });

  it.each([
    ["code over the line limit", CODE.id, { code: Array.from({ length: 401 }, () => "x").join("\n") }, "the code has 401 lines"],
    [
      "code over the character limit",
      CODE.id,
      { code: "x".repeat(20_001) },
      "the code is 20001 characters; a card shows at most 20000: cut it and set truncated",
    ],
    ["a language that is markup", CODE.id, { code: "x", language: "<script>" }, "language"],
    ["a path with a line break", CODE.id, { code: "x", path: "a\nb" }, 'property "path": contains U+000A, a line break'],
    ["a path with a bidi control", CODE.id, { code: "x", path: `src/${BIDI}a.ts` }, 'property "path": contains U+202E'],
    ["a title with an invisible character", CODE.id, { code: "x", title: `a${String.fromCodePoint(0x200b)}` }, 'property "title": contains U+200B'],
    [
      "a hunk section with a line separator",
      DIFF.id,
      { files: [{ path: "a", hunks: [{ oldStart: 1, newStart: 1, section: `fn${LINE_SEPARATOR}x`, lines: [{ kind: "add", text: "b" }] }] }] },
      'property "files.0.hunks.0.section": contains U+2028',
    ],
    [
      "a diff line holding a line separator",
      DIFF.id,
      { files: [{ path: "a", hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "add", text: `b${LINE_SEPARATOR}c` }] }] }] },
      "contains U+2028, a line break; give each line of the diff as a line of its own",
    ],
    [
      "a diff line over its limit",
      DIFF.id,
      { files: [{ path: "a", hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "add", text: "y".repeat(1001) }] }] }] },
      "line 1 of hunk 1 of a is 1001 characters; a card shows at most 1000 a line: cut it and set truncated",
    ],
    [
      "hunks whose numbers do not follow from each other",
      DIFF.id,
      {
        files: [
          {
            path: "a",
            hunks: [
              { oldStart: 1, newStart: 1, lines: [{ kind: "context", text: "a" }, { kind: "add", text: "b" }] },
              { oldStart: 10, newStart: 10, lines: [{ kind: "context", text: "c" }, { kind: "remove", text: "d" }] },
            ],
          },
        ],
      },
      "hunk 2 of a starts at new line 10, but the hunks above it move old line 10 to new line 11",
    ],
    ["a file whose source has a bidi control", FILE.id, { name: "a.pdf", source: `Lan${BIDI}` }, 'property "source": contains U+202E'],
    ["a file whose path is a mailto link", FILE.id, { name: "a.pdf", path: "mailto:lan@example.com" }, "a path that is a URL is refused"],
    [
      "a hunk at old line 0 that keeps lines",
      DIFF.id,
      { files: [{ path: "a", hunks: [{ oldStart: 0, newStart: 1, lines: [{ kind: "context", text: "a" }, { kind: "add", text: "b" }] }] }] },
      "starts at old line 0, so it can only add lines",
    ],
    [
      "a hunk that changes nothing",
      DIFF.id,
      { files: [{ path: "a", hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "context", text: "a" }] }] }] },
      "changes nothing",
    ],
    [
      "hunks out of order",
      DIFF.id,
      {
        files: [
          {
            path: "a",
            hunks: [
              { oldStart: 10, newStart: 10, lines: [{ kind: "add", text: "b" }] },
              { oldStart: 2, newStart: 2, lines: [{ kind: "remove", text: "c" }] },
            ],
          },
        ],
      },
      "hunks go in file order",
    ],
    [
      "a file given twice",
      DIFF.id,
      {
        files: [
          { path: "a", hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "add", text: "b" }] }] },
          { path: "a", hunks: [{ oldStart: 5, newStart: 6, lines: [{ kind: "add", text: "c" }] }] },
        ],
      },
      "a appears twice",
    ],
    ["a line holding a line break", DIFF.id, { files: [{ path: "a", hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "add", text: "b\nc" }] }] }] }, "line break"],
    ["a file named with its folder", FILE.id, { name: "docs/a.pdf" }, "put the folder in path"],
    ["a file whose path is a URL", FILE.id, { name: "a.pdf", path: "https://example.com/a.pdf" }, "a path that is a URL is refused"],
    ["a file card with a link", FILE.id, { name: "a.pdf", url: "https://example.com/a.pdf" }, 'unknown property "url"'],
  ])("refuses %s and leaves nothing behind", async (_name, definitionId, props, reason) => {
    const before = instanceRows();
    await expect(place(definitionId, props)).rejects.toThrow(reason);
    expect(instanceRows()).toBe(before);
  });
});

describe("what a card means", () => {
  it("names the file, the language and the line count of code, without the body", async () => {
    const doc = semanticOf(await place(CODE.id, { path: "src/app.tsx", startLine: 3, code: "const secretish = 1;\nexport {};" }));
    expect(doc).toMatchObject({
      definitionId: CODE.id,
      summary: "Code as stated when shown: src/app.tsx (tsx), 2 line(s), lines 3-4",
      values: { path: "src/app.tsx", language: "tsx", lineCount: 2, firstLine: 3, lastLine: 4, truncated: false },
      freshness: "unknown",
      source: "host",
      availableActions: [],
    });
    expect(canonicalSemanticDoc(doc)).not.toContain("secretish");
  });

  it("gives a diff's files and the lines added and removed", async () => {
    const doc = semanticOf(await place(DIFF.id, { ...DIFF_PROPS, truncated: true }));
    expect(doc).toMatchObject({
      title: "Fix rounding",
      summary: "Diff as stated when shown: 2 file(s), 3 line(s) added, 1 removed; part of the change is left out",
      values: { fileCount: 2, linesAdded: 3, linesRemoved: 1, files: ["src/money.ts +2 -1", "src/new.ts +1 -0"], truncated: true },
      freshness: "unknown",
    });
  });

  it("gives a file's name, type and size", async () => {
    const doc = semanticOf(await place(FILE.id, { name: "a.csv", mediaType: "text/csv", sizeBytes: 12 }));
    expect(doc).toMatchObject({
      summary: "File as stated when shown: a.csv (text/csv)",
      values: { name: "a.csv", mediaType: "text/csv", sizeBytes: 12 },
      freshness: "unknown",
    });
  });

  it("stays bounded at the largest diff the schema allows", async () => {
    const files = Array.from({ length: 20 }, (_, index) => ({
      path: `${"d".repeat(280)}/${String(index)}.ts`,
      hunks: [{ oldStart: 1, newStart: 1, lines: Array.from({ length: 30 }, () => ({ kind: "add", text: "y".repeat(60) })) }],
    }));
    const doc = semanticOf(await place(DIFF.id, { title: "t".repeat(200), files }));
    expect(canonicalSemanticDoc(doc).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.bytes);
  });
});
