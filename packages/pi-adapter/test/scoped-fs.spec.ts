import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SCOPED_FS_LIMITS,
  SCOPED_FS_TOOL_NAMES,
  canonicalRoots,
  createScopedFsTools,
  resolveInsideRoots,
  type ApprovedRoot,
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
async function approved(...paths: string[]): Promise<ApprovedRoot[]> {
  const canonical = await canonicalRoots(paths);
  expect(canonical.refused).toEqual([]);
  // The approval record rather than the paths: it carries the identity each root had when it was approved,
  // which is what every resolution re-checks.
  return [...canonical.approved];
}

/** One of the four tools, bound to an approved root set, by name. */
function tool(roots: readonly ApprovedRoot[], name: string): ToolDefinition {
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
    const roots = await approved(projectA);

    // The name stays where it was and something else now answers to it: a symlink to another directory.
    await rm(projectA, { recursive: true, force: true });
    await symlink(projectB, projectA, "dir");

    const verdict = await resolveInsideRoots(roots, join(projectB, "other.md"));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/no longer the directory that was approved/);
  });

  it("refuses a root that was replaced in place after it was approved", async () => {
    const roots = await approved(projectA);

    /*
     * The failure a string comparison cannot see: the directory is moved out of the way and a *different*
     * directory is created under the same name. `realpath` answers with the same path it did at approval, so
     * only the inode shows that the directory is not the one that was approved.
     */
    await rename(projectA, join(base, "project-a-moved"));
    await mkdir(projectA, { recursive: true });
    await writeFile(join(projectA, "planted.txt"), "planted after approval\n", "utf8");

    const verdict = await resolveInsideRoots(roots, join(projectA, "planted.txt"));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/different directory than the one that was approved/);
  });

  it("refuses a path whose component is a symlink with no target", async () => {
    const roots = await approved(projectA);
    // A symlink to a path that does not exist: the platform would resolve the rest of the path against the
    // link's target, so the segments after it cannot be joined to this path and admitted.
    await symlink(join(projectA, "not-there"), join(projectA, "dangle"), "dir");

    const verdict = await resolveInsideRoots(roots, join(projectA, "dangle", "child.txt"));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/symlink whose target does not resolve/);
  });

  it("admits a file that is not there yet, so a truthful not-found is still possible", async () => {
    const roots = await approved(projectA);

    const verdict = await resolveInsideRoots(roots, join(projectA, "sub", "not-written.txt"));

    // A component that simply does not exist is not an escape: the path stays inside the root and the tool
    // reports that there is nothing there, which is a fact about the file rather than about the boundary.
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.path).toBe(join(projectA, "sub", "not-written.txt"));
  });

  it("keeps a directory whose name begins with two dots", async () => {
    await mkdir(join(projectA, "..dots"), { recursive: true });
    await writeFile(join(projectA, "..dots", "inside.txt"), "inside a dots directory\n", "utf8");
    const roots = await approved(projectA);

    const verdict = await resolveInsideRoots(roots, join(projectA, "..dots", "inside.txt"));

    // `..dots` climbs nowhere. Refusing it would refuse a file that is inside the root, and a boundary that
    // refuses more than it must is a boundary people route around.
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.path).toBe(join(projectA, "..dots", "inside.txt"));
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
  it("registers exactly the four filesystem tools the boundary is made of", async () => {
    const tools = createScopedFsTools({ roots: await approved(projectA) });

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

  it("holds a read to the per-tool output bound, not only to the per-file one", async () => {
    const roots = await approved(projectA);
    // Comfortably larger than `maxOutputBytes` and smaller than `maxFileBytes`: the file bound alone would
    // hand the whole of it over as one tool's output.
    const size = 200_000;
    await writeFile(join(projectA, "huge.txt"), "y".repeat(size), "utf8");
    const read = tool(roots, "clarkcant_read");

    const result = await read.execute({ path: join(projectA, "huge.txt") });

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(SCOPED_FS_LIMITS.maxOutputBytes);
    expect(result.text).toContain(String(SCOPED_FS_LIMITS.maxOutputBytes));
  });

  it("cuts a read between characters, so a multi-byte file stays inside the output bound", async () => {
    const roots = await approved(projectA);
    /*
     * `€` is three bytes, so a cut made at a byte offset can land inside one, and the replacement character a
     * decoder then leaves behind re-encodes to three bytes: an answer cut to fit goes back over the bound it
     * was cut for. Measured with the byte cut: 65 538 bytes against a bound of 65 536.
     */
    const read = tool(roots, "clarkcant_read");
    // Three file sizes, because whether a byte offset lands inside a character depends on the header's own
    // length, which the byte count in it changes; a bound that holds for one of them and not the others is
    // not a bound.
    const sizes = [100_000, 1_000_000, 10_000_000];
    for (const size of sizes) {
      const name = join(projectA, `euro-${size}.txt`);
      await writeFile(name, "€".repeat(Math.ceil(size / 3)), "utf8");

      const result = await read.execute({ path: name });

      expect(
        Buffer.byteLength(result.text, "utf8"),
        `a read of ${size} byte of multi-byte text exceeded the output bound`,
      ).toBeLessThanOrEqual(SCOPED_FS_LIMITS.maxOutputBytes);
      // No replacement character: the cut fell between characters rather than inside one.
      expect(result.text).not.toContain("\uFFFD");
    }
  });

  it("refuses a read of a symlink whose target is not there, rather than following it", async () => {
    const roots = await approved(projectA);
    await symlink(join(projectA, "not-there.txt"), join(projectA, "dangling.txt"));
    const read = tool(roots, "clarkcant_read");

    const result = await read.execute({ path: join(projectA, "dangling.txt") });

    expect(result.text).toMatch(/^refused: /);
    expect(result.text).toContain("dangling.txt");
  });

  it("returns no match from a search that has to stop its matching thread", async () => {
    const roots = await approved(projectA);
    /*
     * A catastrophic pattern: `^(a+)+$` against `a`s that end in a `b` backtracks for longer than this test
     * will live, and a synchronous match would hold the whole event loop rather than one call. The clock the
     * tool is held to is what has to answer, and the ticker below is what proves the loop stayed free: a
     * pattern matched in this process would starve it. Matching this file in this process was measured at over
     * ten seconds of no ticks at all, so the floor below is a floor a synchronous match cannot reach.
     */
    await writeFile(join(projectA, "catastrophic.txt"), `${"a".repeat(8_000)}b\n`, "utf8");
    const grep = tool(roots, "clarkcant_grep");
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 25);

    const started = Date.now();
    const result = await grep.execute({ pattern: "^(a+)+$", path: projectA });
    const elapsed = Date.now() - started;
    clearInterval(ticker);

    expect(result.text).toMatch(/^refused: /);
    expect(result.text).toContain("matching budget");
    // The budget is a wall-clock bound: the call answers shortly after it, rather than never.
    expect(elapsed).toBeLessThan(SCOPED_FS_LIMITS.maxGrepMatchMs + 5_000);
    // A free event loop ticks this often a couple of hundred times inside the budget; a match in this process
    // ticks it not once. Twenty is a floor that fails for the reason the test exists rather than a count that
    // any answer at all would satisfy.
    expect(ticks).toBeGreaterThanOrEqual(20);
  }, 30_000);

  it("refuses a find glob that cannot finish matching, instead of holding the event loop", async () => {
    const roots = await approved(projectA);
    /*
     * The counterexample, with the name it needs to bite: `*?` eleven times is eleven `.*.` in a row once the
     * glob is translated, and a name that does not end in `z` makes the engine try every way of splitting the
     * name between them. Matched in this process that took 10 010 ms with a 25 ms ticker firing 0 times (the
     * probe run for the fix); matched in the thread the tool starts, the clock answers instead.
     */
    await writeFile(
      join(projectA, "packages-pi-adapter-src-scoped-fs.ts"),
      "a name long enough for the pattern to be expensive\n",
      "utf8",
    );
    const find = tool(roots, "clarkcant_find");
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);

    const started = Date.now();
    const result = await find.execute({ path: projectA, pattern: "*?".repeat(11) + "z" });
    const elapsed = Date.now() - started;
    clearInterval(ticker);

    expect(result.text).toMatch(/^refused: /);
    expect(result.text).toContain("matching budget");
    // Well under the ten seconds a match in this process costs, and inside the budget plus the thread's own
    // start-up. A glob matched synchronously would return nothing at all to a ticker in the meantime.
    expect(elapsed).toBeLessThan(SCOPED_FS_LIMITS.maxFindMatchMs + 1_000);
    expect(ticks).toBeGreaterThanOrEqual(20);
  }, 30_000);

  it("matches a glob, and a pattern with no wildcard as a substring", async () => {
    const roots = await approved(projectA);
    const find = tool(roots, "clarkcant_find");

    const glob = await find.execute({ path: projectA, pattern: "*.md" });
    const wildcard = await find.execute({ path: projectA, pattern: "n?tes.*" });
    const literal = await find.execute({ path: projectA, pattern: "notes" });
    const nothing = await find.execute({ path: projectA, pattern: "*nothing-matches-this*" });

    expect(glob.text).toContain("notes.md");
    expect(glob.text).toContain("file under");
    expect(wildcard.text).toContain("notes.md");
    // A pattern with neither wildcard is a substring to look for, not an anchored name.
    expect(literal.text).toContain("notes.md");
    expect(nothing.text).toContain("0 file under");
  });

  it("reads the characters a glob names, not the regular expression it would be as a pattern", async () => {
    const roots = await approved(projectA);
    // A file name the pattern has to match literally: `(` and `[` are group and class syntax to a regular
    // expression, and to this glob they are two characters in a name.
    await writeFile(join(projectA, "a(b[c]+.txt"), "brackets in the name\n", "utf8");
    const find = tool(roots, "clarkcant_find");

    const exact = await find.execute({ path: projectA, pattern: "a(b[c]+.txt" });
    const glob = await find.execute({ path: projectA, pattern: "a(b[*]+.txt" });

    expect(exact.text).toContain("a(b[c]+.txt");
    expect(glob.text).toContain("a(b[c]+.txt");
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
