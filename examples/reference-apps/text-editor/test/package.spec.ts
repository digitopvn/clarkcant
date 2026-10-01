import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runConformance } from "../../../../packages/widget-cli/src/conformance.ts";

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
