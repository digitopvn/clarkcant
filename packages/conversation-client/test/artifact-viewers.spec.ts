import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isValidElement, type ReactNode } from "react";

import { DIFF_LINE_KINDS, markHiddenCharacters } from "@clarkcant/contracts";
import { CODE, DIFF, FILE } from "@clarkcant/data-canvas";
import { describe, expect, it } from "vitest";

import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { highlightedCode } from "../src/markdown.tsx";
import { RENDERER_IDS, markHiddenInTree, withHiddenMarkers } from "../src/renderers.tsx";

/** Written by code point, so no hidden character sits in this file's own source. */
const BIDI = String.fromCodePoint(0x202e);
const ZERO_WIDTH = String.fromCodePoint(0x200b);

type Marker = { codePoint: string; title: string; text: string };

/** The text a tree of elements draws, the markers in it, and how many elements it has. */
function walk(node: ReactNode): { text: string; markers: Marker[]; elements: number } {
  if (typeof node === "string" || typeof node === "number") return { text: String(node), markers: [], elements: 0 };
  if (Array.isArray(node)) {
    return node.reduce<{ text: string; markers: Marker[]; elements: number }>(
      (sum, child: ReactNode) => {
        const part = walk(child);
        return { text: sum.text + part.text, markers: [...sum.markers, ...part.markers], elements: sum.elements + part.elements };
      },
      { text: "", markers: [], elements: 0 },
    );
  }
  if (!isValidElement<{ children?: ReactNode; title?: string; "data-hidden-char"?: string }>(node)) return { text: "", markers: [], elements: 0 };
  const inner = walk(node.props.children);
  const codePoint = node.props["data-hidden-char"];
  const own = codePoint === undefined ? [] : [{ codePoint, title: node.props.title ?? "", text: inner.text }];
  return { text: inner.text, markers: [...own, ...inner.markers], elements: inner.elements + 1 };
}

/**
 * The code, diff and file renderers, checked where a Node suite can see them.
 *
 * The repo has no DOM test environment, so what a person sees is asserted in the browser journey. What is asserted here
 * is what a later edit could quietly break: each card has a renderer, nothing on them becomes raw HTML or a link, the
 * scrolls a keyboard needs are focusable and named, and every word a screen reader hears exists in both languages.
 */

const SOURCE = join(import.meta.dirname, "..", "src");

