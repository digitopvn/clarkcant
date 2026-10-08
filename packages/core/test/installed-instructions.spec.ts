import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKAGE_INSTRUCTION_LIMITS } from "@clarkcant/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installedInstructions } from "../src/installed-instructions.ts";

/**
 * Reading the conditional instructions an installed package declares.
 *
 * The host takes rules in the project-instructions contract from a file inside the package, and each snippet only from
 * the `instructions/` folder beside that file, by a plain name. Anything else is named as a problem, and the package's
 * other facets still load.
 */

let base: string;
let root: string;

function manifest(facets: readonly Record<string, unknown>[], schemaVersion = 3): Record<string, unknown> {
  return {
    schemaVersion,
    id: "com.example.rules",
    version: "2.1.0",
    displayName: "Example rules",
    description: "Rules a package declares.",
    hostApi: { min: 1, max: 1 },
    facets,
    requestedCapabilities: [],
    permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
    platforms: ["web"],
  };
}

const facet = (id: string, entry: string): Record<string, unknown> => ({ kind: "instructions", id, entry, isolation: "declarative" });

function write(relative: string, value: unknown): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

const read = () => installedInstructions({ source: { kind: "local", path: root } });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cc-installed-instructions-"));
  root = join(base, "package");
  mkdirSync(root, { recursive: true });
  // A file outside the package that a rule must not reach.
  writeFileSync(join(base, "outside.md"), "ngoài gói");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("installedInstructions", () => {
  it("reads a facet's rules and the snippets beside them, under the package's own id and version", () => {
    write("clarkcant.json", manifest([facet("rules", "rules/instructions.json")]));
    write("rules/instructions.json", { version: 1, rules: [{ when: { path: "src/**" }, include: ["style", "absent"] }] });
    write("rules/instructions/style.md", "  Viết test trước.  \n");
    const outcome = read();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.manifestId).toBe("com.example.rules");
    expect(outcome.version).toBe("2.1.0");
    expect(outcome.problems).toEqual([]);
    expect(outcome.facets).toHaveLength(1);
    expect(outcome.facets[0]?.facetId).toBe("rules");
    expect([...(outcome.facets[0]?.snippets ?? new Map<string, string>())]).toEqual([["style", "Viết test trước."]]);
  });

  it("clips a long snippet to the package slice and says so", () => {
    write("clarkcant.json", manifest([facet("rules", "instructions.json")]));
    write("instructions.json", { version: 1, rules: [{ when: {}, include: ["long"] }] });
    write("instructions/long.md", "x".repeat(PACKAGE_INSTRUCTION_LIMITS.snippetChars + 50));
    const outcome = read();
    if (!outcome.ok) throw new Error(outcome.message);
    const text = outcome.facets[0]?.snippets.get("long") ?? "";
    expect(text.startsWith("x".repeat(PACKAGE_INSTRUCTION_LIMITS.snippetChars))).toBe(true);
    expect(text.endsWith("[…đã cắt bớt]")).toBe(true);
  });

  it("names a broken facet and keeps the others, and reaches no file outside the package", () => {
    write("clarkcant.json", manifest([facet("broken", "broken.json"), facet("missing", "missing.json"), facet("good", "good/instructions.json")]));
    write("broken.json", "{ not json");
    write("good/instructions.json", { version: 1, rules: [{ when: {}, include: ["ok", "outside"] }, { when: {}, include: ["../../outside"] }] });
    write("good/instructions/ok.md", "được");
    const outcome = read();
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.facets.map((entry) => entry.facetId)).toEqual(["good"]);
    expect([...(outcome.facets[0]?.snippets.keys() ?? [])]).toEqual(["ok"]);
    expect(outcome.problems.map((problem) => problem.facetId)).toEqual(["broken", "missing"]);
  });

  it("refuses an instructions facet under schemaVersion 2, and a source this node has no bytes for", () => {
    write("clarkcant.json", manifest([facet("rules", "instructions.json")], 2));
    write("instructions.json", { version: 1, rules: [] });
    const old = read();
    expect(old).toMatchObject({ ok: false, code: "UNREADABLE" });
    if (!old.ok) expect(old.message).toContain('needs "schemaVersion": 3');
    expect(installedInstructions({ source: { kind: "npm", name: "x", version: "1.0.0" } })).toMatchObject({ ok: false, code: "NOT_LOCAL" });
    // A rules file outside the package is refused with the manifest, before anything is read.
    write("clarkcant.json", manifest([facet("escapes", "../outside.json")]));
    writeFileSync(join(base, "outside.json"), JSON.stringify({ version: 1, rules: [] }));
    const escapes = read();
    expect(escapes).toMatchObject({ ok: false, code: "UNREADABLE" });
    if (!escapes.ok) expect(escapes.message).toContain("escapes the package root");
  });
});
