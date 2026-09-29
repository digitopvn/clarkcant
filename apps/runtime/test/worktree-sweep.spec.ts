import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";
import { applyTaskEvent, createTask } from "@clarkcant/core";
import { ensureManagedWorktree } from "@clarkcant/project-work";
import { allRows, createConversation, listNotifications } from "@clarkcant/storage";

import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { sweepTaskWorktrees } from "../src/worktree-sweep.ts";

/**
 * What a node that stopped mid-task left in its worktree folder, tidied on the next boot.
 *
 * Against real git: whether a worktree is clean, and whether removing it leaves the branch, is git's answer.
 */

const AT = "2026-09-29T09:00:00.000Z" as Instant;
const CONVERSATION_ID = "conv_sweep";

let dir: string;
let services: NodeServices;
let repo: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function taskIn(state: "open" | "cancelled"): string {
  const task = createTask(services.conductor, {
    conversationId: CONVERSATION_ID as never,
    goal: "change the repository",
    principal: { principalId: services.runtime.identity.ownerPrincipalId, kind: "user", nodeId: services.runtime.identity.nodeId as never },
  });
  if (state === "cancelled") {
    applyTaskEvent(services.conductor, task.taskId, "cancel.requested");
    applyTaskEvent(services.conductor, task.taskId, "cancel.confirmed");
  }
  return task.taskId;
}

async function worktreeFor(taskId: string): Promise<{ path: string; branch: string }> {
  const made = await ensureManagedWorktree({ repoPath: repo, worktreesDir: join(dir, "worktrees"), taskId });
  if (!made.ok) throw new Error(made.message);
  return made.worktree;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-sweep-"));
  services = bootNodeServices({ dataDir: dir, label: "sweep node" });
  createConversation(services.runtime.db, { conversationId: CONVERSATION_ID, homeNodeId: services.runtime.identity.nodeId, at: AT });
  repo = join(dir, "repo");
  execFileSync("git", ["init", "--initial-branch=main", repo], { stdio: "ignore" });
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "readme.txt"), "original\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the worktrees a stopped node left behind", () => {
  it("removes a finished task's clean worktree and keeps its branch with what it committed", async () => {
    const taskId = taskIn("cancelled");
    const worktree = await worktreeFor(taskId);
    writeFileSync(join(worktree.path, "readme.txt"), "committed by the task\n", "utf8");
    git(worktree.path, ["commit", "-am", "task change"]);

    const sweep = await sweepTaskWorktrees(services, { worktreesDir: join(dir, "worktrees"), now: () => AT });

    expect(sweep).toEqual({ removed: [worktree.path], kept: [] });
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, ["show", `${worktree.branch}:readme.txt`])).toBe("committed by the task");
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toEqual([]);
  });

  it("keeps a finished task's worktree holding uncommitted changes, and says where it is once", async () => {
    const taskId = taskIn("cancelled");
    const worktree = await worktreeFor(taskId);
    writeFileSync(join(worktree.path, "readme.txt"), "not committed\n", "utf8");

    const first = await sweepTaskWorktrees(services, { worktreesDir: join(dir, "worktrees"), now: () => AT });
    await sweepTaskWorktrees(services, { worktreesDir: join(dir, "worktrees"), now: () => AT });

    expect(first).toEqual({ removed: [], kept: [{ taskId, path: worktree.path, branch: worktree.branch }] });
    expect(readFileSync(join(worktree.path, "readme.txt"), "utf8")).toBe("not committed\n");
    const notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    // Two boots, one pointer.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ conversationId: CONVERSATION_ID, severity: "warning" });
    // Where it is, said in the task's conversation — once.
    const said = allRows<{ document: string }>(services.runtime.db, "SELECT document FROM messages WHERE conversation_id = ?", CONVERSATION_ID)
      .map((row) => row.document)
      .filter((document) => document.includes("để lại thay đổi chưa commit"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(JSON.stringify(worktree.path).slice(1, -1));
  });

  it("leaves the worktree of a task that is still open, and of one this node has never heard of", async () => {
    const open = await worktreeFor(taskIn("open"));
    const unknown = await worktreeFor("task_from_another_database");

    const sweep = await sweepTaskWorktrees(services, { worktreesDir: join(dir, "worktrees"), now: () => AT });

    expect(sweep).toEqual({ removed: [], kept: [] });
    expect(existsSync(open.path)).toBe(true);
    expect(existsSync(unknown.path)).toBe(true);
  });

  it("does nothing on a node that has never made a worktree", async () => {
    expect(await sweepTaskWorktrees(services, { worktreesDir: join(dir, "worktrees") })).toEqual({ removed: [], kept: [] });
  });
});