function functionBody(file: string, name: string): string {
  const text = readFileSync(join(SOURCE, file), "utf8");
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is not in ${file}`);
  const rest = text.slice(start);
  const end = rest.search(/\n(?:\/\*|function |export |const [A-Z_]+[:=])/u);
  return end < 0 ? rest : rest.slice(0, end);
}

const RENDERERS = ["CodeViewerView", "DiffViewerView", "FileViewerView"];

describe("artifact viewers", () => {
  it("has a renderer for each card, so none falls back to its text alternative", () => {
    expect(RENDERER_IDS).toEqual(expect.arrayContaining([CODE.id, DIFF.id, FILE.id]));
  });

  it("draws no raw HTML, no link, no download and no freshness badge on any of the three", () => {
    for (const name of RENDERERS) {
      const body = functionBody("renderers.tsx", name);
      expect(body, name).not.toMatch(/dangerouslySetInnerHTML|innerHTML|<a\b|href=|download|window\.open/u);
      expect(body, name).not.toMatch(/dataset=\{dataset\}/u);
    }
    expect(functionBody("renderers.tsx", "FileViewerView")).not.toMatch(/<button/u);
  });

  it("makes each bounded scroll reachable and named for a keyboard and a screen reader", () => {
    for (const name of ["CodeViewerView", "DiffViewerView"]) {
      const body = functionBody("renderers.tsx", name);
      expect(body, name).toContain("tabIndex={0}");
      expect(body, name).toContain('role="region"');
      expect(body, name).toMatch(/aria-label=\{t\("widgets\.(code|diff)\.region"\)/u);
    }
  });

  it("hides signs and numbers from a screen reader and says each line's kind in words instead", () => {
    const body = functionBody("renderers.tsx", "DiffViewerView");
    expect(body).toContain('className="cc-diff-gutter" aria-hidden="true"');
    expect(body).toContain('className="cc-viewer-num" aria-hidden="true"');
    expect(body).toContain("widgets.diff.line.${line.kind}");
  });

  it("says in words when a copy failed, rather than leaving a button that seemed to work", () => {
    const body = functionBody("renderers.tsx", "useCopy");
    expect(body).toContain('settle("failed")');
    // The status is reset when a copy starts and redrawn for every result, so the same words are announced again.
    expect(body).toMatch(/setStatus\(\(previous\) => \(\{ state: "idle", attempt: previous\.attempt \}\)\)/u);
    expect(body).toContain("attempt: previous.attempt + 1");
    const view = functionBody("renderers.tsx", "CodeViewerView");
    // Always rendered, never behind a condition: a live region added with its first message is often not read at all.
    expect(view).toMatch(/\n\s+<p className="cc-freshness cc-viewer-copy-status" role="status" data-copy-state=\{copyState\}>\n\s+<span key=\{attempt\}>/u);
  });

  it("names the copy button after what it copies, in both languages", () => {
    expect(functionBody("renderers.tsx", "CodeViewerView")).toContain('aria-label={t("widgets.code.copyName").replace("{name}", name)}');
    expect(MESSAGES_EN["widgets.code.copyName"]).toBe("Copy code: {name}");
    expect(MESSAGES_VI["widgets.code.copyName"]).toBe("Sao chép mã: {name}");
    // The visible word starts the accessible name, so a person who says "click Copy" reaches it.
    expect(MESSAGES_EN["widgets.code.copyName"].startsWith(MESSAGES_EN["widgets.code.copy"])).toBe(true);
    expect(MESSAGES_VI["widgets.code.copyName"].startsWith(MESSAGES_VI["widgets.code.copy"])).toBe(true);
  });

  it("draws each hidden character in highlighted code as a marker, and leaves every token and every other character as it was", () => {
    const code = `const role = "user${BIDI} // admin${ZERO_WIDTH}";\n\tgrant();`;
    const highlighted = highlightedCode(code, "ts");
    expect(highlighted.nodes).toBeDefined();
    const marked = markHiddenInTree(highlighted.nodes, (hidden) => `title ${hidden.codePoint}`);
    const { text, markers } = walk(marked);
    expect(markers).toEqual([
      { codePoint: "U+202E", title: "title U+202E", text: "⟨U+202E⟩" },
      { codePoint: "U+200B", title: "title U+200B", text: "⟨U+200B⟩" },
    ]);
    expect(text).toBe(markHiddenCharacters(code).text);
    expect(text).not.toContain(BIDI);
    // The tokens the highlighter made are still there around the markers.
    expect(walk(highlighted.nodes).elements).toBe(walk(marked).elements - markers.length);
  });

  it("draws plain code and a diff line the same way, and leaves text with nothing hidden untouched", () => {
    const { text, markers } = walk(withHiddenMarkers(`a${BIDI}b`, (hidden) => hidden.codePoint));
    expect(text).toBe("a⟨U+202E⟩b");
    expect(markers.map((marker) => marker.codePoint)).toEqual(["U+202E"]);
    expect(withHiddenMarkers("a\tb\nc", () => "")).toBe("a\tb\nc");
  });

  it("warns on the card whenever it draws a marker, in the code and in the diff", () => {
    const code = functionBody("renderers.tsx", "CodeViewerView");
    expect(code).toContain('<HiddenWarning count={hiddenCharacterCount(content)} messageKey="widgets.code.hidden" />');
    expect(code).toContain("markHiddenInTree(highlighted.nodes ?? card.code, describe)");
    const diff = functionBody("renderers.tsx", "DiffViewerView");
    expect(diff).toContain('<HiddenWarning count={hiddenCharacterCount(content)} messageKey="widgets.diff.hidden" />');
    expect(diff).toContain("<code>{withHiddenMarkers(line.text, describe)}</code>");
  });

  it("says every line kind, limit and fact in both languages", () => {
    const keys: MessageKey[] = [
      ...DIFF_LINE_KINDS.map((kind) => `widgets.diff.line.${kind}` as MessageKey),
      "widgets.code.copy",
      "widgets.code.copied",
      "widgets.code.copyFailed",
      "widgets.code.truncated",
      "widgets.diff.truncated",
      "widgets.diff.summary",
      "widgets.file.namedOnly",
      "widgets.file.type",
      "widgets.file.size",
      "widgets.file.source",
      "widgets.file.path",
      "widgets.code.copyName",
      "widgets.code.hidden",
      "widgets.diff.hidden",
      "widgets.hiddenChar.bidi",
      "widgets.hiddenChar.invisible",
      "widgets.hiddenChar.control",
    ];
    for (const key of keys) {
      expect(MESSAGES_EN[key], key).toBeTruthy();
      expect(MESSAGES_VI[key], key).toBeTruthy();
      expect(MESSAGES_VI[key], key).not.toBe(MESSAGES_EN[key]);
    }
  });
});
