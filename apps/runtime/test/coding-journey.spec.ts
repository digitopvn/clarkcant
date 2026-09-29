import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_POLICY_CONFIG, type Instant, type MessageRecord } from "@clarkcant/contracts";
import { registerCapability } from "@clarkcant/core";
import { CONTROLLED_CODE_TASK, managedBranchFor, managedWorktreePath } from "@clarkcant/project-work";
import {
  allRows,
  appendAuditEvent,
  effectsForTask,
  listAuditEvents,
  parseJson,
  type AuditKind,
  type AuditOutcome,
} from "@clarkcant/storage";

import { createAutomationTools } from "../src/automation-tools.ts";
import { startAutomationService, type AutomationService } from "../src/automation-service.ts";
import { COMMAND_STOPPED_ON_REQUEST, sweepUnknownEffects } from "../src/effect-notices.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import type { CommandToolDeps } from "../src/node-tools.ts";
import { ownedResources } from "../src/preflight.ts";
import { listRunningCommands } from "../src/run-command.ts";
import { createSecretBroker } from "../src/secret-broker.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createTaskDispatcher, type TaskDispatcher } from "../src/task-dispatch.ts";
import { taskDispatchReports } from "../src/task-reporting.ts";
import { runWorkerProcess } from "../src/worker-process.ts";

/**
 * A labelled issue, all the way to a draft pull request.
 *
 * Everything on this side of GitHub is the node's own: the signed webhook route, the standing request a person set up
 * in the conversation, the automation service, the dispatcher, a real worker process whose model is scripted, the
 * command path that decides and runs what the worker asks for, the secret broker, git, and the worktree the task works
 * in. Only GitHub is replaced: the repository's pushes go to a local bare remote, and `gh` is a shim on the command
 * path that records how it was called and answers with a pull request's address.
 */

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "packages", "signal-sources", "test", "fixtures", "github");
const WEBHOOK_SECRET = "shared with the repository webhook";
const PR_URL = "https://github.com/Codertocat/Hello-World/pull/42";

let dir: string;
let services: NodeServices;
let automation: AutomationService;
let dispatcher: TaskDispatcher;
let token: string;
let originalPath: string | undefined;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A clone of Codertocat/Hello-World whose pushes land in a bare repository beside it, with a failing test. */
function makeCheckout(): { checkout: string; bare: string } {
  const bare = join(dir, "remote.git");
  git(dir, ["init", "--bare", "--initial-branch=main", bare]);
  const checkout = join(dir, "hello-world");
  mkdirSync(checkout, { recursive: true });
  git(checkout, ["init", "--initial-branch=main"]);
  git(checkout, ["config", "user.email", "clark@example.invalid"]);
  git(checkout, ["config", "user.name", "Clark"]);
  git(checkout, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(checkout, "greet.mjs"), 'export const greet = (name) => `Hello ${name}`;\n', "utf8");
  writeFileSync(
    join(checkout, "greet.test.mjs"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { greet } from "./greet.mjs";',
      'test("greets with a comma", () => assert.equal(greet("Mona"), "Hello, Mona"));',
      "",
    ].join("\n"),
    "utf8",
  );
  git(checkout, ["add", "."]);
  git(checkout, ["commit", "-m", "initial"]);
  // Fetched from GitHub, pushed to the bare repository: the check reads the first, git push uses the second.
  git(checkout, ["remote", "add", "origin", "git@github.com:Codertocat/Hello-World.git"]);
  git(checkout, ["config", "remote.origin.pushurl", bare]);
  git(checkout, ["push", "origin", "main"]);

  // Which token reached `git push`, as a digest: a hook runs in the push's own environment.
  const hookScript = join(dir, "pre-push.mjs");
  writeFileSync(
    hookScript,
    [
      'import { appendFileSync } from "node:fs";',
      'import { createHash } from "node:crypto";',
      "const token = process.env.GH_TOKEN;",
      `appendFileSync(${JSON.stringify(join(dir, "push-tokens.log"))}, (token === undefined ? "none" : createHash("sha256").update(token).digest("hex")) + "\\n");`,
      "",
    ].join("\n"),
    "utf8",
  );
  const hook = join(checkout, ".git", "hooks", "pre-push");
  writeFileSync(hook, `#!/bin/sh\nexec node "${hookScript.split("\\").join("/")}"\n`, "utf8");
  chmodSync(hook, 0o755);
  return { checkout, bare };
}

