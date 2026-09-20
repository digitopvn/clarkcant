import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { classifyPaths } from "../ci-test-scope.mjs";

const directories: string[] = [];
const script = fileURLToPath(new URL("../ci-test-scope.mjs", import.meta.url));
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "clarkcant-ci-scope-"));
  directories.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "user.name", "Test Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(cwd, "docs"));
  writeFileSync(join(cwd, "README.md"), "initial\n");
  writeFileSync(join(cwd, "source.ts"), "export const value = 1;\n");
  git("add", ".");
  git("commit", "-m", "initial");
  const base = git("rev-parse", "HEAD");
  const commit = () => { git("add", "-A"); git("commit", "-m", "change"); };
  const run = (revision = base) => {
    const output = join(cwd, "github-output");
    writeFileSync(output, "existing=value\n");
    execFileSync(process.execPath, [script], {
      cwd, encoding: "utf8",
      env: { ...process.env, CI_DIFF_BASE: revision, CI_DIFF_HEAD: "HEAD", GITHUB_OUTPUT: output },
    });
    return readFileSync(output, "utf8");
  };
  return { cwd, base, commit, run };
}

describe("conservative documentation scope", () => {
  it("permits only known prose and its integrity manifest", () => {
    expect(classifyPaths(["README.md", "DESIGN.md", "AGENTS.md", "docs/manifest.json", "docs/guide.md", "plans/a/plan.md"]).full).toBe(false);
  });
  it.each([[], ["unknown.md"], ["docs/example.json"], ["examples/a/README.md"], ["docs/a.md", "src/a.ts"], ["docs/../a.md"], ["docs//a.md"], ["/docs/a.md"], ["docs/./a.md"], ["docs\\a.md"], ["docs/a\n.md"], ["docs/a\0.md"], ["docs/a:stream.md"]].map((paths) => ({ paths })))("keeps full coverage for unsafe or unmapped paths $paths", ({ paths }) => {
    expect(classifyPaths(paths).full).toBe(true);
  });
  it("skips runtime tests for a real prose-only commit and appends output", () => {
    const repo = repository();
    writeFileSync(join(repo.cwd, "docs", "guide with spaces.md"), "guide\n");
    repo.commit();
    expect(repo.run()).toBe("existing=value\nfull=false\n");
  });
  it("retains both sides of a source-to-documentation rename", () => {
    const repo = repository();
    renameSync(join(repo.cwd, "source.ts"), join(repo.cwd, "docs", "source.md"));
    repo.commit();
    expect(repo.run()).toContain("full=true\n");
  });
  it("keeps mixed documentation and code commits full", () => {
    const repo = repository();
    writeFileSync(join(repo.cwd, "README.md"), "updated\n");
    writeFileSync(join(repo.cwd, "source.ts"), "export const value = 2;\n");
    repo.commit();
    expect(repo.run()).toContain("full=true\n");
  });
  it("keeps empty diffs and missing or invalid bases full", () => {
    const repo = repository();
    for (const base of [repo.base, "", "0".repeat(40), "f".repeat(40), "--help"]) {
      expect(repo.run(base)).toContain("full=true\n");
    }
  });
});
