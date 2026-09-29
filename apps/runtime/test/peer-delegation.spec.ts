import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Instant, MessageRecord, PeerEnvelope, TaskRecord } from "@clarkcant/contracts";
import { createTask, registerCapability, startTaskHere } from "@clarkcant/core";
import { sendEnvelope } from "@clarkcant/node-link";
import { CONTROLLED_CODE_TASK } from "@clarkcant/project-work";
import { allRows, getGrant, getTask, nextOutboundSequence, parseJson, pendingOutbox, revokeGrant } from "@clarkcant/storage";

import { createAutomationTools } from "../src/automation-tools.ts";
import { startAutomationService } from "../src/automation-service.ts";
import { queueResult } from "../src/delegation.ts";
import { answerUncertain, settleUndeliveredTasks } from "../src/delegation-handlers.ts";
import { startPeerDelivery } from "../src/peer-signals.ts";
import { createTaskDispatcher } from "../src/task-dispatch.ts";
import { taskDispatchReports } from "../src/task-reporting.ts";
import { runWorkerProcess } from "../src/worker-process.ts";
import { recoverUnfinishedWork } from "../src/work-recovery.ts";
import { type LiveNode, call, identityOf, liveNodes, pair } from "./live-nodes.ts";

/**
 * A standing request on one Clark whose task runs on another.
 *
 * Two real nodes, paired the way a person pairs them, with real HTTP between them. On A the owner says "when this
 * happens, do it on the laptop"; on B, the laptop, its owner says what A may run there. The task runs on B by B's own
 * dispatcher and a real worker process, and A's own task settles on B's answer. What the tests are careful about is
 * that neither owner decides for the other: what runs on B is what both allowed, a refusal is said on both sides, and a
 * repeated or foreign message changes nothing.
 */

const nodes = liveNodes();

afterEach(async () => {
  watched.splice(0);
  for (const child of workers.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill();
  await nodes.stopAll();
});

/** The worker processes the stoppable runner started, so a test can see they ended and none outlives it. */
const workers: ChildProcess[] = [];

/**
 * A worker that keeps working until it is stopped: a real process, handed to the dispatcher the way a real worker is,
 * whose run ends only when that process does.
 */
function stoppableWorker(options: Parameters<typeof runWorkerProcess>[0]): Promise<never> {
  return new Promise((_, reject) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      stdio: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    workers.push(child);
    child.once("exit", () => reject(new Error("the worker ended")));
    options.onChild?.(child);
  });
}

interface Clark extends LiveNode {
  /** A folder this node owns, where work handed to it may run. */
  root: string;
}

/** What the worker on B does: write a file in the folder it was given, then say so. */
function writeScript(dir: string): string {
  const path = join(dir, "script.json");
  writeFileSync(
    path,
    JSON.stringify([
      {
        callTools: [{ name: "write_project_file", params: { path: "notes.md", contents: "viết từ máy bàn\n" } }],
        reply: "Wrote notes.md.",
      },
    ]),
    "utf8",
  );
  return path;
}

/** A node as `wireRuntime` starts it: its automation service, its delivery pass, and a dispatcher with a worker. */
async function startClark(label: string, options: { hang?: boolean; stoppable?: boolean } = {}): Promise<Clark> {
  let root = "";
  const node = await nodes.start(label, (services) => {
    root = join(services.runtime.dataDir, "work");
    mkdirSync(root, { recursive: true });
    services.automation = startAutomationService(services, { intervalMs: 3_600_000 });
    services.peerDelivery = startPeerDelivery(
      { db: services.runtime.db, identity: services.runtime.identity, now: () => new Date().toISOString() as Instant },
      { intervalMs: 3_600_000, log: () => undefined },
    );
    registerCapability(
      { db: services.runtime.db, nodeId: services.runtime.identity.nodeId },
      {
        ...CONTROLLED_CODE_TASK,
        executionNodeId: services.runtime.identity.nodeId as never,
        readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      },
    );
    const script = writeScript(services.runtime.dataDir);
    const dispatcher = createTaskDispatcher({
      conductor: services.conductor,
      projectRoots: () => [root],
      ownedRoots: () => [root],
      ownerPrincipalId: () => services.runtime.identity.ownerPrincipalId,
      ...taskDispatchReports(services),
      timeoutMs: 60_000,
      // A worker that never answers stands for a node that stopped while the task ran.
      runWorker:
        options.hang === true
          ? () => new Promise<never>(() => undefined)
          : options.stoppable === true
            ? stoppableWorker
            : (worker) => runWorkerProcess({ ...worker, scriptPath: script }),
    });
    services.conductor.runTask = (input) => dispatcher.dispatch(input);
    services.taskDispatch = dispatcher;
  });
  watched.push(node);
  return { ...node, root };
}

