import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.ts";
import { runConformance } from "../src/conformance.ts";

/**
 * `clark widget init --template pure-ui` starts a person from the reference text editor: a working app with one
 * isolated UI facet and no service. These tests prove the copy is a package of its own (its own id, facet id and
 * name), carries the app rather than a stub, and passes the same conformance suite before anything is edited.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function quietly(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  try {
    return { code: await runCli(args), out: out.join(""), err: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

function scaffold(): string {
  const parent = mkdtempSync(join(tmpdir(), "clark-pure-ui-"));
  roots.push(parent);
  return join(parent, "my-editor");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("the pure-ui template", () => {
  it("copies the reference editor under the new package's own identity", async () => {
    const root = scaffold();
    const { code, out } = await quietly(["widget", "init", root, "--template", "pure-ui"]);

    expect(code).toBe(0);
    expect(out).toContain("created a pure-ui widget package");
    const manifest = readJson(join(root, "clarkcant.json"));
    expect(manifest.id).toBe("com.example.my-editor");
    expect(manifest.displayName).toBe("My Widget");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.facets).toEqual([
      {
        kind: "ui",
        id: "com.example.my-editor.main@1",
        entry: "widgets/main/index.html",
        definition: "widgets/main/widget.json",
        isolation: "isolated-ui",
      },
    ]);
    expect(manifest.permissions).toEqual({ networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] });
    expect(readJson(join(root, "widgets", "main", "widget.json")).id).toBe("com.example.my-editor.main@1");
    // Nothing of the reference app's identity survives in the copy's own descriptors.
    expect(readFileSync(join(root, "clarkcant.json"), "utf8")).not.toContain("com.clarkcant.reference");
    expect(readFileSync(join(root, "widgets", "main", "widget.json"), "utf8")).not.toContain("com.clarkcant.reference");
  });

  it("carries the working app, not a stub, and leaves the reference app's own tests behind", async () => {
    const root = scaffold();
    await quietly(["widget", "init", root, "--template", "pure-ui"]);

    for (const file of ["index.html", "main.js", "main.css", "editor-core.js"]) {
      expect(existsSync(join(root, "widgets", "main", file)), file).toBe(true);
    }
    const frame = readFileSync(join(root, "widgets", "main", "main.js"), "utf8");
    expect(frame).toContain("api.artifacts.pick");
    expect(frame).toContain("api.artifacts.export");
    expect(frame).toContain("api.actions.invoke");
    for (const fixture of ["default", "empty", "error", "compact"]) {
      expect(existsSync(join(root, "fixtures", `${fixture}.json`)), fixture).toBe(true);
    }
    expect(existsSync(join(root, "test", "editor-core.spec.ts"))).toBe(false);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("# My Widget");
  });

  it("passes the conformance suite as it is scaffolded", async () => {
    const root = scaffold();
    await quietly(["widget", "init", root, "--template", "pure-ui"]);

    const result = runConformance(root);
    expect(result.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names the templates it accepts when given one it does not", async () => {
    const root = scaffold();
    const { code, err } = await quietly(["widget", "init", root, "--template", "pure"]);

    expect(code).toBe(2);
    expect(err).toContain("pure-ui");
    expect(existsSync(join(root, "clarkcant.json"))).toBe(false);
  });
});
