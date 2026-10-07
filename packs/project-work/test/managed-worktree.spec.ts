import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";

import { removeTestDirectory, trackedTests } from "../../../tools/test-cleanup.ts";
import {
  ensureManagedWorktree,
  findManagedWorktrees,
  managedBranchFor,
  removeEmptyTaskFolder,
  removeManagedWorktree,
} from "../src/managed-worktree.ts";

/**
 * A task's own worktree.
 *
 * Against real repositories and real git, for the same reason as `worktree.spec.ts`: what matters is what git does to
 * the person's tree, and a model of git would only agree with itself.
 */

/**
 * Each test spawns git many times, through the helper below and through the module under test. A spawn takes about
 * 40 ms alone, but 150 to 350 ms (p99 near 2 s) while the full suite runs on a loaded Windows machine, and a test that
 * takes 3.5 s alone took up to 19 s there. The budget is that worst case with room to spare.
 */
const { it, settled } = trackedTests(60_000);

let dirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tempDir(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `clarkcant-${name}-`));
  dirs.push(path);
  return path;
}

function makeRepo(parent?: string): string {
  const path = parent === undefined ? tempDir("managed-repo") : join(parent, "repo");
  mkdirSync(path, { recursive: true });
  git(path, ["init", "--initial-branch=main"]);
  git(path, ["config", "user.email", "test@example.invalid"]);
  git(path, ["config", "user.name", "Test"]);
  // The bytes a checkout writes are the bytes committed, whatever line-ending conversion this machine's git applies.
  git(path, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(path, "readme.txt"), "original\n", "utf8");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "initial"]);
  return path;
}

beforeEach(() => {
  dirs = [];
});

afterEach(async () => {
  await settled();
  for (const path of dirs) await removeTestDirectory(path);
});

