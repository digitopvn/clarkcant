import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { manifestProblems, packageManifestSchema } from "@clarkcant/contracts";

import { runCli } from "../src/cli.ts";
import { runConformance } from "../src/conformance.ts";

/**
 * `clark widget init --template connected-app` starts a person from the reference connected app: a widget, a service
 * whose capabilities name the scopes they need on one declared account connection, skills, a fake connector and the
 * tests that run against it. These prove the copy is a package of its own, that it passes `clark widget test` and
 * `pack` as it is scaffolded, and that its own tests run in the copy.
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

async function scaffold(): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "clark-connected-"));
  roots.push(parent);
  const root = join(parent, "my-tasks");
  const { code, out } = await quietly(["widget", "init", root, "--template", "connected-app"]);
  expect(code).toBe(0);
  expect(out).toContain("created a connected-app widget package");
  return root;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("the connected-app template", () => {
  it("is named in the help", async () => {
    const { out } = await quietly(["--help"]);
    expect(out).toContain("connected-app");
  });

  it("copies the reference connected app under the new package's own identity", async () => {
    const root = await scaffold();
    const manifest = packageManifestSchema.parse(readJson(join(root, "clarkcant.json")));
    expect(manifestProblems(manifest)).toEqual([]);
    expect(manifest.id).toBe("com.example.my-tasks");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.facets.map((facet) => [facet.kind, facet.id])).toEqual([
      ["ui", "com.example.my-tasks.main@1"],
      ["tools", "com.example.my-tasks.service"],
      ["skills", "com.example.my-tasks.skills"],
    ]);
    const tools = manifest.facets[1];
    if (tools?.kind !== "tools") throw new Error("the second facet is the service");
    expect(tools.capabilities.map((capability) => [capability.ref, capability.effectCategory, capability.requiredScopes])).toEqual([
      ["com.example.my-tasks.list-tasks@1", "read", ["tasks.read"]],
      ["com.example.my-tasks.update-task@1", "external-write", ["tasks.write"]],
    ]);
    expect(tools.connection?.scopes.map((scope) => scope.scope)).toEqual(["tasks.read", "tasks.write"]);
    expect(tools.connection?.endpoints).toEqual(["http://127.0.0.1:8880"]);
    expect(readJson(join(root, "widgets", "main", "widget.json")).id).toBe("com.example.my-tasks.main@1");
    // Nothing of the reference's identity survives, the skill included.
    for (const file of ["clarkcant.json", "widgets/main/widget.json", "skills/tasks/SKILL.md"]) {
      expect(readFileSync(join(root, file), "utf8"), file).not.toContain("com.clarkcant.reference");
    }
    expect(readFileSync(join(root, "skills", "tasks", "SKILL.md"), "utf8")).toContain("com.example.my-tasks.update-task@1");
  });

  it("carries the fake connector, its harness and the portable tests, and leaves the repository's tests behind", async () => {
    const root = await scaffold();
    for (const file of ["dev/fake-connector.mjs", "dev/service-harness.mjs", "service/server.mjs", "dev/service.test.mjs"]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
    expect(readFileSync(join(root, "dev", "fake-connector.mjs"), "utf8")).toContain("TEST/DEV FIXTURE");
    expect(existsSync(join(root, "test", "package.spec.ts"))).toBe(false);
    expect(existsSync(join(root, "test", "fake-connector.spec.ts"))).toBe(false);
    for (const fixture of ["default", "empty", "error", "compact"]) {
      expect(existsSync(join(root, "fixtures", `${fixture}.json`)), fixture).toBe(true);
    }
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("# My Connected App");
    expect(readme).toContain("Replace the provider");
  });

  it("passes clark widget test and pack unchanged", async () => {
    const root = await scaffold();
    const result = runConformance(root);
    expect(result.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(result.checks.find((check) => check.id === "security.connectionHostOwned")?.status).toBe("pass");
    expect((await quietly(["widget", "test", root])).code).toBe(0);
    const packed = await quietly(["widget", "pack", root]);
    expect(packed.code, packed.err).toBe(0);
    const artifact = readJson(join(root, "dist", "artifact.json"));
    expect(artifact.id).toBe("com.example.my-tasks");
    expect((artifact.files as { path: string }[]).map((file) => file.path)).toContain("service/server.mjs");
  });

  it("runs its own service tests in the copy, against the fake connector", async () => {
    const root = await scaffold();
    const run = spawnSync(process.execPath, ["--test", join(root, "dev", "service.test.mjs")], { encoding: "utf8", timeout: 60_000 });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  });
});

describe("the frame check on a connected package", () => {
  it("fails a frame that names the provider's origin", async () => {
    const root = await scaffold();
    const main = join(root, "widgets", "main", "main.js");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(main, `${readFileSync(main, "utf8")}\n// fetch("http://127.0.0.1:8880/api/tasks")\n`);
    const check = runConformance(root).checks.find((entry) => entry.id === "security.connectionHostOwned");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("main.js: http://127.0.0.1:8880");
  });
});