/** `gh` for this node's commands: records its arguments and a digest of the token it was given, never the token. */
function installGhShim(): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh-shim.mjs"),
    [
      'import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";',
      'import { createHash } from "node:crypto";',
      'import { dirname, join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "const args = process.argv.slice(2);",
      "const token = process.env.GH_TOKEN;",
      "const record = { args, cwd: process.cwd(), token: token === undefined ? null : createHash(\"sha256\").update(token).digest(\"hex\") };",
      "const here = dirname(fileURLToPath(import.meta.url));",
      'appendFileSync(join(here, "calls.jsonl"), JSON.stringify(record) + "\\n");',
      // A GitHub that takes the request and never answers, while a test has left `hang` beside the shim.
      'if (args[0] === "pr" && args[1] === "create" && existsSync(join(here, "hang"))) { writeFileSync(join(here, "hanging.pid.tmp"), String(process.pid)); renameSync(join(here, "hanging.pid.tmp"), join(here, "hanging.pid")); setInterval(() => {}, 1000); }',
      `else if (args[0] === "pr" && args[1] === "create") { process.stdout.write(${JSON.stringify(`${PR_URL}\n`)}); process.exit(0); }`,
      'else { process.stderr.write("gh shim: unexpected call\\n"); process.exit(1); }',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(bin, "gh.cmd"), '@echo off\r\nnode "%~dp0gh-shim.mjs" %*\r\n', "utf8");
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nexec node "$(dirname "$0")/gh-shim.mjs" "$@"\n', "utf8");
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function ghCalls(): { args: string[]; cwd: string; token: string | null }[] {
  const log = join(dir, "bin", "calls.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { args: string[]; cwd: string; token: string | null });
}

async function authed(method: string, path: string, body?: unknown) {
  const deps: GatewayDeps = { services, now: () => new Date().toISOString() };
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

function assistantTexts(conversationId: string): string[] {
  return allRows<{ document: string }>(
    services.runtime.db,
    "SELECT document FROM messages WHERE conversation_id = ? ORDER BY sequence",
    conversationId,
  ).flatMap((row) => {
    const message = parseJson<MessageRecord>(row.document, "messages.document");
    if (message.role !== "assistant") return [];
    return message.blocks.flatMap((block) => (block.type === "text" ? [block.content] : []));
  });
}

async function waitUntil<T>(read: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The pid of the `gh` that took a pull request and never answered, once it is running.
 *
 * It is the `node` the shim runs: the leaf of the tree a stop ends, on POSIX through `exec` in the shell script and on
 * Windows as the batch file's child. The shim writes the file whole with a rename, so a read never sees half of it.
 */
function hangingGhPid(): number | undefined {
  const file = join(dir, "bin", "hanging.pid");
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8"));
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a process that exists and belongs to somebody else; only "no such process" is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function commandDeps(): CommandToolDeps {
  const { db, identity } = services.runtime;
  const audit = (kind: AuditKind) => (event: { summary: string; outcome?: AuditOutcome; ref?: string }) =>
    appendAuditEvent(db, {
      auditId: services.conductor.newId("audit"),
      principalId: identity.ownerPrincipalId,
      nodeId: identity.nodeId,
      kind,
      summary: event.summary,
      outcome: event.outcome ?? "done",
      ...(event.ref === undefined ? {} : { ref: event.ref }),
      at: new Date().toISOString() as Instant,
    });
  return {
    autonomy: () => ({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "autonomous" }),
    resources: () => ownedResources([dir]),
    fallbackCwd: () => dir,
    guardrails: async () => ({ status: "allow" }),
    newId: () => services.conductor.newId("run"),
    broker: createSecretBroker({
      db,
      principalId: identity.ownerPrincipalId,
      now: () => new Date().toISOString() as Instant,
      audit: audit("secret-use"),
    }),
    audit: audit("command"),
  };
}

/** What the scripted model does, in the order a model would: fix, test, commit, push, open the pull request. */
function writeScript(testCommand: string): string {
  const path = join(dir, "script.json");
  writeFileSync(
    path,
    JSON.stringify([
      {
        callTools: [
          {
            name: "write_project_file",
            params: { path: "greet.mjs", contents: "export const greet = (name) => `Hello, ${name}`;\n" },
          },
          { name: "run_command", params: { command: testCommand, why: "run the tests" } },
          { name: "run_command", params: { command: "git commit -am fix-greeting", why: "commit the fix" } },
          {
            name: "run_command",
            params: { command: "git push origin HEAD", why: "publish the branch", secretRef: "github_token", secretEnvVar: "GH_TOKEN" },
          },
          {
            name: "run_command",
            params: {
              command: "gh pr create --draft --fill",
              why: "open a draft pull request",
              secretRef: "github_token",
              secretEnvVar: "GH_TOKEN",
            },
          },
        ],
        reply: "Opened a draft pull request.",
      },
    ]),
    "utf8",
  );
  return path;
}

async function setUp(testCommand: string): Promise<{ conversationId: string; checkout: string; bare: string }> {
  const { checkout, bare } = makeCheckout();
  const bin = installGhShim();
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  const script = writeScript(testCommand);

  registerCapability(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId },
    {
      ...CONTROLLED_CODE_TASK,
      executionNodeId: services.runtime.identity.nodeId as never,
      readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
    },
  );
  dispatcher = createTaskDispatcher({
    conductor: services.conductor,
    projectRoots: () => [dir],
    ownedRoots: () => [dir],
    worktreesDir: () => join(dir, "worktrees"),
    commandDeps,
    ...taskDispatchReports(services),
    timeoutMs: 60_000,
    runWorker: (options) => runWorkerProcess({ ...options, scriptPath: script }),
  });
  services.conductor.runTask = (input) => dispatcher.dispatch(input);

  const stored = await authed("POST", "/credentials", {
    fields: [
      { name: "github_webhook_secret", value: WEBHOOK_SECRET, kind: "webhook-secret", consumer: "signals:github" },
      { name: "github_token", value: token, kind: "token", consumer: "command:gh,command:git" },
    ],
  });
  expect(stored.status).toBe(201);

  const created = await authed("POST", "/conversations", { title: "Hello-World" });
  const conversationId = (created.body as { conversationId: string }).conversationId;
  const tool = createAutomationTools({
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    principalId: services.runtime.identity.ownerPrincipalId,
    conversationId,
    now: () => new Date().toISOString() as Instant,
    newId: services.conductor.newId,
    ownedRoots: () => [dir],
    kick: () => undefined,
  }).find((candidate) => candidate.name === "create_automation");
  const answer = (await tool?.execute({
    summary: "Sửa issue có nhãn bug và mở draft PR",
    topic: "github.issue.labeled",
    match: [
      { path: "payload.label", op: "equals", value: "bug" },
      { path: "subject.refs.repository", op: "equals", value: "Codertocat/Hello-World" },
    ],
    action: "task",
    goal: "Fix the labelled issue, run the tests, push a branch and open a draft pull request.",
    repositories: [checkout],
    allowedEffects: ["read", "local-write", "external-write"],
    githubSelfLogins: ["clark-bot"],
  } as never)) as { text: string } | undefined;
  expect(answer?.text).toContain("Set up.");
  return { conversationId, checkout, bare };
}

async function labelIssue(): Promise<void> {
  const body = readFileSync(join(FIXTURES, "issues.labeled.json"));
  const response = await handleRequest(
    { services, now: () => new Date().toISOString() },
    {
      method: "POST",
      path: "/signals/github",
      query: {},
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "journey-1",
        "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
      },
      body: body.toString("utf8"),
      rawBody: body,
    },
  );
  expect(response.status).toBe(202);
  automation.tick();
}

function taskIdOfRun(): string | undefined {
  return allRows<{ task_id: string }>(services.runtime.db, "SELECT task_id FROM intent_runs")[0]?.task_id;
}

/** Every file under the node's folder except its database, where the credential store rightly holds the value. */
function filesOutsideTheStore(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      if (name === ".git" || name === "objects") continue;
      found.push(...filesOutsideTheStore(path));
    } else if (!/\.(db|sqlite)(-wal|-shm|-journal)?$/i.test(name)) {
      found.push(path);
    }
  }
  return found;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-coding-journey-"));
  services = bootNodeServices({ dataDir: dir, label: "coding journey node" });
  automation = startAutomationService(services, { intervalMs: 3_600_000 });
  services.automation = automation;
  // Made here, never written in this file: a value that matches no pattern and could only leak from the run itself.
  token = randomBytes(24).toString("hex");
  originalPath = process.env.PATH;
});