function tools(node: Clark, conversationId: string) {
  const all = createAutomationTools({
    db: node.services.runtime.db,
    nodeId: identityOf(node).nodeId,
    principalId: identityOf(node).ownerPrincipalId,
    ownerPrincipalId: identityOf(node).ownerPrincipalId,
    conversationId,
    now: () => new Date().toISOString() as Instant,
    newId: node.services.conductor.newId,
    ownedRoots: () => [node.root],
    kick: () => node.services.automation?.kick(),
    kickDelivery: () => node.services.peerDelivery?.kick(),
    fingerprint: identityOf(node).fingerprint,
  });
  return async (name: string, params: Record<string, unknown>): Promise<string> => {
    const tool = all.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return ((await tool.execute(params as never)) as { text: string }).text;
  };
}

async function conversation(node: LiveNode, title: string): Promise<string> {
  const response = await call(node, "/conversations", { body: { title }, token: node.token });
  expect(response.status).toBe(201);
  return String(response.body["conversationId"]);
}

function said(node: LiveNode, conversationId: string): string[] {
  return allRows<{ document: string }>(
    node.services.runtime.db,
    "SELECT document FROM messages WHERE conversation_id = ? ORDER BY sequence",
    conversationId,
  ).flatMap((row) => {
    const message = parseJson<MessageRecord>(row.document, "messages.document");
    return message.role === "assistant" ? message.blocks.flatMap((block) => (block.type === "text" ? [block.content] : [])) : [];
  });
}

function tasksOn(node: LiveNode): TaskRecord[] {
  return allRows<{ task_id: string }>(node.services.runtime.db, "SELECT task_id FROM tasks ORDER BY created_at").flatMap((row) => {
    const task = getTask(node.services.runtime.db, row.task_id);
    return task === undefined ? [] : [task];
  });
}

/** The nodes of the running test, for what a timeout says. */
const watched: LiveNode[] = [];

