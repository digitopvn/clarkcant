import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DIFF_LINE_KINDS } from "@clarkcant/contracts";
import { CODE, DIFF, FILE } from "@clarkcant/data-canvas";
import { describe, expect, it } from "vitest";

import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { RENDERER_IDS } from "../src/renderers.tsx";

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
    expect(functionBody("renderers.tsx", "CodeViewerView")).toContain('role="status"');
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
    ];
    for (const key of keys) {
      expect(MESSAGES_EN[key], key).toBeTruthy();
      expect(MESSAGES_VI[key], key).toBeTruthy();
      expect(MESSAGES_VI[key], key).not.toBe(MESSAGES_EN[key]);
    }
  });
});
