import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanCredentialChunk, scanSecretHistory } from "../scan-secret-history.mjs";

const directories: string[] = [];
const script = fileURLToPath(new URL("../scan-secret-history.mjs", import.meta.url));
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "clarkcant-secret-scan-"));
  directories.push(path);
  return path;
}
function repository() {
  const cwd = directory();
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  // A commit or merge can start git's detached auto-maintenance, which may still be writing .git/objects when
  // afterEach deletes the fixture; the fixture has too few objects to need it anyway.
  git("config", "maintenance.auto", "false");
  git("config", "gc.auto", "0");
  const commit = () => { git("add", "-A"); git("commit", "-m", "fixture"); };
  writeFileSync(join(cwd, "clean.txt"), "no credentials\n");
  commit();
  return { cwd, git, commit };
}

describe("secret scanning across reachable Git history", () => {
  it("detects credential prefixes and PEM delimiters across every chunk boundary", () => {
    const tokens = ["ghp_" + "S".repeat(32), "sk-" + "A".repeat(24), "AKIA" + "B".repeat(16),
      "npm_" + "C".repeat(32), "-----BEGIN " + "LONG ".repeat(40) + "PRIVATE KEY-----"];
    for (const token of tokens) {
      for (let split = 1; split < token.length; split += 1) {
        const first = scanCredentialChunk(token.slice(0, split));
        const last = scanCredentialChunk(token.slice(split), first.tail);
        expect([...first.categories, ...last.categories].length, `split ${split}`).toBeGreaterThan(0);
      }
      let tail = "";
      const found = new Set<string>();
      for (const character of token) {
        const next = scanCredentialChunk(character, tail);
        tail = next.tail;
        next.categories.forEach((category: string) => found.add(category));
      }
      expect(found.size).toBe(1);
    }
  });

  it("accepts clean history and scans repeated blobs only once", async () => {
    const repo = repository();
    writeFileSync(join(repo.cwd, "copy.txt"), "no credentials\n");
    repo.commit();
    expect(await scanSecretHistory(repo.cwd)).toEqual({ blobs: 1, findings: [] });
  });

  it("finds a deleted credential in docs and never prints its value", async () => {
    const repo = repository();
    const token = "ghp_" + "S".repeat(32);
    mkdirSync(join(repo.cwd, "docs"));
    writeFileSync(join(repo.cwd, "docs", "old.md"), token);
    repo.commit();
    const object = repo.git("rev-parse", "HEAD:docs/old.md");
    repo.git("rm", "docs/old.md");
    repo.commit();
    const result = await scanSecretHistory(repo.cwd);
    expect(result.findings).toEqual([{ object, categories: ["GitHub token"] }]);
    const cli = spawnSync(process.execPath, [script], { cwd: repo.cwd, encoding: "utf8" });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain(object);
    expect(cli.stdout + cli.stderr).not.toContain(token);
  });

  it("includes other refs, merge results, binary bytes and every credential category", async () => {
    const repo = repository();
    repo.git("checkout", "-b", "other");
    const tokens = ["sk-" + "A".repeat(24), "AKIA" + "B".repeat(16), "npm_" + "C".repeat(32),
      "-----BEGIN " + "RSA PRIVATE KEY-----"];
    writeFileSync(join(repo.cwd, "fixture.bin"), Buffer.from("\0" + "x".repeat(65530) + tokens.join("\n")));
    repo.commit();
    repo.git("checkout", "main");
    const result = await scanSecretHistory(repo.cwd);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.categories.sort()).toEqual(["API key", "AWS access key", "npm token", "private key"].sort());
    repo.git("merge", "--no-ff", "--no-commit", "other");
    writeFileSync(join(repo.cwd, "merge.txt"), "ghs_" + "D".repeat(32));
    repo.commit();
    expect((await scanSecretHistory(repo.cwd)).findings).toHaveLength(2);
  });

  it("fails closed for a shallow clone or a non-repository", async () => {
    const repo = repository();
    const shallow = join(directory(), "clone");
    repo.git("clone", "--depth", "1", pathToFileURL(repo.cwd).href, shallow);
    await expect(scanSecretHistory(shallow)).rejects.toThrow("full history required");
    const absent = directory();
    await expect(scanSecretHistory(absent)).rejects.toThrow();
    expect(spawnSync(process.execPath, [script], { cwd: absent }).status).toBe(1);
  });
});