function state(node: LiveNode): string {
  const { db } = node.services.runtime;
  const outbox = allRows<{ document: string; attempts: number; acknowledged_at: string | null; last_error: string | null }>(db, "SELECT document, attempts, acknowledged_at, last_error FROM outbox").map(
    (row) => `${(JSON.parse(row.document) as PeerEnvelope).kind}:${String(row.attempts)}${row.acknowledged_at === null ? ` ${row.last_error ?? ""}` : "+ack"}`,
  );
  const runs = allRows<{ state: string; reason: string | null }>(db, "SELECT state, reason FROM intent_runs").map((row) => `${row.state}:${row.reason ?? ""}`);
  const inbox = allRows<{ kind: string; response: string | null }>(db, "SELECT kind, response FROM inbox").map((row) => `${row.kind}=${row.response ?? ""}`);
  return `${identityOf(node).label}: outbox [${outbox.join(", ")}] inbox [${inbox.join(", ")}] runs [${runs.join(", ")}] tasks [${tasksOn(node).map((task) => task.state).join(", ")}]`;
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${watched.map(state).join("\n")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function signal(node: LiveNode, key: string): Promise<void> {
  const sent = await call(node, "/signals", {
    body: {
      source: { kind: "local", sourceId: "notes" },
      topic: "local.note.requested",
      payload: {},
      occurredAt: new Date().toISOString(),
      dedupeKey: key,
    },
    token: node.token,
  });
  expect(sent.status).toBe(202);
}

/** A and B paired, with a conversation on each: the desk, and the laptop the desk hands work to. */
async function desks(): Promise<{ a: Clark; b: Clark; onA: string; onB: string }> {
  const a = await startClark("desk");
  const b = await startClark("laptop");
  await pair(a, b);
  return { a, b, onA: await conversation(a, "Ghi chú"), onB: await conversation(b, "Máy bàn") };
}

async function handToLaptop(a: Clark, b: Clark, onA: string, folders: unknown[], allowedEffects: string[]): Promise<void> {
  const text = await tools(a, onA)("create_automation", {
    summary: "Ghi chú trên laptop",
    topic: "local.note.requested",
    action: "task",
    goal: "Write notes.md with today's note.",
    folders,
    allowedEffects,
    executor: identityOf(b).nodeId,
  });
  expect(text).toContain("Set up.");
  expect(text).toContain(`It runs on ${identityOf(b).nodeId}`);
  // The grant travels as soon as it is written; B holds it before anything asks to run under it.
  await waitUntil(() => pendingOutbox(a.services.runtime.db).length === 0, "the grant to reach B");
}

describe("a task one Clark hands to another", { timeout: 60_000 }, () => {
  it("runs on the other node within what its owner allowed, and settles the sender's own task", async () => {
    const { a, b, onA, onB } = await desks();
    const allowed = await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    expect(allowed).toContain("may now run the tasks it hands over here");
    expect(await tools(b, onB)("list_peers", {})).toContain(`${identityOf(a).nodeId} · fingerprint`);
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);

    await signal(a, "note-1");

    await waitUntil(() => said(a, onA).some((text) => text.startsWith("Xong (task")), "A to hear it is done");
    expect(readFileSync(join(b.root, "notes.md"), "utf8")).toBe("viết từ máy bàn\n");

    const [home] = tasksOn(a);
    expect(home).toMatchObject({ state: "succeeded", homeNodeId: identityOf(a).nodeId, executionNodeId: identityOf(b).nodeId });
    // A holds B's run as a run of its own task, and B's answer is the evidence recorded against it.
    const runs = allRows<{ run_id: string; execution_node_id: string }>(
      a.services.runtime.db,
      "SELECT run_id, execution_node_id FROM runs WHERE task_id = ?",
      String(home?.taskId),
    );
    expect(runs).toEqual([{ run_id: home?.activeRunId, execution_node_id: identityOf(b).nodeId }]);
    const evidence = allRows<{ kind: string; verdict: string }>(
      a.services.runtime.db,
      "SELECT kind, verdict FROM evidence WHERE run_id = ?",
      String(home?.activeRunId),
    );
    expect(evidence).toEqual([{ kind: "api-receipt", verdict: "verified" }]);
    const [ran] = tasksOn(b);
    expect(ran).toMatchObject({
      taskId: home?.taskId,
      state: "succeeded",
      conversationId: onB,
      origin: { kind: "delegated", peerNodeId: identityOf(a).nodeId, allowedCategories: ["read", "local-write"] },
    });
    // Each owner hears it where they set it up.
    expect(said(a, onA).find((text) => text.startsWith("Xong (task"))).toContain(`trên ${identityOf(b).nodeId}`);
    expect(said(b, onB).some((text) => text.includes(`giao việc "Ghi chú trên laptop" (task ${String(home?.taskId)})`))).toBe(true);
    expect(said(b, onB).some((text) => text.startsWith("Xong (task"))).toBe(true);
    await waitUntil(() => pendingOutbox(b.services.runtime.db).length === 0, "B's answer to be delivered");
  });

  it("does not run where the other node's owner allowed nothing, and says so on both sides", async () => {
    const { a, b, onA } = await desks();
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);

    await signal(a, "note-1");

    await waitUntil(() => said(a, onA).some((text) => text.startsWith("Không xong (task")), "A to hear it did not run");
    expect(said(a, onA).find((text) => text.startsWith("Không xong (task"))).toContain(
      `${identityOf(b).nodeId} không chạy việc này: this node's owner has not allowed that peer to run tasks here`,
    );
    expect(tasksOn(b)).toEqual([]);
    expect(existsSync(join(b.root, "notes.md"))).toBe(false);
    const inbox = allRows<{ body: string }>(b.services.runtime.db, "SELECT body FROM notifications");
    expect(inbox.some((row) => row.body.includes("bạn chưa cho phép node đó chạy việc ở đây"))).toBe(true);
  });

  it("does not run in a folder outside what the other node's owner allowed", async () => {
    const { a, b, onA, onB } = await desks();
    const elsewhere = join(b.root, "private");
    mkdirSync(elsewhere);
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    await handToLaptop(a, b, onA, [{ path: elsewhere, access: "write" }], ["read", "local-write"]);

    await signal(a, "note-1");

    await waitUntil(() => said(a, onA).some((text) => text.startsWith("Không xong (task")), "A to hear it did not run");
    expect(said(a, onA).find((text) => text.startsWith("Không xong (task"))).toContain("grant does not include the requested resource");
    expect(said(b, onB).some((text) => text.includes(`ở ${elsewhere}, ngoài những gì bạn cho node đó`))).toBe(true);
    expect(tasksOn(b)).toEqual([]);
  });

  it("waits for the other node's owner on an effect only one side allowed, and a stop from the sender ends it", async () => {
    const { a, b, onA, onB } = await desks();
    // B's owner lets A's work read the folder, and nothing more without asking.
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);

    await signal(a, "note-1");

    await waitUntil(() => tasksOn(b)[0]?.state === "waiting_approval", "the task on B to wait for its owner");
    expect(tasksOn(b)[0]?.origin).toMatchObject({ kind: "delegated", allowedCategories: ["read"] });
    expect(said(b, onB).some((text) => text.startsWith("Đang chờ bạn duyệt (task"))).toBe(true);
    expect(existsSync(join(b.root, "notes.md"))).toBe(false);

    // A's owner stops it from A: the stop travels to B, and B's answer confirms it.
    const [home] = tasksOn(a);
    const stopped = await call(a, `/tasks/${String(home?.taskId)}/cancel`, { token: a.token });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ confirmed: false });
    await waitUntil(() => getTask(a.services.runtime.db, String(home?.taskId))?.state === "cancelled", "A's task to be stopped");
    expect(tasksOn(b)[0]?.state).toBe("cancelled");
    expect(said(a, onA).some((text) => text.startsWith("Đã hủy (task"))).toBe(true);
  });

  it("stops a worker already running on the other node when the sender stops the task", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop", { stoppable: true });
    await pair(a, b);
    const onA = await conversation(a, "Ghi chú");
    const onB = await conversation(b, "Máy bàn");
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);
    await signal(a, "note-1");
    await waitUntil(() => workers.length === 1, "B's worker to start");
    const [worker] = workers;

    const [home] = tasksOn(a);
    const stopped = await call(a, `/tasks/${String(home?.taskId)}/cancel`, { token: a.token });
    expect(stopped.body).toMatchObject({ confirmed: false });

    // B does not call it stopped while its worker still runs: the worker is ended, and its end confirms the stop.
    await waitUntil(() => worker?.exitCode !== null || worker?.signalCode !== null, "B's worker to be stopped");
    await waitUntil(() => getTask(a.services.runtime.db, String(home?.taskId))?.state === "cancelled", "A's task to be stopped");
    expect(tasksOn(b)[0]?.state).toBe("cancelled");
    expect(said(a, onA).some((text) => text.startsWith("Đã hủy (task"))).toBe(true);
  });

  it("stops a worker running here when this node's owner stops the task", async () => {
    const b = await startClark("laptop", { stoppable: true });
    const onB = await conversation(b, "Việc ở đây");
    const at = () => new Date().toISOString() as Instant;
    const task = createTask(
      { db: b.services.runtime.db, nodeId: identityOf(b).nodeId, now: at, newId: b.services.conductor.newId },
      {
        conversationId: onB as TaskRecord["conversationId"],
        goal: "Keep working until stopped.",
        principal: { principalId: identityOf(b).ownerPrincipalId as never, kind: "user", nodeId: identityOf(b).nodeId as never },
      },
    );
    const coordination = { db: b.services.runtime.db, nodeId: identityOf(b).nodeId, now: at, newId: b.services.conductor.newId };
    expect(startTaskHere(coordination, task.taskId, CONTROLLED_CODE_TASK.ref)).toEqual({ ok: true });
    b.services.conductor.runTask?.({ taskId: task.taskId, capabilityRef: CONTROLLED_CODE_TASK.ref, executionNodeId: identityOf(b).nodeId });
    await waitUntil(() => workers.length === 1, "the worker to start");

    const stopped = await call(b, `/tasks/${task.taskId}/cancel`, { token: b.token });
    // Not confirmed by the request: the worker is still running when it is answered.
    expect(stopped.body).toMatchObject({ confirmed: false, state: "cancel_requested" });
    await waitUntil(() => getTask(b.services.runtime.db, task.taskId)?.state === "cancelled", "the task to be stopped");
    expect(workers[0]?.exitCode !== null || workers[0]?.signalCode !== null).toBe(true);
  });

  it("answers a hand-over under a grant no longer live with why it does not run", async () => {
    const { a, b, onA, onB } = await desks();
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);
    revokeGrant(b.services.runtime.db, getGrantIdFor(a, b), new Date().toISOString() as Instant);

    await signal(a, "note-1");

    await waitUntil(() => said(a, onA).some((text) => text.startsWith("Không xong (task")), "A to hear it did not run");
    expect(said(a, onA).find((text) => text.startsWith("Không xong (task"))).toContain("the grant this hand-over names was revoked");
    expect(tasksOn(b)).toEqual([]);
  });

  it("settles the sender's task when a hand-over or a stop could not be delivered", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop", { hang: true });
    await pair(a, b);
    const onA = await conversation(a, "Ghi chú");
    const onB = await conversation(b, "Máy bàn");
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);
    await signal(a, "note-1");
    await signal(a, "note-2");
    await waitUntil(() => tasksOn(a).filter((task) => task.state === "running").length === 2, "both tasks to be running on B");
    const [refused, unanswered] = tasksOn(a);
    const settle = settleUndeliveredTasks(a.services, () => new Date().toISOString() as Instant);
    const peerNodeId = identityOf(b).nodeId;

    // The peer turned the hand-over down, so it never ran there: the task failed.
    settle({ messageId: "msg_refused", peerNodeId, kind: "delegate", taskId: String(refused?.taskId), refusedByPeer: true });
    expect(getTask(a.services.runtime.db, String(refused?.taskId))?.state).toBe("failed");
    expect(said(a, onA).some((text) => text.startsWith(`Không xong (task ${String(refused?.taskId)})`) && text.includes("từ chối"))).toBe(true);

    // A stop nobody answered may not have stopped anything: the outcome is unknown, and said so.
    const stopped = await call(a, `/tasks/${String(unanswered?.taskId)}/cancel`, { token: a.token });
    expect(stopped.body).toMatchObject({ confirmed: false });
    settle({ messageId: "msg_lost", peerNodeId, kind: "cancel.request", taskId: String(unanswered?.taskId), refusedByPeer: false });
    expect(getTask(a.services.runtime.db, String(unanswered?.taskId))?.state).toBe("uncertain");
    expect(said(a, onA).some((text) => text.includes(`(task ${String(unanswered?.taskId)})`) && text.includes("yêu cầu dừng"))).toBe(true);

    // A letter about a task already settled, or one some other node was running, changes nothing.
    settle({ messageId: "msg_again", peerNodeId, kind: "delegate", taskId: String(refused?.taskId), refusedByPeer: false });
    expect(getTask(a.services.runtime.db, String(refused?.taskId))?.state).toBe("failed");
  });
  it("tells the sender its outcome is unknown when the node running it restarted part-way", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop", { hang: true });
    await pair(a, b);
    const onA = await conversation(a, "Ghi chú");
    const onB = await conversation(b, "Máy bàn");
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);
    await signal(a, "note-1");
    await waitUntil(() => tasksOn(b)[0]?.state === "running", "the task to be running on B");

    // B's next boot finds the task it was running and cannot say how it ended; A is told the same.
    const now = () => new Date().toISOString() as Instant;
    const recovered = recoverUnfinishedWork({
      db: b.services.runtime.db,
      nodeId: identityOf(b).nodeId,
      nodeBootId: "boot-after-restart",
      machineBootId: undefined,
      now,
      newId: b.services.conductor.newId,
      policyMode: () => "autonomous",
      report: () => undefined,
      rerun: () => false,
      onUncertain: answerUncertain(b.services, now),
    });
    expect(recovered.uncertainTasks).toBe(1);

    const [home] = tasksOn(a);
    await waitUntil(() => getTask(a.services.runtime.db, String(home?.taskId))?.state === "uncertain", "A's task to be uncertain");
    expect(said(a, onA).some((text) => text.includes(`(task ${String(home?.taskId)})`) && text.includes("khởi động lại"))).toBe(true);
  });

  it("counts a hand-over and its answer once, however often they arrive", async () => {
    const { a, b, onA, onB } = await desks();
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);
    await signal(a, "note-1");
    await waitUntil(() => tasksOn(a)[0]?.state === "succeeded", "the first run to settle");
    await waitUntil(() => pendingOutbox(b.services.runtime.db).length === 0, "B's answer to be delivered");

    const [home] = tasksOn(a);
    const taskId = String(home?.taskId);
    const [delegate] = allRows<{ document: string }>(a.services.runtime.db, "SELECT document FROM outbox").flatMap((row) => {
      const envelope = JSON.parse(row.document) as PeerEnvelope;
      return envelope.kind === "delegate" ? [envelope] : [];
    });
    expect(delegate).toBeDefined();

    // The same hand-over under a new message: B finds the task it already made, and runs nothing again.
    const at = () => new Date().toISOString() as Instant;
    sendEnvelope({ db: a.services.runtime.db, now: at }, {
      ...(delegate as PeerEnvelope),
      messageId: "msg_again",
      sourceSequence: nextOutboundSequence(a.services.runtime.db, identityOf(b).nodeId),
      sentAt: at(),
    });
    // And B's answer again, now saying it failed: the task it settled stays settled.
    queueResult(
      { db: b.services.runtime.db, identity: identityOf(b), now: at, newId: b.services.conductor.newId },
      identityOf(a).nodeId,
      taskId,
      { outcome: "failed", message: "late", ran: true },
    );
    a.services.peerDelivery?.kick();
    b.services.peerDelivery?.kick();
    await waitUntil(
      () => pendingOutbox(a.services.runtime.db).length === 0 && pendingOutbox(b.services.runtime.db).length === 0,
      "both to be delivered",
    );

    expect(tasksOn(b)).toHaveLength(1);
    expect(getTask(a.services.runtime.db, taskId)?.state).toBe("succeeded");
    expect(said(a, onA).filter((text) => text.includes(`(task ${taskId})`) && /^(Xong|Không xong)/.test(text))).toHaveLength(1);
  });

  it("takes an answer only from the node the task was handed to, and a grant only from its own sender", async () => {
    const { a, b, onA, onB } = await desks();
    const c = await startClark("stranger");
    await pair(c, a);
    await pair(c, b);
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);
    await signal(a, "note-1");
    await waitUntil(() => tasksOn(b)[0]?.state === "waiting_approval", "the task on B to wait");
    const [home] = tasksOn(a);
    const taskId = String(home?.taskId);

    // C, paired with A but never handed the task, says it succeeded.
    const at = () => new Date().toISOString() as Instant;
    queueResult({ db: c.services.runtime.db, identity: identityOf(c), now: at, newId: c.services.conductor.newId }, identityOf(a).nodeId, taskId, {
      outcome: "succeeded",
      message: "done, trust me",
      ran: true,
    });
    c.services.peerDelivery?.kick();
    await waitUntil(() => pendingOutbox(c.services.runtime.db).length === 0, "C's message to be delivered");
    expect(getTask(a.services.runtime.db, taskId)?.state).toBe("running");

    // C tries to take over the grant A wrote for B, by sending B a grant under the same id.
    const grantId = getGrantIdFor(a, b);
    const forged = await call(c, "/grants", {
      body: {
        ...getGrant(a.services.runtime.db, grantId),
        ownerPrincipalId: identityOf(c).ownerPrincipalId,
        senderNodeId: identityOf(c).nodeId,
      },
      token: c.token,
    });
    expect(forged.status).toBe(201);
    await waitUntil(() => pendingOutbox(c.services.runtime.db).length === 0, "C's grant to be delivered");
    expect(getGrant(b.services.runtime.db, grantId)).toMatchObject({ senderNodeId: identityOf(a).nodeId });
  });
});

function getGrantIdFor(from: LiveNode, to: LiveNode): string {
  const [row] = allRows<{ grant_id: string }>(
    from.services.runtime.db,
    "SELECT grant_id FROM grants WHERE sender_node_id = ? AND receiver_node_id = ?",
    identityOf(from).nodeId,
    identityOf(to).nodeId,
  );
  if (row === undefined) throw new Error("no grant from that node");
  return row.grant_id;
}
