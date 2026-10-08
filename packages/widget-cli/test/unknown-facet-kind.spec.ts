import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readPackage } from "@clarkcant/core";

import { runCli } from "../src/cli.ts";
import { runConformance } from "../src/conformance.ts";

/**
 * A facet kind this clark does not know. A host reads past it; the author's tools hold it as a failure, because to an
 * author it is more often a misspelling than a newer kind, and a listing made by tools that cannot read a facet would
 * describe less than the package holds.
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

async function withFacet(facet: Record<string, unknown>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "clark-unknown-facet-"));
  roots.push(root);
  expect((await quietly(["widget", "init", root])).code).toBe(0);
  const path = join(root, "clarkcant.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { facets: unknown[] };
  manifest.facets.push(facet);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

const NEWER = { kind: "agents", id: "com.example.later.agents", entry: "agents/index.json", isolation: "declarative" };

describe("clark widget test with a facet kind it does not know", () => {
  it("reads the rest of the package and fails the facet by name, saying what a host does with it", async () => {
    const root = await withFacet(NEWER);

    const pkg = readPackage(root);
    expect(pkg.problems).toEqual([]);
    expect(pkg.facets).toHaveLength(1);
    expect(pkg.skippedFacets).toEqual([{ index: 1, kind: "agents", id: "com.example.later.agents", isolation: "declarative" }]);

    const result = runConformance(root);
    const failed = result.checks.filter((check) => check.status === "fail");
    expect(failed.map((check) => check.id)).toEqual(["schema.facet.understood:1"]);
    expect(failed[0]?.detail).toContain('facet com.example.later.agents: kind "agents" is declared but not understood');
    expect(failed[0]?.detail).toContain("A host from this version on installs the package without it");
    // The widget it does understand is still checked in full.
    expect(result.checks.find((check) => check.id === "schema.props.valid")).toMatchObject({ status: "pass" });

    const run = await quietly(["widget", "test", root]);
    expect(run.code).toBe(1);
    expect(run.out).toContain('FAIL every facet kind is one this clark understands — facet com.example.later.agents: kind "agents"');
  });

  it("refuses to pack it, so no listing describes less than the package holds", async () => {
    const root = await withFacet(NEWER);
    const run = await quietly(["widget", "pack", root]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("Refusing to pack a package that fails conformance.");
  });

  it("still refuses a known kind with a bad body, as a package that cannot be read", async () => {
    const root = await withFacet({ kind: "skills", id: "com.example.skills", entry: "skills/", isolation: "service" });
    const result = runConformance(root);
    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => check.id)).toEqual(["package.readable"]);
  });
});
