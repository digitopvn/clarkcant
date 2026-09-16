/**
 * Repository safety.
 *
 * Two rules, both about what a task must not do to somebody else's working tree:
 *
 *   1. **A lock records the repository identity, not just a path.** A path stays the same while
 *      everything behind it moves: another process checks out a branch, a worktree is re-pointed,
 *      a fetch moves the branch tip. A lock that only remembers a directory is a lock that will
 *      happily operate on a repository it never looked at.
 *   2. **A dirty tree is refused, never cleaned.** `git reset --hard` and `git stash` discard work
 *      that is not ours and that may not be committed anywhere. Refusing costs a retry; cleaning
 *      costs somebody their afternoon.
 *
 * This module shells out to real `git` rather than modelling it, because the properties under test
 * are properties of git's behaviour and a model would only agree with itself.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

import type { Instant } from "@clarkcant/contracts";

const run = promisify(execFile);

export interface RepoSafetyDeps {
  now: () => Instant;
}

export interface RepoIdentity {
  /** Absolute path to the working tree root. */
  worktree: string;
  /** Absolute path to the shared git directory. Differs per worktree. */
  commonDir: string;
  /** How many worktrees share this common directory. */
  worktreeCount: number;
  /** Branch name, or `undefined` when HEAD is detached. */
  branch: string | undefined;
  /** The commit HEAD points at. */
  headSha: string;
}

export interface RepoLock {
  taskId: string;
  repoPath: string;
  identity: RepoIdentity;
  acquiredAt: Instant;
}

export interface RepoSafetyOptions {
  /** Injected for tests; defaults to running the real `git`. */
  git?: (args: readonly string[], cwd: string) => Promise<string>;
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd, encoding: "utf8" });
  return stdout.trim();
}

function runner(options: RepoSafetyOptions): (args: readonly string[], cwd: string) => Promise<string> {
  return options.git ?? git;
}

/**
 * Read what a repository actually is right now.
 *
 * Every value here can change while a task is running, which is why the lock stores them rather
 * than a path.
 */
export async function readRepoIdentity(
  repoPath: string,
  options: RepoSafetyOptions = {},
): Promise<RepoIdentity> {
  const gitRun = runner(options);
  const root = resolve(repoPath);

  // Throws if the path is not a repository, which is the right outcome: an unknown repository is
  // not a repository we may operate on.
  const commonDir = resolve(root, await gitRun(["rev-parse", "--git-common-dir"], root));
  const headSha = await gitRun(["rev-parse", "HEAD"], root);
  const branchName = await gitRun(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const listed = await gitRun(["worktree", "list", "--porcelain"], root);
  const worktreeCount = listed.split("\n").filter((line) => line.startsWith("worktree ")).length;

  return {
    worktree: root,
    commonDir,
    worktreeCount,
    branch: branchName === "HEAD" ? undefined : branchName,
    headSha,
  };
}

/** Record the repository a task is about to work in. */
export async function acquireRepoLock(
  deps: RepoSafetyDeps,
  input: { taskId: string; repoPath: string } & RepoSafetyOptions,
): Promise<RepoLock> {
  return {
    taskId: input.taskId,
    repoPath: resolve(input.repoPath),
    identity: await readRepoIdentity(input.repoPath, input),
    acquiredAt: deps.now(),
  };
}

export type LockVerdict =
  | { valid: true }
  | {
      valid: false;
      code: "COMMON_REF_MOVED";
      /** What the lock recorded. */
      expected: string;
      /** What the repository says now. */
      actual: string;
      reason: string;
    };

/**
 * Check that the repository is still the one the lock was taken against (T15).
 *
 * The comparison is on the shared git directory and the commit at HEAD, not on the path. A branch
 * that moved under a running task means the task's plan was built for different content, so the
 * task must stop rather than continue against something it never read.
 */
export async function verifyRepoLock(
  lock: RepoLock,
  options: RepoSafetyOptions = {},
): Promise<LockVerdict> {
  const current = await readRepoIdentity(lock.repoPath, options);

  if (current.commonDir !== lock.identity.commonDir) {
    return {
      valid: false,
      code: "COMMON_REF_MOVED",
      expected: lock.identity.commonDir,
      actual: current.commonDir,
      reason: `the path ${lock.repoPath} now belongs to a different repository (${current.commonDir} instead of ${lock.identity.commonDir})`,
    };
  }

  if (current.headSha !== lock.identity.headSha) {
    return {
      valid: false,
      code: "COMMON_REF_MOVED",
      expected: lock.identity.headSha,
      actual: current.headSha,
      reason: `HEAD moved from ${lock.identity.headSha.slice(0, 12)} to ${current.headSha.slice(0, 12)} while this task held the lock`,
    };
  }

  return { valid: true };
}

export interface WorkingTreeState {
  /** Paths with uncommitted changes, including untracked ones. */
  changed: string[];
  clean: boolean;
}

/** Read the working tree state, including untracked files. */
export async function readWorkingTree(
  repoPath: string,
  options: RepoSafetyOptions = {},
): Promise<WorkingTreeState> {
  const gitRun = runner(options);
  const output = await gitRun(["status", "--porcelain"], resolve(repoPath));
  const changed = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { changed, clean: changed.length === 0 };
}

export type PrepareOutcome =
  | { ok: true; identity: RepoIdentity }
  | {
      ok: false;
      code: "DIRTY_WORKTREE";
      changed: string[];
      message: string;
    }
  | {
      ok: false;
      code: "LOCK_INVALID";
      reason: string;
    };

/**
 * Decide whether a task may start work in this repository (T15, T16).
 *
 * A dirty tree is refused outright. There is deliberately no option to clean it, because a
 * "clean it first" flag is the flag somebody eventually passes by default, and the work it
 * destroys is uncommitted work belonging to a person.
 */
export async function prepareWorktree(
  lock: RepoLock,
  options: RepoSafetyOptions = {},
): Promise<PrepareOutcome> {
  const verdict = await verifyRepoLock(lock, options);
  if (!verdict.valid) {
    return { ok: false, code: "LOCK_INVALID", reason: verdict.reason };
  }

  const state = await readWorkingTree(lock.repoPath, options);
  if (!state.clean) {
    return {
      ok: false,
      code: "DIRTY_WORKTREE",
      changed: state.changed,
      message: `the working tree has ${state.changed.length} uncommitted change(s); commit or move them before a task runs here, because stashing or resetting them would discard work that may exist nowhere else`,
    };
  }

  return { ok: true, identity: lock.identity };
}

/** Where a task's own changes are allowed to land, so it never works in the user's tree. */
export function suggestedWorktreePath(identity: RepoIdentity, taskId: string): string {
  return resolve(identity.commonDir, "..", `.clarkcant-worktree-${taskId}`);
}

export const WORKTREE_STATUS = "implemented-real-git";
