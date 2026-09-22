import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SCOPED_FS_TOOL_NAMES,
  canonicalRoots,
  createScopedFsTools,
  resolveInsideRoots,
  type ToolDefinition,
} from "../src/index.ts";

/**
 * The project-root boundary, on a real filesystem.
 *
 * Every case runs against directories made by `mkdtemp`: a mocked `fs` would prove that the code calls
 * the functions it calls, which is not the property in question. What is in question is whether a path
 * that leaves an approved root is refused when the kernel resolves it — through `..`, an absolute path,
 * or a symlink whose target is somewhere else — and whether a path that stays inside is still admitted.
 *
 * The fixture is deliberately shaped like the failure:
 *
 *   base/
 *     project-a/          <- approved
 *       notes.md
 *       sub/deep.txt
 *       link-inside  -> project-a/sub        (a symlink that stays inside: allowed)
 *       link-outside -> base/sibling         (a symlink that leaves: refused)
 *     project-b/          <- approved as well
 *       other.md
 *     sibling/
 *       secret.txt
 *       link-into-project -> project-a       (outside, pointing in: the file it names is inside)
 */

let base: string;
let projectA: string;
let projectB: string;
let sibling: string;

const INSIDE_TEXT = "three records\n";
const SIBLING_TEXT = "SECRET-SIBLING\n";

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "clarkcant-scoped-fs-"));
  projectA = join(base, "project-a");
  projectB = join(base, "project-b");
  sibling = join(base, "sibling");

  await mkdir(join(projectA, "sub"), { recursive: true });
  await mkdir(projectB, { recursive: true });
  await mkdir(sibling, { recursive: true });

  await writeFile(join(projectA, "notes.md"), INSIDE_TEXT, "utf8");
  await writeFile(join(projectA, "sub", "deep.txt"), "deep inside the project\n", "utf8");
  await writeFile(join(projectB, "other.md"), "the second approved root\n", "utf8");
  await writeFile(join(sibling, "secret.txt"), SIBLING_TEXT, "utf8");

  await symlink(join(projectA, "sub"), join(projectA, "link-inside"), "dir");
  await symlink(sibling, join(projectA, "link-outside"), "dir");
  await symlink(projectA, join(sibling, "link-into-project"), "dir");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** The canonical form of the given roots, asserting none of them was refused. */
async function approved(...paths: string[]): Promise<string[]> {
  const canonical = await canonicalRoots(paths);
  expect(canonical.refused).toEqual([]);
  return [...canonical.roots];
}

/** One of the four tools, bound to a canonical root set, by name. */
function tool(roots: readonly string[], name: string): ToolDefinition {
  const found = createScopedFsTools({ roots }).find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`${name} is not one of the scoped tools`);
  return found;
}

describe("the boundary an approved root describes", () => {
  it("admits a file inside the root, and canonicalises it", async () => {
    const roots = await approved(projectA);
    const verdict = await resolveInsideRoots(roots, join(projectA, "notes.md"));

    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.path).toBe(join(projectA, "notes.md"));
  });

  it("keeps a symlink whose canonical target is inside the root", async () => {
    const roots = await approved(projectA);
    const verdict = await resolveInsideRoots(roots, join(projectA, "link-inside", "deep.txt"));

    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.path).toBe(join(projectA, "sub", "deep.txt"));
  });

  it("refuses a `..` that climbs out of the root", async () => {
    const roots = await approved(projectA);
    const verdict = await resolveInsideRoots(roots, `${projectA}/../sibling/secret.txt`);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/outside every approved root/);
  });

  it("keeps a `..` that resolves back inside the root", async () => {
    const roots = await approved(projectA);
    const verdict = await resolveInsideRoots(roots, `${projectA}/sub/../notes.md`);

    // Refusing every `..` would refuse legitimate paths, and a boundary that refuses more than it must
    // is a boundary people route around.
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.path).toBe(join(projectA, "notes.md"));
  });

  it("refuses an absolute path outside every approved root", async () => {
    const roots = await approved(projectA);
    const verdict = await resolveInsideRoots(roots, join(sibling, "secret.txt"));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(projectA);
  });

  it("refuses a symlink whose target is outside every approved root", async () => {
    const roots = await approved(projectA);
    const verdict = await resolveInsideRoots(roots, join(projectA, "link-outside", "secret.txt"));

    // The path as written is inside the root; the directory it names is not. Containment is checked on the
    // canonical target, which is the only version of the path the filesystem agrees to.
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/outside every approved root/);
  });

  it("admits a path outside the root whose canonical target is inside it", async () => {
    const roots = await approved(projectA);
    const verdict = await resolveInsideRoots(roots, join(sibling, "link-into-project", "notes.md"));

    // What a worker can reach is the file, not the spelling of the path that led there. This resolves to
    // the same `project-a/notes.md` the root admits, so admitting it grants nothing new.
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.path).toBe(join(projectA, "notes.md"));
  });

  it("refuses an approved root that is no longer the directory that was approved", async () => {
    const alias = join(base, "alias-to-project-b");
    await symlink(projectB, alias, "dir");

    const verdict = await resolveInsideRoots([alias], join(projectB, "other.md"));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/no longer the directory that was approved/);
  });

  it("reports a root it cannot use instead of dropping it silently", async () => {
    const canonical = await canonicalRoots([join(base, "not-there"), projectA, "relative/root"]);

    expect(canonical.roots).toEqual([projectA]);
    expect(canonical.refused.map((entry) => entry.root)).toEqual([join(base, "not-there"), "relative/root"]);
    expect(canonical.refused[0]?.reason).toMatch(/cannot be resolved/);
    expect(canonical.refused[1]?.reason).toMatch(/not an absolute path/);
  });

  it("refuses every path when no root was approved", async () => {
    const verdict = await resolveInsideRoots([], join(projectA, "notes.md"));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/no approved root is in force/);
  });

  it("admits every approved root, not just the first", async () => {
    const roots = await approved(projectA, projectB);

    const inFirst = await resolveInsideRoots(roots, join(projectA, "notes.md"));
    const inSecond = await resolveInsideRoots(roots, join(projectB, "other.md"));
    const inNeither = await resolveInsideRoots(roots, join(sibling, "secret.txt"));

    expect(inFirst.ok).toBe(true);
    expect(inSecond.ok).toBe(true);
    expect(inNeither.ok).toBe(false);
  });
});

