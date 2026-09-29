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
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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

/**
 * Where a task keeps its worktree of one repository: `<worktreesDir>/<taskId>/<repository>`.
 *
 * One folder per task, one worktree per repository inside it, so a task that changes several repositories gives each
 * its own. The repository's part is its folder name, for a person reading the path, and a short digest of where it is,
 * so two repositories that share a name do not share a worktree. The same repository gets the same path every time the
 * task is dispatched, which is what lets a task continue where it stopped.
 */
export function managedWorktreePath(worktreesDir: string, taskId: string, repoPath: string): string {
  const digest = createHash("sha256").update(canonical(repoPath)).digest("hex").slice(0, 8);
  const repoName = safeName(basename(resolve(repoPath))).slice(0, 40) || "repository";
  return join(taskFolder(worktreesDir, taskId), `${repoName}-${digest}`);
}

/** The folder holding a task's worktrees. Before a task could name several repositories, it was the worktree itself. */
function taskFolder(worktreesDir: string, taskId: string): string {
  return join(resolve(worktreesDir), safeName(taskId));
}

/**
 * Take away a task's folder once nothing is left in it.
 *
 * Only an empty folder goes: one still holding a worktree that was kept, or anything else, stays as it is.
 */
export async function removeEmptyTaskFolder(input: { worktreesDir: string; taskId: string }): Promise<void> {
  try {
    await rmdir(taskFolder(input.worktreesDir, input.taskId));
  } catch {
    // Not empty, or already gone: either way there is nothing for this to do.
  }
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
  const path = managedWorktreePath(input.worktreesDir, input.taskId, repo);
  // A task started before tasks could name several repositories has its worktree at the task's folder itself. It
  // continues there rather than in a second worktree, which git would refuse anyway: the branch is checked out there.
  const earlier = taskFolder(input.worktreesDir, input.taskId);

  try {
    for (const candidate of [path, earlier]) {
      if (existsSync(candidate) && (await isRegisteredWorktree(gitRun, repo, candidate))) {
        const baseSha = await gitRun(["rev-parse", "HEAD"], candidate);
        return {
          ok: true,
          worktree: { taskId: input.taskId, repoPath: repo, path: candidate, branch, baseSha, reused: true },
        };
      }
    }
    await mkdir(dirname(path), { recursive: true });
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

/** A worktree found under the node's worktree folder, as git describes it. */
export interface FoundWorktree {
  /** The task it was made for: the name of its task's folder (see `managedWorktreePath`). */
  taskId: string;
  path: string;
  repoPath: string;
  branch: string;
  /** Changes nobody committed, untracked files included: things that exist nowhere else. */
  dirty: boolean;
}

/**
 * The worktrees a previous process of this node left under its worktree folder.
 *
 * Only what git itself lists as a worktree of the repository it points back to is returned. A folder that is not one,
 * or whose repository has moved or forgotten it, is not the node's to judge and is left out rather than guessed at.
 */
export async function findManagedWorktrees(input: { worktreesDir: string } & RepoSafetyOptions): Promise<FoundWorktree[]> {
  const gitRun = input.git ?? git;
  const root = resolve(input.worktreesDir);
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const found: FoundWorktree[] = [];
  for (const taskId of names) {
    const folder = join(root, taskId);
    // A task's folder from before tasks could name several repositories is the worktree itself.
    const earlier = await describeWorktree(gitRun, taskId, folder);
    if (earlier !== undefined) {
      found.push(earlier);
      continue;
    }
    for (const path of subfolders(folder)) {
      const worktree = await describeWorktree(gitRun, taskId, path);
      if (worktree !== undefined) found.push(worktree);
    }
  }
  return found;
}

function subfolders(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(folder, entry.name));
  } catch {
    return [];
  }
}

/** The worktree at `path`, when git lists it as one of the repository it points back to. */
async function describeWorktree(
  gitRun: NonNullable<RepoSafetyOptions["git"]>,
  taskId: string,
  path: string,
): Promise<FoundWorktree | undefined> {
  try {
    const common = await gitRun(["rev-parse", "--git-common-dir"], path);
    const commonDir = isAbsolute(common) ? common : resolve(path, common);
    if (basename(commonDir) !== ".git") return undefined;
    const repoPath = dirname(commonDir);
    // Git lists only a worktree's own top folder, so a task's folder, whose git answers for something further up or
    // not at all, is not taken for one.
    if (!(await isRegisteredWorktree(gitRun, repoPath, path))) return undefined;
    const branch = await gitRun(["rev-parse", "--abbrev-ref", "HEAD"], path);
    const status = await gitRun(["status", "--porcelain"], path);
    return { taskId, path, repoPath, branch, dirty: status !== "" };
  } catch {
    return undefined;
  }
}