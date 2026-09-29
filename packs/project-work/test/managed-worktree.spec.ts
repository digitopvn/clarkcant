import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureManagedWorktree,
  findManagedWorktrees,
  managedBranchFor,
  removeManagedWorktree,
} from "../src/managed-worktree.ts";

/**
 * A task's own worktree.
 *
 * Against real repositories and real git, for the same reason as `worktree.spec.ts`: what matters is what git does to
 * the person's tree, and a model of git would only agree with itself.
 */

let dirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tempDir(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `clarkcant-${name}-`));
  dirs.push(path);
  return path;
}

function makeRepo(): string {
  const path = tempDir("managed-repo");
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

afterEach(() => {
  for (const path of dirs) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

    const found = (await findManagedWorktrees({ worktreesDir })).sort((a, b) => a.name.localeCompare(b.name));
    expect(found.map(({ name, branch, dirty: isDirty }) => ({ name, branch, dirty: isDirty }))).toEqual([
      { name: "task_7", branch: managedBranchFor("task_7"), dirty: false },
      { name: "task_8", branch: managedBranchFor("task_8"), dirty: true },
    ]);
    // The repository the worktree belongs to, so it can be removed through that repository's own git.
    expect(found.every((worktree) => git(worktree.repoPath, ["rev-parse", "--show-toplevel"]) === git(repo, ["rev-parse", "--show-toplevel"]))).toBe(true);
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