describe("the scoped tools", () => {
  it("registers exactly the four filesystem tools the boundary is made of", () => {
    const tools = createScopedFsTools({ roots: [projectA] });

    expect(tools.map((entry) => entry.name)).toEqual([...SCOPED_FS_TOOL_NAMES]);
    // A snippet is what puts a tool in the system prompt's tool list; without one the model is told it has
    // no tools while being asked to use one.
    expect(tools.every((entry) => (entry.promptSnippet ?? "") !== "")).toBe(true);
  });

  it("reads inside the root and refuses a file beside it", async () => {
    const roots = await approved(projectA);
    const read = tool(roots, "clarkcant_read");

    const inside = await read.execute({ path: join(projectA, "notes.md") });
    const outside = await read.execute({ path: join(sibling, "secret.txt") });

    expect(inside.text).toContain(INSIDE_TEXT.trim());
    expect(outside.text).toMatch(/^refused: /);
    expect(outside.text).not.toContain(SIBLING_TEXT.trim());
  });

  it("resolves a relative path against the first approved root, never the working directory", async () => {
    const roots = await approved(projectA, projectB);
    const read = tool(roots, "clarkcant_read");

    const inside = await read.execute({ path: "notes.md" });
    const climbing = await read.execute({ path: "../sibling/secret.txt" });

    expect(inside.text).toContain(INSIDE_TEXT.trim());
    expect(climbing.text).toMatch(/^refused: /);
    expect(climbing.text).not.toContain(SIBLING_TEXT.trim());
  });

  it("labels a read that was cut at the byte bound", async () => {
    const roots = await approved(projectA);
    await writeFile(join(projectA, "long.txt"), "x".repeat(5_000), "utf8");
    const read = tool(roots, "clarkcant_read");

    const result = await read.execute({ path: join(projectA, "long.txt"), maxBytes: 100 });

    expect(result.text).toContain("the first 100 are shown");
    expect(result.text.length).toBeLessThan(5_000);
  });

  it("labels a search that was cut at the match bound", async () => {
    const roots = await approved(projectA);
    await writeFile(join(projectA, "many.txt"), Array.from({ length: 10 }, (_, index) => `hit ${index}`).join("\n"), "utf8");
    const grep = tool(roots, "clarkcant_grep");

    const result = await grep.execute({ pattern: "^hit", path: projectA, maxMatches: 3 });

    expect(result.text).toContain("only the first 3 matches are shown");
  });

  it("does not follow a symlink out of the root while searching", async () => {
    const roots = await approved(projectA);
    const grep = tool(roots, "clarkcant_grep");
    const find = tool(roots, "clarkcant_find");

    const searched = await grep.execute({ pattern: "SECRET-SIBLING", path: projectA });
    const listed = await find.execute({ path: projectA });

    expect(searched.text).not.toContain("secret.txt");
    expect(searched.text).toMatch(/leaves the approved roots was not followed/);
    expect(listed.text).not.toContain("secret");
    expect(listed.text).toContain("notes.md");
  });

  it("lists a directory, naming what each symlink resolves to", async () => {
    const roots = await approved(projectA);
    const ls = tool(roots, "clarkcant_ls");

    const result = await ls.execute({ path: projectA });

    expect(result.text).toContain(`link-inside -> ${join(projectA, "sub")}`);
    expect(result.text).toContain("link-outside -> outside the approved roots");
    expect(result.text).toContain("sub/");
  });

  it("refuses a path outside the roots from every one of the four tools, with a readable reason", async () => {
    const roots = await approved(projectA);
    const outside = join(sibling, "secret.txt");
    const calls: { name: string; params: Record<string, unknown> }[] = [
      { name: "clarkcant_read", params: { path: outside } },
      { name: "clarkcant_grep", params: { pattern: "anything", path: outside } },
      { name: "clarkcant_find", params: { path: sibling } },
      { name: "clarkcant_ls", params: { path: sibling } },
    ];

    for (const call of calls) {
      const result = await tool(roots, call.name).execute(call.params);
      expect(result.text, `${call.name} did not refuse a path outside the roots`).toMatch(/^refused: /);
      expect(result.text.length, `${call.name} gave no reason`).toBeGreaterThan("refused: ".length);
      expect(result.text).not.toContain(SIBLING_TEXT.trim());
    }
  });
});