afterEach(() => {
  automation.stop();
  process.env.PATH = originalPath;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a labelled issue becomes a draft pull request", () => {
  it("fixes, tests, commits, pushes and opens the pull request in the task's own worktree, and says so", async () => {
    const { conversationId, checkout, bare } = await setUp("node --test");
    await labelIssue();

    const taskId = await waitUntil(taskIdOfRun, 10_000);
    const report = await waitUntil(
      () => assistantTexts(conversationId).find((text) => text.includes(`(task ${taskId}):`)),
      80_000,
    );
    // Said in the conversation where it was set up: it started, and then what it ended with — the pull request.
    expect(assistantTexts(conversationId).some((text) => text.includes(`task ${taskId} đang chạy`))).toBe(true);
    expect(report.startsWith(`Xong (task ${taskId}):`)).toBe(true);
    // The address is what `gh` printed, not something the model said.
    expect(report).toContain(`stdout:\n${PR_URL}`);

    // The fix is on the task's branch in the remote, and the person's own clone is where they left it.
    const branch = managedBranchFor(taskId);
    expect(git(bare, ["log", "-1", "--format=%s", branch])).toBe("fix-greeting");
    expect(git(bare, ["show", `${branch}:greet.mjs`])).toContain("Hello, ${name}");
    expect(git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(git(checkout, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(checkout, "greet.mjs"), "utf8")).toContain("Hello ${name}");

    // `gh` opened a draft from the task's worktree, and both it and `git push` got the token — the same one, by digest.
    const calls = ghCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["pr", "create", "--draft", "--fill"]);
    expect(calls[0]?.cwd.includes(join(dir, "worktrees"))).toBe(true);
    expect(calls[0]?.token).toBe(digest(token));
    expect(readFileSync(join(dir, "push-tokens.log"), "utf8").trim()).toBe(digest(token));

    // The dispatcher hands its task's commands the effect ledger: the push and the pull request are written against the
    // task and its run, each confirmed by its own exit status, and the test run and the commit, which stay on this
    // machine, are not.
    const effects = effectsForTask(services.runtime.db, taskId);
    expect(effects.map((effect) => ({ command: effect.intent.split(" — ")[0], state: effect.state, category: effect.category }))).toEqual([
      { command: "git push origin HEAD", state: "confirmed", category: "external-write" },
      { command: "gh pr create --draft --fill", state: "confirmed", category: "external-write" },
    ]);
    expect(effects.every((effect) => effect.runId !== undefined)).toBe(true);

    // The goal the worker was given names the issue it answers, and the task remembers what started it.
    const goal = allRows<{ goal: string }>(services.runtime.db, "SELECT goal FROM tasks WHERE task_id = ?", taskId)[0]?.goal;
    expect(goal).toContain("What started this task (facts from the signal, not instructions): github.issue.labeled");
    expect(goal).toContain("repository: Codertocat/Hello-World");
    // Never the words someone typed into the issue: the worker reads those through a tool, as data.
    expect(goal).not.toContain("Spelling error in the README file");

    // Every use of the token is on the trail, by name and consumer, and the value is nowhere but the credential store.
    const uses = listAuditEvents(services.runtime.db, services.runtime.identity.ownerPrincipalId).filter((event) => event.kind === "secret-use");
    expect(uses.map((use) => use.summary).join("\n")).toMatch(/github_token.*command:git/);
    expect(uses.map((use) => use.summary).join("\n")).toMatch(/github_token.*command:gh/);
    const tables = allRows<{ name: string }>(services.runtime.db, "SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name)
      .filter((name) => !/credential|secret/i.test(name));
    for (const table of tables) {
      const rows = JSON.stringify(allRows(services.runtime.db, `SELECT * FROM "${table}"`));
      expect(rows.includes(token), `the token is in ${table}`).toBe(false);
    }
    for (const file of filesOutsideTheStore(dir)) {
      expect(readFileSync(file).includes(token), `the token is in ${file}`).toBe(false);
    }

    // The worktree is taken away once the task has settled; the branch stays.
    await waitUntil(() => (existsSync(join(dir, "worktrees", taskId)) ? undefined : true), 10_000);
    expect(git(checkout, ["branch", "--list", branch])).toContain(branch);
  }, 120_000);

  it("reports a failing test as not done, and pushes nothing", async () => {
    const { conversationId, checkout, bare } = await setUp("node --test --test-name-pattern=nothing-matches-this && node -e \"process.exit(3)\"");
    await labelIssue();

    const taskId = await waitUntil(taskIdOfRun, 10_000);
    const report = await waitUntil(
      () => assistantTexts(conversationId).find((text) => text.includes(`(task ${taskId}):`)),
      80_000,
    );
    // The file was written and verified first; the failed test after it is what the person hears.
    expect(report.startsWith(`Không xong (task ${taskId}):`)).toBe(true);
    expect(report).toContain("run_command failed");
    expect(git(bare, ["branch", "--list", managedBranchFor(taskId)])).toBe("");
    expect(ghCalls()).toEqual([]);
    // The fix it wrote was never committed, so its worktree is kept, and the person is told where.
    const kept = await waitUntil(() => assistantTexts(conversationId).find((text) => text.startsWith(`Task ${taskId} để lại`)), 10_000);
    const worktree = managedWorktreePath(join(dir, "worktrees"), taskId, checkout);
    expect(kept).toContain(worktree);
    expect(readFileSync(join(worktree, "greet.mjs"), "utf8")).toContain("Hello, ${name}");
  }, 120_000);

  it("stops the command it is running when the task is stopped, and says it stopped", async () => {
    const { conversationId, bare } = await setUp('node -e "setTimeout(() => {}, 60000)"');
    await labelIssue();

    const taskId = await waitUntil(taskIdOfRun, 10_000);
    await waitUntil(() => (listRunningCommands().some((running) => running.taskId === taskId) ? true : undefined), 40_000);
    expect(dispatcher.stop(taskId)).toBe(true);

    const report = await waitUntil(
      () => assistantTexts(conversationId).find((text) => text.includes(`(task ${taskId}):`)),
      30_000,
    );
    expect(report).toContain("stopped on request");
    // The command the worker asked the host for is ended by the same stop — a process tree takes a moment to go.
    await waitUntil(() => (listRunningCommands().some((running) => running.taskId === taskId) ? undefined : true), 15_000);
    expect(git(bare, ["branch", "--list", managedBranchFor(taskId)])).toBe("");
    expect(ghCalls()).toEqual([]);
    await waitUntil(() => assistantTexts(conversationId).find((text) => text.startsWith(`Task ${taskId} để lại`)), 10_000);
  }, 120_000);

  it("calls a pull request it was stopped in the middle of unknown, and tells the person once", async () => {
    const { conversationId } = await setUp("node --test");
    writeFileSync(join(dir, "bin", "hang"), "", "utf8");
    await labelIssue();

    const taskId = await waitUntil(taskIdOfRun, 10_000);
    // Stopped while `gh` has the request and has not answered: the push before it is done, the pull request may be.
    // The command being listed is not enough: the shell is up before `gh` is, and a stop that lands before `gh` has
    // started is a different moment — on POSIX it never writes its pid, and on Windows `taskkill /T` can walk the tree
    // before the batch file has started `node`, leaving a `gh` nobody stopped. So the stop waits for `gh` itself.
    await waitUntil(
      () => (listRunningCommands().some((running) => running.taskId === taskId && running.command.includes("gh pr create")) ? true : undefined),
      80_000,
    );
    const hangingPid = await waitUntil(hangingGhPid, 30_000);
    expect(dispatcher.stop(taskId)).toBe(true);

    const report = await waitUntil(
      () => assistantTexts(conversationId).find((text) => text.includes(`(task ${taskId}):`)),
      30_000,
    );
    // Not "cancelled": what it did outside may have landed, and the task says so.
    expect(report.startsWith(`Chưa rõ kết quả (task ${taskId}):`)).toBe(true);
    expect(
      effectsForTask(services.runtime.db, taskId).map((effect) => ({
        command: effect.intent.split(" — ")[0],
        state: effect.state,
        evidence: effect.reconciliationEvidence,
      })),
    ).toEqual([
      { command: "git push origin HEAD", state: "confirmed", evidence: "the command exited with status 0" },
      { command: "gh pr create --draft --fill", state: "unknown", evidence: COMMAND_STOPPED_ON_REQUEST },
    ]);

    // One warning, the effect's, whichever of the task's report and the sweep wrote it: not "the task stopped" and then
    // "something is unknown" for the one stop.
    sweepUnknownEffects(services, new Date().toISOString() as Instant);
    const aboutTheTask = allRows<{ source_kind: string; dedup_key: string; severity: string; title: string; body: string | null }>(
      services.runtime.db,
      "SELECT source_kind, dedup_key, severity, title, body FROM notifications WHERE subject LIKE ? ORDER BY rowid",
      `%${taskId}%`,
    );
    // The automation said, earlier, that it started this task; that is its own event and says nothing about the end.
    expect(aboutTheTask.filter((notice) => notice.source_kind === "automation").map((notice) => notice.severity)).toEqual(["info"]);
    const notices = aboutTheTask.filter((notice) => notice.source_kind !== "automation");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.dedup_key).toBe(`worker:${taskId}`);
    expect(notices[0]?.severity).toBe("warning");
    expect(notices[0]?.body).toContain("gh pr create --draft --fill");
    expect(notices[0]?.body).toContain("dừng theo yêu cầu");

    // Gone before the folder is removed: the `gh` that never answered, whose working directory is the task's worktree,
    // and the worktree itself, which the dispatcher takes away once the task has settled.
    await waitUntil(() => (listRunningCommands().some((running) => running.taskId === taskId) ? undefined : true), 15_000);
    try {
      await waitUntil(() => (isAlive(hangingPid) ? undefined : true), 15_000);
    } finally {
      // A stop that missed it fails the line above; the process is still ended so a failing run leaves nothing behind.
      if (isAlive(hangingPid)) process.kill(hangingPid, "SIGKILL");
    }
    await waitUntil(
      () =>
        !existsSync(join(dir, "worktrees", taskId)) ||
        assistantTexts(conversationId).some((text) => text.startsWith(`Task ${taskId} để lại`))
          ? true
          : undefined,
      15_000,
    );
  }, 120_000);
});
