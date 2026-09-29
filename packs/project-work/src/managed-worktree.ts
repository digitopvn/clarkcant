/**
 * A task's own worktree, kept by the node.
 *
 * A task that changes a repository never works in the tree a person is editing. The node makes a worktree of the
 * repository's current commit under its own data directory, on a branch named for the task, and the worker is given
 * that and nothing else. What the person has uncommitted stays exactly where it is, because nothing here reads or
 * writes their tree beyond asking git what it is.
 *
 * `suggestedWorktreePath` in `worktree.ts` places a worktree beside the repository, inside the person's folder; that is
 * the reason this module exists rather than a caller of that function.
 */

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { readRepoIdentity, type RepoIdentity, type RepoSafetyOptions } from "./worktree.ts";

const run = promisify(execFile);

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd, encoding: "utf8", windowsHide: true });
  return stdout.trim();
}

export interface ManagedWorktree {
  taskId: string;
  /** The repository the person named. Never written to except through git's own worktree bookkeeping. */
  repoPath: string;
  /** The worktree the worker is given. */
  path: string;
  branch: string;
  /** The commit the worktree started from. */
  baseSha: string;
  /** True when a worktree for this task already existed and was reused, as after an approval or a restart. */
  reused: boolean;
}

export type ManagedWorktreeOutcome =
  | { ok: true; worktree: ManagedWorktree }
  | { ok: false; code: "NOT_A_REPOSITORY" | "WORKTREE_FAILED"; message: string };

/** A task id as a directory and branch name: nothing a shell or git would read as syntax. */
function safeName(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
}

export function managedBranchFor(taskId: string): string {
  return `clarkcant/task-${safeName(taskId)}`;
}

export function managedWorktreePath(worktreesDir: string, taskId: string): string {
  return join(resolve(worktreesDir), safeName(taskId));
}

async function branchExists(gitRun: NonNullable<RepoSafetyOptions["git"]>, repo: string, branch: string): Promise<boolean> {
  try {
    await gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
    return true;
  } catch {
    return false;
  }
}

/** Whether git lists this path as one of the repository's worktrees. */
async function isRegisteredWorktree(
  gitRun: NonNullable<RepoSafetyOptions["git"]>,
  repo: string,
  path: string,
): Promise<boolean> {
  const listed = await gitRun(["worktree", "list", "--porcelain"], repo);
  const wanted = canonical(path);
  return listed
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .some((line) => canonical(line.slice("worktree ".length).trim()) === wanted);
}

/**
 * One spelling of a path, so git's (forward slashes, long names) and ours compare equal. Case-folded on Windows and
 * macOS, whose default filesystems do not tell the cases apart.
 */
function canonical(path: string): string {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    real = resolve(path);
  }
  return process.platform === "linux" ? real : real.toLowerCase();
}

/**
 * Give a task its own worktree of a repository, or the one it already has.
 *
 * Reused rather than recreated when it exists: a task parked for an approval and dispatched again, or one resumed
 * after a restart, continues from what it already did instead of losing it.
 */
export async function ensureManagedWorktree(
  input: { repoPath: string; worktreesDir: string; taskId: string } & RepoSafetyOptions,
): Promise<ManagedWorktreeOutcome> {
  const gitRun = input.git ?? git;
  let identity: RepoIdentity;
  try {
    identity = await readRepoIdentity(input.repoPath, { git: gitRun });
  } catch (cause) {
    return {
      ok: false,
      code: "NOT_A_REPOSITORY",
      message: `${input.repoPath} is not a git repository this node can read (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }

  const repo = identity.worktree;
  const branch = managedBranchFor(input.taskId);
  const path = managedWorktreePath(input.worktreesDir, input.taskId);

  try {
    if (existsSync(path) && (await isRegisteredWorktree(gitRun, repo, path))) {
      const baseSha = await gitRun(["rev-parse", "HEAD"], path);
      return { ok: true, worktree: { taskId: input.taskId, repoPath: repo, path, branch, baseSha, reused: true } };
    }
    await mkdir(resolve(input.worktreesDir), { recursive: true });
    // A branch left from an earlier attempt whose directory is gone is checked out again rather than replaced: it may
    // hold commits the task made.
    if (await branchExists(gitRun, repo, branch)) {
      await gitRun(["worktree", "prune"], repo);
      await gitRun(["worktree", "add", path, branch], repo);
    } else {
      await gitRun(["worktree", "add", "-b", branch, path, identity.headSha], repo);
    }
    return {
      ok: true,
      worktree: { taskId: input.taskId, repoPath: repo, path, branch, baseSha: identity.headSha, reused: false },
    };
  } catch (cause) {
    return {
      ok: false,
      code: "WORKTREE_FAILED",
      message: `git could not make a worktree of ${repo} for this task (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
}

export type RemoveOutcome = { removed: true } | { removed: false; reason: string };

/**
 * Take a finished task's worktree away, keeping its branch.
 *
 * Without `--force`: a worktree with changes nobody committed is left where it is and said so, because those changes
 * exist nowhere else. The branch stays either way, so what the task committed is still in the repository.
 */
export async function removeManagedWorktree(
  input: { repoPath: string; path: string } & RepoSafetyOptions,
): Promise<RemoveOutcome> {
  const gitRun = input.git ?? git;
  try {
    await gitRun(["worktree", "remove", input.path], resolve(input.repoPath));
    return { removed: true };
  } catch (cause) {
    return { removed: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
