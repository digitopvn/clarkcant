import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakePiAdapter, RealPiAdapter, fakeSkillRevision } from "../src/index.ts";

/**
 * The skills the composer offers after a slash, read the way a worker session would load them.
 *
 * The real adapter is exercised against the real SDK loader over temporary directories: discovery is the SDK's, and a
 * test against a stub would prove only that the stub was asked. No session is created and no provider is called.
 */

let root: string;
let cwd: string;
let agentDir: string;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

function skill(dir: string, name: string, description: string, body: string): string {
  mkdirSync(join(dir, name), { recursive: true });
  const file = join(dir, name, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarkcant-skills-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // The loader also reads the person's global skill directories under their home, and project skill directories in
  // the working directory's ancestors up to the repository root, as a worker session does. The home is moved into the
  // temporary directory and the project is made a repository root, so this test sees only the skills it wrote.
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("the real adapter's skills", () => {
  it("lists personal and project skills with a revision and no path", async () => {
    skill(join(agentDir, "skills"), "review", "Review a change.", "Read the change and report real defects.");
    skill(join(cwd, ".pi", "skills"), "release-notes", "Write release notes.", "Group recent changes.");
    const adapter = new RealPiAdapter({ cwd, agentDir });

    const listed = await adapter.skills();
    expect(listed.map((entry) => [entry.name, entry.source])).toEqual([
      ["release-notes", "project"],
      ["review", "personal"],
    ]);
    for (const entry of listed) expect(entry.revision).toMatch(/^[0-9a-f]{64}$/);
    // Names, descriptions and digests only: the listing is what a picker shows, and a path in it would be a path in a
    // browser.
    expect(JSON.stringify(listed)).not.toContain(root);
  });

  it("returns a skill's instructions without frontmatter while its revision still holds", async () => {
    skill(join(agentDir, "skills"), "review", "Review a change.", "Read the change and report real defects.");
    const adapter = new RealPiAdapter({ cwd, agentDir });
    const [review] = await adapter.skills();

    const body = await adapter.skillBody("review", review?.revision ?? "");
    expect(body).toEqual({ ok: true, name: "review", body: "Read the change and report real defects." });
  });

  it("reports an edited skill as changed and a removed one as missing", async () => {
    const file = skill(join(agentDir, "skills"), "review", "Review a change.", "First version.");
    const adapter = new RealPiAdapter({ cwd, agentDir });
    const [review] = await adapter.skills();

    writeFileSync(file, "---\nname: review\ndescription: Review a change.\n---\n\nSecond version.\n");
    expect(await adapter.skillBody("review", review?.revision ?? "")).toEqual({ ok: false, reason: "changed" });

    rmSync(join(agentDir, "skills", "review"), { recursive: true, force: true });
    expect(await adapter.skillBody("review", review?.revision ?? "")).toEqual({ ok: false, reason: "missing" });
  });

  it("offers nothing on a machine where pi has no skills", async () => {
    expect(await new RealPiAdapter({ cwd, agentDir }).skills()).toEqual([]);
  });
});

describe("the fake adapter's skills", () => {
  it("has a default list from two sources, and a seam to change it", async () => {
    const adapter = new FakePiAdapter();
    const listed = await adapter.skills();
    expect(new Set(listed.map((entry) => entry.source))).toEqual(new Set(["personal", "project"]));

    const [first] = listed;
    expect((await adapter.skillBody(first?.name ?? "", first?.revision ?? "")).ok).toBe(true);

    adapter.setSkills([{ name: first?.name ?? "", description: "edited", source: "personal", body: "new words" }]);
    expect(await adapter.skillBody(first?.name ?? "", first?.revision ?? "")).toEqual({ ok: false, reason: "changed" });
    const edited = { name: "x", description: "d", source: "package" as const, body: "b" };
    adapter.setSkills([edited]);
    expect(await adapter.skillBody("x", fakeSkillRevision(edited))).toEqual({ ok: true, name: "x", body: "b" });
    expect(await adapter.skillBody(first?.name ?? "", first?.revision ?? "")).toEqual({ ok: false, reason: "missing" });
  });
});