describe("a task works in its own worktree, never in the person's tree", () => {
  it("makes a worktree of HEAD under the node's directory, on a branch named for the task", async () => {
    const repo = makeRepo();
    const worktreesDir = tempDir("managed-worktrees");
    const made = await ensureManagedWorktree({ repoPath: repo, worktreesDir, taskId: "task_1" });
    if (!made.ok) throw new Error(made.message);

    expect(made.worktree.path.startsWith(worktreesDir)).toBe(true);
    expect(made.worktree.branch).toBe(managedBranchFor("task_1"));
    expect(made.worktree.reused).toBe(false);
    expect(readFileSync(join(made.worktree.path, "readme.txt"), "utf8")).toBe("original\n");
    expect(git(made.worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("clarkcant/task-task_1");
    // The person's checkout did not move.
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("leaves what the person has not committed exactly where it is", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "readme.txt"), "a person's unsaved thought\n", "utf8");
    writeFileSync(join(repo, "draft.txt"), "untracked\n", "utf8");
    const made = await ensureManagedWorktree({ repoPath: repo, worktreesDir: tempDir("managed-worktrees"), taskId: "task_2" });
    if (!made.ok) throw new Error(made.message);

    writeFileSync(join(made.worktree.path, "readme.txt"), "the task's change\n", "utf8");
    expect(readFileSync(join(repo, "readme.txt"), "utf8")).toBe("a person's unsaved thought\n");
    expect(readFileSync(join(repo, "draft.txt"), "utf8")).toBe("untracked\n");
    // The task's worktree starts from the commit, not from the person's edits.
    expect(existsSync(join(made.worktree.path, "draft.txt"))).toBe(false);
  });

  it("reuses the worktree a task already has, keeping what it did", async () => {
    const repo = makeRepo();
    const worktreesDir = tempDir("managed-worktrees");
    const first = await ensureManagedWorktree({ repoPath: repo, worktreesDir, taskId: "task_3" });
    if (!first.ok) throw new Error(first.message);
    writeFileSync(join(first.worktree.path, "progress.txt"), "half done\n", "utf8");

    const again = await ensureManagedWorktree({ repoPath: repo, worktreesDir, taskId: "task_3" });
    if (!again.ok) throw new Error(again.message);
    expect(again.worktree.reused).toBe(true);
    expect(readFileSync(join(again.worktree.path, "progress.txt"), "utf8")).toBe("half done\n");
  });

  it("gives each repository of one task its own worktree, even two that share a folder name", async () => {
    // Both are called `repo`: what tells them apart is where they are.
    const first = makeRepo(tempDir("managed-parent"));
    const second = makeRepo(tempDir("managed-parent"));
    writeFileSync(join(first, "readme.txt"), "unsaved in the first\n", "utf8");
    writeFileSync(join(second, "readme.txt"), "unsaved in the second\n", "utf8");
    const worktreesDir = tempDir("managed-worktrees");

    const a = await ensureManagedWorktree({ repoPath: first, worktreesDir, taskId: "task_multi" });
    const b = await ensureManagedWorktree({ repoPath: second, worktreesDir, taskId: "task_multi" });
    if (!a.ok || !b.ok) throw new Error(`test setup: ${a.ok ? "" : a.message} ${b.ok ? "" : b.message}`);

    expect(a.worktree.path).not.toBe(b.worktree.path);
    // One folder for the task, one worktree per repository inside it.
    expect(dirname(a.worktree.path)).toBe(join(worktreesDir, "task_multi"));
    expect(dirname(b.worktree.path)).toBe(join(worktreesDir, "task_multi"));
    for (const [made, repo] of [[a, first], [b, second]] as const) {
      expect(git(made.worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(managedBranchFor("task_multi"));
      writeFileSync(join(made.worktree.path, "readme.txt"), "the task's change\n", "utf8");
      git(made.worktree.path, ["commit", "-am", "task change"]);
      expect(git(repo, ["show", `${managedBranchFor("task_multi")}:readme.txt`])).toBe("the task's change");
      expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    }
    expect(readFileSync(join(first, "readme.txt"), "utf8")).toBe("unsaved in the first\n");
    expect(readFileSync(join(second, "readme.txt"), "utf8")).toBe("unsaved in the second\n");

    // Dispatched again, each repository finds its own worktree, with what the task did in it.
    const againA = await ensureManagedWorktree({ repoPath: first, worktreesDir, taskId: "task_multi" });
    const againB = await ensureManagedWorktree({ repoPath: second, worktreesDir, taskId: "task_multi" });
    if (!againA.ok || !againB.ok) throw new Error("the worktrees were not found again");
    expect([againA.worktree.path, againA.worktree.reused]).toEqual([a.worktree.path, true]);
    expect([againB.worktree.path, againB.worktree.reused]).toEqual([b.worktree.path, true]);
  });

  it("continues in the worktree a task made before tasks could name several repositories", async () => {
    const repo = makeRepo();
    const worktreesDir = tempDir("managed-worktrees");
    // Where a task's worktree used to be: the task's folder itself.
    const earlier = join(worktreesDir, "task_earlier");
    git(repo, ["worktree", "add", "-b", managedBranchFor("task_earlier"), earlier]);
    writeFileSync(join(earlier, "progress.txt"), "half done\n", "utf8");

    const made = await ensureManagedWorktree({ repoPath: repo, worktreesDir, taskId: "task_earlier" });
    if (!made.ok) throw new Error(made.message);
    expect(made.worktree.reused).toBe(true);
    expect(made.worktree.path).toBe(earlier);
    expect(readFileSync(join(made.worktree.path, "progress.txt"), "utf8")).toBe("half done\n");
  });

  it("refuses a folder that is not a repository", async () => {
    const made = await ensureManagedWorktree({
      repoPath: tempDir("not-a-repo"),
      worktreesDir: tempDir("managed-worktrees"),
      taskId: "task_4",
    });
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.code).toBe("NOT_A_REPOSITORY");
  });
});

describe("taking a finished task's worktree away", () => {
  it("removes a clean worktree and keeps the branch with what the task committed", async () => {
    const repo = makeRepo();
    const made = await ensureManagedWorktree({ repoPath: repo, worktreesDir: tempDir("managed-worktrees"), taskId: "task_5" });
    if (!made.ok) throw new Error(made.message);
    writeFileSync(join(made.worktree.path, "readme.txt"), "committed by the task\n", "utf8");
    git(made.worktree.path, ["commit", "-am", "task change"]);

    expect(await removeManagedWorktree({ repoPath: repo, path: made.worktree.path })).toEqual({ removed: true });
    expect(existsSync(made.worktree.path)).toBe(false);
    expect(git(repo, ["show", `${made.worktree.branch}:readme.txt`])).toBe("committed by the task");
  });

  it("keeps a worktree holding changes nobody committed", async () => {
    const repo = makeRepo();
    const made = await ensureManagedWorktree({ repoPath: repo, worktreesDir: tempDir("managed-worktrees"), taskId: "task_6" });
    if (!made.ok) throw new Error(made.message);
    writeFileSync(join(made.worktree.path, "readme.txt"), "not committed\n", "utf8");

    const removed = await removeManagedWorktree({ repoPath: repo, path: made.worktree.path });
    expect(removed.removed).toBe(false);
    expect(readFileSync(join(made.worktree.path, "readme.txt"), "utf8")).toBe("not committed\n");
  });
});

describe("finding what a stopped node left behind", () => {
  it("names each task's worktree with its repository, branch and whether it holds uncommitted changes", async () => {
    const repo = makeRepo();
    const worktreesDir = tempDir("managed-worktrees");
    const clean = await ensureManagedWorktree({ repoPath: repo, worktreesDir, taskId: "task_7" });
    const dirty = await ensureManagedWorktree({ repoPath: repo, worktreesDir, taskId: "task_8" });
    if (!clean.ok || !dirty.ok) throw new Error("test setup: worktrees were not made");
    writeFileSync(join(dirty.worktree.path, "readme.txt"), "not committed\n", "utf8");

    const found = (await findManagedWorktrees({ worktreesDir })).sort((a, b) => a.taskId.localeCompare(b.taskId));
    expect(found.map(({ taskId, branch, dirty: isDirty }) => ({ taskId, branch, dirty: isDirty }))).toEqual([
      { taskId: "task_7", branch: managedBranchFor("task_7"), dirty: false },
      { taskId: "task_8", branch: managedBranchFor("task_8"), dirty: true },
    ]);
    // The repository the worktree belongs to, so it can be removed through that repository's own git.
    expect(found.every((worktree) => git(worktree.repoPath, ["rev-parse", "--show-toplevel"]) === git(repo, ["rev-parse", "--show-toplevel"]))).toBe(true);
  });

  it("finds every repository's worktree of a task, and a task's worktree from before", async () => {
    const first = makeRepo(tempDir("managed-parent"));
    const second = makeRepo(tempDir("managed-parent"));
    const worktreesDir = tempDir("managed-worktrees");
    const a = await ensureManagedWorktree({ repoPath: first, worktreesDir, taskId: "task_multi" });
    const b = await ensureManagedWorktree({ repoPath: second, worktreesDir, taskId: "task_multi" });
    if (!a.ok || !b.ok) throw new Error("test setup: worktrees were not made");
    const earlier = join(worktreesDir, "task_earlier");
    git(first, ["worktree", "add", "-b", managedBranchFor("task_earlier"), earlier]);

    const found = await findManagedWorktrees({ worktreesDir });
    expect(found.map(({ taskId, path }) => ({ taskId, path })).sort((x, y) => x.path.localeCompare(y.path))).toEqual(
      [
        { taskId: "task_earlier", path: earlier },
        { taskId: "task_multi", path: a.worktree.path },
        { taskId: "task_multi", path: b.worktree.path },
      ].sort((x, y) => x.path.localeCompare(y.path)),
    );
  });

  it("takes a task's folder away only once nothing is left in it", async () => {
    const repo = makeRepo();
    const worktreesDir = tempDir("managed-worktrees");
    const made = await ensureManagedWorktree({ repoPath: repo, worktreesDir, taskId: "task_folder" });
    if (!made.ok) throw new Error(made.message);

    await removeEmptyTaskFolder({ worktreesDir, taskId: "task_folder" });
    expect(existsSync(made.worktree.path)).toBe(true);

    expect(await removeManagedWorktree({ repoPath: repo, path: made.worktree.path })).toEqual({ removed: true });
    await removeEmptyTaskFolder({ worktreesDir, taskId: "task_folder" });
    expect(existsSync(join(worktreesDir, "task_folder"))).toBe(false);
    // Already gone is not an error.
    await removeEmptyTaskFolder({ worktreesDir, taskId: "task_folder" });
  });

  it("ignores anything in the folder that is not a worktree git knows about", async () => {
    const worktreesDir = tempDir("managed-worktrees");
    mkdirSync(join(worktreesDir, "stray-folder"));
    writeFileSync(join(worktreesDir, "stray-file.txt"), "x", "utf8");
    // A whole repository copied in is not a task's worktree either.
    const cloneParent = join(worktreesDir, "a-clone");
    mkdirSync(cloneParent);
    git(cloneParent, ["init", "--initial-branch=main"]);

    expect(await findManagedWorktrees({ worktreesDir })).toEqual([]);
    expect(await findManagedWorktrees({ worktreesDir: join(worktreesDir, "does-not-exist") })).toEqual([]);
  });
});