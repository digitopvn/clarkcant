import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireRepoLock,
  prepareWorktree,
  readRepoIdentity,
  readWorkingTree,
  verifyRepoLock,
} from "../src/worktree.ts";

/**
 * Repository safety (T15, T16).
 *
 * These run against real repositories created on disk and driven with real git. The properties
 * under test are properties of git's behaviour — that HEAD moves, that a stash is created, that an
 * untracked file survives — and a model of git would only agree with itself.
 */

const AT = "2026-09-16T06:00:00.000Z" as never;

let repos: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repository with one committed file and a deterministic identity. */
function makeRepo(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `clarkcant-${name}-`));
  repos.push(path);
  git(path, ["init", "--initial-branch=main"]);
  git(path, ["config", "user.email", "test@example.invalid"]);
  git(path, ["config", "user.name", "Test"]);
  writeFileSync(join(path, "readme.txt"), "original\n", "utf8");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "initial"]);
  return path;
}

function deps() {
  return { now: () => AT };
}

beforeEach(() => {
  repos = [];
});

afterEach(() => {
  for (const path of repos) rmSync(path, { recursive: true, force: true });
});

describe("a lock records the repository, not just the path (T15)", () => {
  it("reads the identity of a real repository", async () => {
    const repo = makeRepo("identity");
    const identity = await readRepoIdentity(repo);
    expect(identity.worktree).toBe(repo);
    expect(identity.branch).toBe("main");
    expect(identity.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(identity.worktreeCount).toBe(1);
  });

  it("accepts a lock while nothing has moved", async () => {
    const repo = makeRepo("stable");
    const lock = await acquireRepoLock(deps(), { taskId: "task_1", repoPath: repo });
    await expect(verifyRepoLock(lock)).resolves.toEqual({ valid: true });
  });

  it("catches HEAD moving under a running task", async () => {
    const repo = makeRepo("moved");
    const lock = await acquireRepoLock(deps(), { taskId: "task_1", repoPath: repo });

    // Somebody else commits while the task holds the lock, so the plan was built for other content.
    writeFileSync(join(repo, "readme.txt"), "changed by someone else\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "a change the task never read"]);

    const verdict = await verifyRepoLock(lock);
    expect(verdict.valid).toBe(false);
    expect(verdict.valid === false && verdict.code).toBe("COMMON_REF_MOVED");
    expect(verdict.valid === false && verdict.reason).toContain("HEAD moved");
  });

  it("catches the same path belonging to a different repository", async () => {
    const repo = makeRepo("original");
    const lock = await acquireRepoLock(deps(), { taskId: "task_1", repoPath: repo });
    const elsewhere = join(repo, "..", "a-different-repository");

    // A path can stay the same while the repository behind it does not: once the path is a
    // worktree of another repository, `.git` is a file pointing somewhere else. The runner is
    // injected here because producing that state needs a second checkout, and the claim under
    // test is the comparison rather than git's ability to create it.
    const verdict = await verifyRepoLock(lock, {
      git: async (args, cwd) => {
        if (args.join(" ") === "rev-parse --git-common-dir") return elsewhere;
        return git(cwd, [...args]);
      },
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.valid === false && verdict.code).toBe("COMMON_REF_MOVED");
    // A lock keyed on the path alone would not notice this at all.
    expect(verdict.valid === false && verdict.reason).toContain("different repository");
  });

  it("does not treat a detached HEAD as a branch named HEAD", async () => {
    const repo = makeRepo("detached");
    git(repo, ["checkout", "--detach", "HEAD"]);
    const identity = await readRepoIdentity(repo);
    expect(identity.branch).toBeUndefined();
  });
});

describe("a dirty working tree is refused, never cleaned (T16)", () => {
  it("refuses an uncommitted edit and names the file", async () => {
    const repo = makeRepo("dirty");
    const lock = await acquireRepoLock(deps(), { taskId: "task_1", repoPath: repo });
    writeFileSync(join(repo, "readme.txt"), "work in progress that exists nowhere else\n", "utf8");

    const outcome = await prepareWorktree(lock);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("DIRTY_WORKTREE");
    expect(outcome.ok === false && "changed" in outcome && outcome.changed.join(" ")).toContain(
      "readme.txt",
    );
  });

  it("refuses an untracked file too, because it is also work that exists nowhere else", async () => {
    const repo = makeRepo("untracked");
    const lock = await acquireRepoLock(deps(), { taskId: "task_1", repoPath: repo });
    writeFileSync(join(repo, "new-file.txt"), "not committed anywhere\n", "utf8");

    const outcome = await prepareWorktree(lock);

    expect(outcome.ok === false && outcome.code).toBe("DIRTY_WORKTREE");
    expect(outcome.ok === false && "changed" in outcome && outcome.changed.join(" ")).toContain(
      "new-file.txt",
    );
  });

  it("leaves the user's edit exactly as it was", async () => {
    const repo = makeRepo("preserved");
    const lock = await acquireRepoLock(deps(), { taskId: "task_1", repoPath: repo });
    const userText = "work in progress that exists nowhere else\n";
    writeFileSync(join(repo, "readme.txt"), userText, "utf8");

    await prepareWorktree(lock);

    // This is the assertion that matters: refusing is only correct if nothing was touched.
    expect(readFileSync(join(repo, "readme.txt"), "utf8")).toBe(userText);
    // And no stash was quietly created, which is the other way this goes wrong.
    expect(git(repo, ["stash", "list"])).toBe("");
  });

  it("does not commit, checkout or reset anything while refusing", async () => {
    const repo = makeRepo("untouched");
    const lock = await acquireRepoLock(deps(), { taskId: "task_1", repoPath: repo });
    const before = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "readme.txt"), "edit\n", "utf8");

    await prepareWorktree(lock);

    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(repo, ["log", "--oneline"]).split("\n")).toHaveLength(1);
  });

  it("allows a clean tree", async () => {
    const repo = makeRepo("clean");
    const lock = await acquireRepoLock(deps(), { taskId: "task_1", repoPath: repo });
    const outcome = await prepareWorktree(lock);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.identity.headSha).toBe(lock.identity.headSha);
  });

  it("refuses on the lock before it even looks at the tree", async () => {
    const repo = makeRepo("stale-lock");
    const lock = await acquireRepoLock(deps(), { taskId: "task_1", repoPath: repo });
    writeFileSync(join(repo, "readme.txt"), "someone else's commit\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "moved"]);

    const outcome = await prepareWorktree(lock);

    // A stale lock means the repository is not the one the task read, so the tree state is not
    // the interesting question any more.
    expect(outcome.ok === false && outcome.code).toBe("LOCK_INVALID");
  });

  it("reports a clean tree as clean", async () => {
    const repo = makeRepo("status");
    const state = await readWorkingTree(repo);
    expect(state).toEqual({ changed: [], clean: true });
  });
});
