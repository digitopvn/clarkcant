import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SECRET_SHAPES, SEMANTIC_LIMITS, cleanSemanticText } from "../../../../packages/contracts/src/index.ts";
import { runConformance } from "../../../../packages/widget-cli/src/conformance.ts";
import { EDITOR_LIMITS, HOST_SECRET_PATTERNS, hostSemanticText } from "../widgets/main/editor-core.js";

/**
 * The editor as a package: it passes the conformance suite `clark widget test` runs, and asks for nothing.
 *
 * Here, in the default test run, so a change to the editor or to the suite that breaks the reference app fails the
 * repository's own checks rather than waiting for someone to run the CLI by hand.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8")) as Record<string, unknown>;
}

describe("the text editor package", () => {
  it("passes the conformance suite", () => {
    const result = runConformance(ROOT);
    expect(result.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is one isolated UI facet with no service and no permissions, on every platform and the web", () => {
    const manifest = json("clarkcant.json");
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.facets).toEqual([
      {
        kind: "ui",
        id: "com.clarkcant.reference.text-editor.main@1",
        entry: "widgets/main/index.html",
        definition: "widgets/main/widget.json",
        isolation: "isolated-ui",
      },
    ]);
    expect(manifest.requestedCapabilities).toEqual([]);
    expect(manifest.permissions).toEqual({ networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] });
    expect(manifest.platforms).toEqual(["darwin-arm64", "linux-x64", "win32-x64", "web"]);
  });

  it("declares a state that holds file refs and a bounded draft, and nothing else", () => {
    const definition = json("widgets/main/widget.json");
    const state = definition.stateSchema as { properties: Record<string, unknown>; additionalProperties: unknown };
    expect(Object.keys(state.properties).sort()).toEqual(["base", "draft", "draftTooLarge", "file"]);
    expect(state.additionalProperties).toBe(false);
    expect(definition.requestedCapabilities).toEqual([]);
    expect(definition.effectCategories).toEqual([]);
  });
});

/*
 * The editor asks Clark only about text the host passes on unchanged, so its copy of the host's cleaning must be the
 * host's. A frame cannot import host code; these fail when the two drift apart.
 */
describe("the editor's copy of what the host does to a selection", () => {
  it("keeps the host's bound for one value", () => {
    expect(EDITOR_LIMITS.excerptChars).toBe(SEMANTIC_LIMITS.string);
  });

  it("redacts the same secret shapes, in the same order", () => {
    expect(HOST_SECRET_PATTERNS.map((pattern) => [pattern.source, pattern.flags])).toEqual(
      SECRET_SHAPES.map((shape) => [shape.pattern.source, shape.pattern.flags]),
    );
  });

  it("cleans text exactly as the host does", () => {
    const samples = [
      "change that",
      "  spaced   out \n text\t",
      "line one\nline two\r\nthree",
      "pay\u200Bment \u202Eevil\uFEFF",
      "use sk-abcdefgh12345678 here, or Bearer abcdefghijklmnop",
      "mail me at someone@example.com or +84 912 345 678",
      "😀".repeat(150),
      "a".repeat(250),
      "C:\\Users\\nguoi\\notes.txt and /home/nguoi/notes.txt",
    ];
    for (const text of samples) {
      expect(hostSemanticText(text, SEMANTIC_LIMITS.string)).toBe(cleanSemanticText(text, SEMANTIC_LIMITS.string));
    }
  });
});
