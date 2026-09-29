import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type Grant,
  type Instant,
  type MessageBlock,
  type MessageRecord,
  PEER_FEATURES,
  type PeerEnvelope,
  type TaskRecord,
} from "@clarkcant/contracts";
import { createTask, registerCapability, startTaskHere, updateReadiness } from "@clarkcant/core";
import { sendEnvelope } from "@clarkcant/node-link";
import { CONTROLLED_CODE_TASK } from "@clarkcant/project-work";
import {
  allRows,
  getArtifact,
  getGrant,
  getPeer,
  getPersistentIntent,
  getTask,
  getTaskArtifact,
  insertTaskArtifact,
  listTaskArtifacts,
  nextOutboundSequence,
  parseJson,
  pendingOutbox,
  recordPeerAdvertisement,
  revokeGrant,
} from "@clarkcant/storage";

import { createAutomationTools } from "../src/automation-tools.ts";
import { startAutomationService } from "../src/automation-service.ts";
import { blobPathForDigest, readBlob } from "../src/blobs.ts";
import { resumeTasksWaitingOnCapability } from "../src/capability-waiters.ts";
import { askPeerCapabilities } from "../src/peer-capabilities.ts";
import { queueResult, writeGrant } from "../src/delegation.ts";
import { resumeArtifactIntake } from "../src/delegated-artifacts.ts";
import { answerUncertain, artifactIntakeDeps, settleUndeliveredTasks } from "../src/delegation-handlers.ts";
import { sweepExpired } from "../src/expiry-notices.ts";
import { startPeerDelivery } from "../src/peer-signals.ts";
import { createTaskDispatcher } from "../src/task-dispatch.ts";
import { taskDispatchReports } from "../src/task-reporting.ts";
import { runWorkerProcess } from "../src/worker-process.ts";
import { recoverUnfinishedWork } from "../src/work-recovery.ts";
import { type LiveNode, call, identityOf, liveNodes, pair, tokenFor } from "./live-nodes.ts";

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
async function startClark(
  label: string,
  options: { hang?: boolean; stoppable?: boolean; crash?: boolean; packLoading?: boolean; alsoRuns?: string } = {},
): Promise<Clark> {
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
        // Still loading, as the pack is for the first minute after a start: registered, and not usable yet.
        readiness:
          options.packLoading === true
            ? { installed: true, loaded: false, authenticated: true, authorized: true, healthy: false, blockedReason: "no worker has loaded the pack yet" }
            : { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      },
    );
    // Something else this node can run, which no allowance names.
    if (options.alsoRuns !== undefined) {
      registerCapability(
        { db: services.runtime.db, nodeId: services.runtime.identity.nodeId },
        {
          ...CONTROLLED_CODE_TASK,
          ref: options.alsoRuns as never,
          executionNodeId: services.runtime.identity.nodeId as never,
          readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
        },
      );
    }
    const script = writeScript(services.runtime.dataDir);
    const dispatcher = createTaskDispatcher({
      conductor: services.conductor,
      projectRoots: () => [root],
      ownedRoots: () => [root],
      ownerPrincipalId: () => services.runtime.identity.ownerPrincipalId,
      ...taskDispatchReports(services),
      timeoutMs: 60_000,
      // A worker that never answers stands for a node that stopped while the task ran; one that crashes, for a failure.
      runWorker:
        options.hang === true
          ? () => new Promise<never>(() => undefined)
          : options.crash === true
            ? () => Promise.reject(new Error("the worker process exited with code 1"))
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
    peerCapabilities: (peerNodeId) => askPeerCapabilities(node.services.runtime, peerNodeId),
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

async function handToLaptop(
  a: Clark,
  b: Clark,
  onA: string,
  folders: unknown[],
  allowedEffects: string[],
  more: Record<string, unknown> = {},
): Promise<string> {
  const text = await tools(a, onA)("create_automation", {
    summary: "Ghi chú trên laptop",
    topic: "local.note.requested",
    action: "task",
    goal: "Write notes.md with today's note.",
    folders,
    allowedEffects,
    executor: identityOf(b).nodeId,
    ...more,
  });
  expect(text).toContain("Set up.");
  expect(text).toContain(`It runs on ${identityOf(b).nodeId}`);
  // The grant travels as soon as it is written; B holds it before anything asks to run under it.
  await waitUntil(() => pendingOutbox(a.services.runtime.db).length === 0, "the grant to reach B");
  return text;
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
    expect(startTaskHere(coordination, task.taskId, CONTROLLED_CODE_TASK.ref)).toEqual({ ok: true, parked: false });
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

  it("tells the sender while its task waits for the other node's owner, and settles it on their decision", async () => {
    const { a, b, onA, onB } = await desks();
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);

    // Refused by B's owner: A hears it waited, then that it ended without running.
    await signal(a, "note-1");
    await waitUntil(() => tasksOn(b)[0]?.state === "waiting_approval", "the task on B to wait for its owner");
    const [first] = tasksOn(a);
    const firstId = String(first?.taskId);
    await waitUntil(() => said(a, onA).some((text) => text.includes(`Task ${firstId} trên ${identityOf(b).nodeId} đang chờ chủ của`)), "A to hear it waits");
    // A's own task is not offered to A's owner as a decision: it still runs, on B.
    expect(getTask(a.services.runtime.db, firstId)?.state).toBe("running");
    const notices = allRows<{ title: string; body: string; subject: string | null }>(
      a.services.runtime.db,
      "SELECT title, body, subject FROM notifications WHERE title = 'Việc đang chờ chủ máy kia duyệt'",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain("Chỉ họ quyết định được");
    expect(notices[0]?.subject).toContain(firstId);
    expect(allRows(a.services.runtime.db, "SELECT approval_id FROM approvals")).toEqual([]);

    expect(waitingOnA(a, firstId)).toBe(true);

    await decide(b, firstId, "denied");
    await waitUntil(() => getTask(a.services.runtime.db, firstId)?.state === "failed", "A's task to end on the refusal");
    expect(said(a, onA).find((text) => text.startsWith(`Không xong (task ${firstId})`))).toContain(
      `${identityOf(b).nodeId} không chạy việc này: chủ của node này đã từ chối`,
    );
    // Decided on B, so it is no longer waiting in A's inbox either; B's own waiting item is gone with its approval.
    expect(waitingOnA(a, firstId)).toBe(false);
    expect(await waitingOn(b)).toEqual([]);

    // Allowed by B's owner: A hears it goes on, and it finishes there.
    await signal(a, "note-2");
    await waitUntil(() => tasksOn(b)[1]?.state === "waiting_approval", "the second task on B to wait");
    const secondId = String(tasksOn(a)[1]?.taskId);
    await waitUntil(() => waitingOnA(a, secondId), "A's inbox to say the second task waits");
    await decide(b, secondId, "granted");
    await waitUntil(() => said(a, onA).some((text) => text === `Chủ của ${identityOf(b).nodeId} đã duyệt; task ${secondId} tiếp tục chạy trên ${identityOf(b).nodeId}.`), "A to hear it goes on");
    expect(waitingOnA(a, secondId)).toBe(false);
    await waitUntil(() => getTask(a.services.runtime.db, secondId)?.state === "succeeded", "A's second task to finish");
    expect(readFileSync(join(b.root, "notes.md"), "utf8")).toBe("viết từ máy bàn\n");
  });

  it("tells the sender once about a hand-over that failed on the other node, through its result and nothing else", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop", { crash: true });
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
    await waitUntil(() => tasksOn(a).length === 1, "A's task");
    const taskId = String(tasksOn(a)[0]?.taskId);
    await waitUntil(() => getTask(a.services.runtime.db, taskId)?.state === "failed", "A's task to end on B's failure");

    // B's own inbox keeps its notice, and B sends none of its own about it: the result already told A.
    const onBInbox = (): unknown[] =>
      allRows(b.services.runtime.db, "SELECT dedup_key FROM notifications WHERE dedup_key = ?", `worker:${taskId}`);
    await waitUntil(() => onBInbox().length === 1, "B's own notice");
    await waitUntil(() => pendingOutbox(b.services.runtime.db).length === 0, "B's outbox to drain");
    const noticeEnvelopes = allRows<{ document: string }>(b.services.runtime.db, "SELECT document FROM outbox").filter(
      (row) => (JSON.parse(row.document) as PeerEnvelope).kind === "notice",
    );
    expect(noticeEnvelopes).toEqual([]);

    // Every row on A about the task, read or not, dismissed or not, local or from B: one notice for the task, plus the
    // one A records for any automation run that fails. Nothing from B, and nothing twice.
    const aboutTask = allRows<{ dedup_key: string; origin_node_id: string | null }>(
      a.services.runtime.db,
      "SELECT dedup_key, origin_node_id FROM notifications WHERE instr(dedup_key, ?) > 0 OR instr(COALESCE(subject, ''), ?) > 0 ORDER BY dedup_key",
      taskId,
      taskId,
    );
    expect(aboutTask.map((row) => row.origin_node_id)).toEqual([null, null]);
    expect(aboutTask[0]?.dedup_key).toMatch(/^automation:irun_/);
    expect(aboutTask[1]?.dedup_key).toBe(`worker:${taskId}`);
  });

  it("settles the sender's task when the other node's owner lets the approval expire", async () => {
    const { a, b, onA, onB } = await desks();
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);
    await signal(a, "note-1");
    await waitUntil(() => tasksOn(b)[0]?.state === "waiting_approval", "the task on B to wait for its owner");
    const taskId = String(tasksOn(a)[0]?.taskId);

    // Nobody on B decides before the approval's deadline, and B's sweep ends the task there.
    const past = new Date(Date.now() - 1000).toISOString();
    b.services.runtime.db.prepare("UPDATE approvals SET expires_at = ? WHERE task_id = ?").run(past, taskId);
    sweepExpired(b.services, new Date().toISOString() as Instant);

    await waitUntil(() => getTask(a.services.runtime.db, taskId)?.state === "failed", "A's task to end on the expiry");
    expect(said(a, onA).find((text) => text.startsWith(`Không xong (task ${taskId})`))).toContain("yêu cầu duyệt đã hết hạn");
    // Swept again, nothing more is sent.
    sweepExpired(b.services, new Date().toISOString() as Instant);
    const results = allRows<{ document: string }>(b.services.runtime.db, "SELECT document FROM outbox").filter(
      (row) => (JSON.parse(row.document) as PeerEnvelope).kind === "result",
    );
    expect(results).toHaveLength(1);
  });

  it("withdraws an automation's own grant on both nodes when it is paused or removed, and writes a new one to resume", async () => {
    const { a, b, onA, onB } = await desks();
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);
    const intentId = onlyIntentId(a);
    const first = actionGrantId(a, intentId);
    expect(getGrant(b.services.runtime.db, first)?.revokedAt).toBeUndefined();

    expect(await tools(a, onA)("update_automation", { intentId, change: "pause" })).toContain("Changed.");
    await waitUntil(() => getGrant(b.services.runtime.db, first)?.revokedAt !== undefined, "B to hold the grant withdrawn");
    expect(getGrant(a.services.runtime.db, first)?.revokedAt).toBeDefined();

    expect(await tools(a, onA)("update_automation", { intentId, change: "resume" })).toContain("Changed.");
    const second = actionGrantId(a, intentId);
    expect(second).not.toBe(first);
    await waitUntil(() => getGrant(b.services.runtime.db, second) !== undefined, "the new grant to reach B");
    // A withdrawn grant stays withdrawn; the automation runs under its new one.
    expect(getGrant(b.services.runtime.db, first)?.revokedAt).toBeDefined();
    await signal(a, "note-1");
    await waitUntil(() => tasksOn(a)[0]?.state === "succeeded", "the resumed automation to run on B");
    expect(tasksOn(b)[0]?.origin).toMatchObject({ kind: "delegated", delegationId: second });

    expect(await tools(a, onA)("update_automation", { intentId, change: "remove" })).toContain("Removed");
    await waitUntil(() => getGrant(b.services.runtime.db, second)?.revokedAt !== undefined, "B to hold the second grant withdrawn");
  });

  it("runs an automation only under its own grant, not another that covers the same folders", async () => {
    const { a, b, onA, onB } = await desks();
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);
    const intentId = onlyIntentId(a);
    // Another automation to the same node and folder, with a grant of its own.
    expect(
      await tools(a, onA)("create_automation", {
        summary: "Ghi chú khác",
        topic: "local.note.other",
        action: "task",
        goal: "Write notes.md with another note.",
        folders: [{ path: b.root, access: "write" }],
        allowedEffects: ["read", "local-write"],
        executor: identityOf(b).nodeId,
      }),
    ).toContain("Set up.");
    await waitUntil(() => pendingOutbox(a.services.runtime.db).length === 0, "the second grant to reach B");

    revokeGrant(a.services.runtime.db, actionGrantId(a, intentId), new Date().toISOString() as Instant);
    await signal(a, "note-1");

    await waitUntil(() => said(a, onA).some((text) => text.includes("không chạy cho")), "A to refuse the run");
    expect(said(a, onA).find((text) => text.includes("không chạy cho"))).toContain(`no live grant lets ${identityOf(b).nodeId} run it any more`);
    expect(tasksOn(b)).toEqual([]);
  });

  it("holds a run on the other node to the sender's time limit and run count", async () => {
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
    expect(
      await tools(a, onA)("create_automation", {
        summary: "Ghi chú",
        topic: "local.note.requested",
        action: "task",
        goal: "Write notes.md.",
        folders: [{ path: a.root, access: "write" }],
        maxMinutesPerRun: 5,
      }),
    ).toContain("maxMinutesPerRun is for a task another node runs");
    expect(
      await tools(a, onA)("create_automation", {
        summary: "Ghi chú trên laptop",
        topic: "local.note.requested",
        action: "task",
        goal: "Write notes.md with today's note.",
        folders: [{ path: b.root, access: "write" }],
        allowedEffects: ["read", "local-write"],
        executor: identityOf(b).nodeId,
        maxMinutesPerRun: 5,
      }),
    ).toContain("Set up.");
    const grantId = actionGrantId(a, onlyIntentId(a));
    await waitUntil(() => getGrant(b.services.runtime.db, grantId) !== undefined, "the grant to reach B");
    expect(getGrant(b.services.runtime.db, grantId)?.budget).toEqual({ maxWallClockMs: 300_000 });

    // A's owner narrows the same grant to half a second and one run; B holds the narrower one.
    const grant = getGrant(a.services.runtime.db, grantId);
    const identity = identityOf(a);
    expect(
      writeGrant(
        { db: a.services.runtime.db, identity, now: () => new Date().toISOString() as Instant, newId: a.services.conductor.newId },
        { ...(grant as Grant), budget: { maxWallClockMs: 500, maxRuns: 1 } },
      ),
    ).toEqual({ ok: true });
    a.services.peerDelivery?.kick();
    await waitUntil(() => getGrant(b.services.runtime.db, grantId)?.budget?.maxRuns === 1, "B to hold the narrower grant");

    await signal(a, "note-1");
    const taskId = await (async () => {
      await waitUntil(() => tasksOn(a).length === 1, "the first task");
      return String(tasksOn(a)[0]?.taskId);
    })();
    await waitUntil(() => getTask(a.services.runtime.db, taskId)?.state === "failed", "the run to be stopped by the limit");
    expect(tasksOn(b)[0]?.budget).toEqual({ maxWallClockMs: 500, maxDelegationDepth: 0 });
    expect(said(a, onA).find((text) => text.startsWith(`Không xong (task ${taskId})`))).toContain("wall-clock budget of 500 ms");
    expect(workers[0]?.exitCode !== null || workers[0]?.signalCode !== null).toBe(true);

    await signal(a, "note-2");
    await waitUntil(() => tasksOn(a)[1]?.state === "failed", "the second run to be refused");
    expect(said(a, onA).find((text) => text.startsWith(`Không xong (task ${String(tasksOn(a)[1]?.taskId)})`))).toContain(
      "allows 1 run(s), and they are used up",
    );
    expect(tasksOn(b)).toHaveLength(1);
  });
});

describe("what the other node can run, asked before a task is handed to it", { timeout: 60_000 }, () => {
  it("shows the sender a node that cannot run the task yet, warns at setup, and says at once that a hand-over waits there", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop", { packLoading: true });
    await pair(a, b, { advertise: true });
    const onA = await conversation(a, "Ghi chú");
    const onB = await conversation(b, "Máy bàn");
    const peerA = identityOf(a).nodeId;
    const peerB = identityOf(b).nodeId;

    // Before B's owner allows anything, B runs nothing for A, and A is told so.
    expect(await tools(a, onA)("list_peers", {})).toContain(
      `${peerB} · fingerprint ${identityOf(b).fingerprint} · may not run work here · runs nothing for this node: its owner has not allowed this node to run work there`,
    );
    await tools(b, onB)("allow_peer_tasks", {
      peer: peerA,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    // Allowed now, but the pack on B is still loading: A sees B unable to run it for now.
    expect(await tools(a, onA)("list_peers", {})).toContain(
      "can run for this node: project.file.read@1 (not ready), project.code.change@1 (not ready)",
    );

    const setUp = await tools(a, onA)("create_automation", {
      summary: "Ghi chú trên laptop",
      topic: "local.note.requested",
      action: "task",
      goal: "Write notes.md with today's note.",
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
      executor: peerB,
    });
    expect(setUp).toContain("Set up.");
    expect(setUp).toContain(
      `Warning: ${peerB} cannot run project.code.change@1 right now. A run handed over waits there until it can, with no time limit`,
    );
    await waitUntil(() => pendingOutbox(a.services.runtime.db).length === 0, "the grant to reach B");

    await signal(a, "note-1");

    // The hand-over reaches B and waits there; A is told at once, naming what it waits for, and its task still runs.
    await waitUntil(() => tasksOn(b)[0]?.state === "waiting_capability", "the task on B to wait for the capability");
    const taskId = String(tasksOn(a)[0]?.taskId);
    await waitUntil(() => said(a, onA).some((text) => text.startsWith(`Task ${taskId} đã tới ${peerB} nhưng chưa chạy`)), "A to hear it waits");
    expect(said(a, onA).find((text) => text.startsWith(`Task ${taskId} đã tới`))).toContain(`${peerB} chưa chạy được project.code.change@1 lúc này`);
    expect(getTask(a.services.runtime.db, taskId)?.state).toBe("running");
    expect(waitingOnA(a, taskId)).toBe(true);
    const notices = allRows<{ body: string }>(
      a.services.runtime.db,
      "SELECT body FROM notifications WHERE title = 'Việc đang chờ máy kia sẵn sàng'",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain("project.code.change@1");
    expect(said(b, onB).some((text) => text.includes(`máy này chưa chạy được project.code.change@1 lúc này`))).toBe(true);
    expect(existsSync(join(b.root, "notes.md"))).toBe(false);

    // The pack on B finishes loading: the task goes on there by itself, and A hears it.
    updateReadiness(
      { db: b.services.runtime.db, nodeId: peerB },
      {
        ref: CONTROLLED_CODE_TASK.ref,
        executionNodeId: peerB,
        change: { loaded: true, healthy: true, blockedReason: undefined },
        at: new Date().toISOString() as Instant,
      },
    );
    expect(resumeTasksWaitingOnCapability(b.services).map((task) => task.taskId)).toEqual([taskId]);
    await waitUntil(
      () => said(a, onA).includes(`project.code.change@1 đã dùng được trên ${peerB}; task ${taskId} bắt đầu chạy ở đó.`),
      "A to hear it runs now",
    );
    await waitUntil(() => getTask(a.services.runtime.db, taskId)?.state === "succeeded", "A's task to finish");
    expect(waitingOnA(a, taskId)).toBe(false);
    expect(readFileSync(join(b.root, "notes.md"), "utf8")).toBe("viết từ máy bàn\n");
  });

  it("stops a hand-over waiting there for a capability when the sender stops it", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop", { packLoading: true });
    await pair(a, b, { advertise: true });
    const onA = await conversation(a, "Ghi chú");
    const onB = await conversation(b, "Máy bàn");
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);
    await signal(a, "note-1");
    await waitUntil(() => tasksOn(b)[0]?.state === "waiting_capability", "the task on B to wait for the capability");
    const taskId = String(tasksOn(a)[0]?.taskId);
    await waitUntil(() => waitingOnA(a, taskId), "A to hear it waits");

    expect((await call(a, `/tasks/${taskId}/cancel`, { token: a.token })).status).toBe(200);

    // Nothing runs for it on B, so B stops it at once and says so; A's task stops and its waiting item goes.
    await waitUntil(() => getTask(a.services.runtime.db, taskId)?.state === "cancelled", "A's task to be stopped");
    expect(tasksOn(b)[0]?.state).toBe("cancelled");
    expect(waitingOnA(a, taskId)).toBe(false);
    // Stopped for good: the capability becoming usable later does not start it.
    updateReadiness(
      { db: b.services.runtime.db, nodeId: identityOf(b).nodeId },
      {
        ref: CONTROLLED_CODE_TASK.ref,
        executionNodeId: identityOf(b).nodeId,
        change: { loaded: true, healthy: true, blockedReason: undefined },
        at: new Date().toISOString() as Instant,
      },
    );
    expect(resumeTasksWaitingOnCapability(b.services)).toEqual([]);
    expect(existsSync(join(b.root, "notes.md"))).toBe(false);
  });

  it("refuses at once, as before, a hand-over from a node that would not hear it waits", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop", { packLoading: true });
    // Paired as a build from before this: neither node has said it reads what a capability wait is.
    await pair(a, b);
    // A has since heard from B that B answers what it runs, but B has not yet heard the same from A: a pairing made
    // before this build, where only one side has answered anything since.
    recordPeerAdvertisement(a.services.runtime.db, identityOf(b).nodeId, { features: [...PEER_FEATURES] });
    const onA = await conversation(a, "Ghi chú");
    const onB = await conversation(b, "Máy bàn");
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });

    // B says a run would not wait there, so A's setup warns that each run is refused, not that it waits.
    const setUp = await tools(a, onA)("create_automation", {
      summary: "Ghi chú trên laptop",
      topic: "local.note.requested",
      action: "task",
      goal: "Write notes.md with today's note.",
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
      executor: identityOf(b).nodeId,
    });
    expect(setUp).toContain(
      `Warning: ${identityOf(b).nodeId} cannot run project.code.change@1 right now, and a run handed over is refused there at once until it can`,
    );
    expect(setUp).not.toContain("waits there");
    await waitUntil(() => pendingOutbox(a.services.runtime.db).length === 0, "the grant to reach B");

    await signal(a, "note-1");

    await waitUntil(() => said(a, onA).some((text) => text.startsWith("Không xong (task")), "A to hear it did not run");
    expect(said(a, onA).find((text) => text.startsWith("Không xong (task"))).toContain(
      `${identityOf(b).nodeId} không chạy việc này: this node cannot run project.code.change@1 right now`,
    );
    expect(tasksOn(b)[0]?.state).toBe("failed");
  });

  it("tells a peer only what its owner allowed that peer, and nothing to a peer it allowed nothing", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop", { alsoRuns: "browser.session.drive@1" });
    const c = await startClark("stranger");
    await pair(a, b, { advertise: true });
    await pair(c, b, { advertise: true });
    const onA = await conversation(a, "Ghi chú");
    const onB = await conversation(b, "Máy bàn");
    // B's owner lets A read one folder, and nothing more.
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "read" }],
      allowedEffects: ["read"],
    });

    const asked = async (token: string | undefined): Promise<{ status: number; text: string }> => {
      const response = await fetch(`${b.base}/peers/capabilities`, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });
      return { status: response.status, text: await response.text() };
    };

    // A hears exactly the reader its allowance covers: not the code-change worker or the browser B also runs, not the
    // folder, and not why anything is not ready.
    const toA = await asked(tokenFor(a, b));
    expect(toA.status).toBe(200);
    expect(JSON.parse(toA.text)).toEqual({ version: 1, allowed: true, waits: true, capabilities: [{ ref: "project.file.read@1", ready: false }] });
    expect(toA.text).not.toContain(b.root);
    expect(toA.text).not.toContain("project.code.change@1");
    expect(toA.text).not.toContain("browser.session.drive@1");

    // C, paired but allowed nothing, hears only that; a caller without a peer token hears nothing at all.
    expect(JSON.parse((await asked(tokenFor(c, b))).text)).toEqual({ version: 1, allowed: false, waits: true, capabilities: [] });
    expect((await asked(undefined)).status).toBe(401);
    expect((await asked(b.token)).status).toBe(401);

    // What A's listing and setup say comes from that answer alone.
    const listed = await tools(a, onA)("list_peers", {});
    expect(listed).toContain("can run for this node: project.file.read@1 (not ready)");
    expect(listed).not.toContain("browser.session.drive@1");
    const setUp = await tools(a, onA)("create_automation", {
      summary: "Ghi chú trên laptop",
      topic: "local.note.requested",
      action: "task",
      goal: "Write notes.md with today's note.",
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
      executor: identityOf(b).nodeId,
    });
    expect(setUp).toContain("Set up.");
    expect(setUp).toContain(
      `Warning: what ${identityOf(b).nodeId}'s owner allows this node there does not cover project.code.change@1, which this task needs`,
    );
  });
});

/** The files shown in a conversation: the artifact blocks of what the assistant said there. */
function shownFiles(node: LiveNode, conversationId: string): Extract<MessageBlock, { type: "artifact" }>[] {
  return allRows<{ document: string }>(
    node.services.runtime.db,
    "SELECT document FROM messages WHERE conversation_id = ? ORDER BY sequence",
    conversationId,
  ).flatMap((row) => {
    const message = parseJson<MessageRecord>(row.document, "messages.document");
    return message.role === "assistant" ? message.blocks.flatMap((block) => (block.type === "artifact" ? [block] : [])) : [];
  });
}

/** What a node queued for its peers, in the order each peer reads it. */
function sentBy(node: LiveNode): PeerEnvelope[] {
  return allRows<{ document: string }>(node.services.runtime.db, "SELECT document FROM outbox")
    .map((row) => JSON.parse(row.document) as PeerEnvelope)
    .sort((left, right) => left.sourceSequence - right.sourceSequence);
}

describe("the files a task handed to another Clark brings back", { timeout: 60_000 }, () => {
  const written = "viết từ máy bàn\n";
  const writtenDigest = `sha256:${createHash("sha256").update(written).digest("hex")}`;
  const writtenBytes = Buffer.byteLength(written);

  /** A and B paired by this build, each saying what it takes, with B's owner letting A write in B's folder. */
  async function allowingDesks(options: { advertise?: boolean } = { advertise: true }): Promise<{ a: Clark; b: Clark; onA: string }> {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b, options);
    const onA = await conversation(a, "Ghi chú");
    const onB = await conversation(b, "Máy bàn");
    await tools(b, onB)("allow_peer_tasks", {
      peer: identityOf(a).nodeId,
      folders: [{ path: b.root, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    return { a, b, onA };
  }

  async function ranTask(a: Clark, onA: string, outcome: "Xong" | "Không xong" = "Xong"): Promise<string> {
    await signal(a, "note-1");
    await waitUntil(() => said(a, onA).some((text) => text.startsWith(`${outcome} (task`)), "A to hear how the task ended");
    return String(tasksOn(a)[0]?.taskId);
  }

  it("brings a file the task wrote back to the sender within its owner's byte budget, and shows it with the result", async () => {
    const { a, b, onA } = await allowingDesks();
    const setUp = await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"], { maxArtifactBytes: 1024 });
    expect(setUp).toContain("Files a run writes there come back here, up to 1024 bytes per run.");

    const taskId = await ranTask(a, onA);
    await waitUntil(() => listTaskArtifacts(a.services.runtime.db, taskId, "received")[0]?.state === "received", "the file to reach A");
    await waitUntil(() => shownFiles(a, onA).length === 1, "A to show the file");

    // B offered the file as its worker wrote it, and the answer that followed names it by that offer.
    const sent = sentBy(b);
    const offer = sent.find((envelope) => envelope.kind === "artifact.offer");
    const result = sent.find((envelope) => envelope.kind === "result");
    expect(offer?.taskId).toBe(taskId);
    expect(offer?.payload).toMatchObject({ name: "notes.md", digest: writtenDigest, sizeBytes: writtenBytes });
    expect(Number(offer?.sourceSequence)).toBeLessThan(Number(result?.sourceSequence));
    const offered = offer?.payload["artifact"] as { artifactId: string };
    expect((result?.payload["evidence"] as { artifacts?: unknown[] }).artifacts).toEqual([
      { artifactId: offered.artifactId, digest: writtenDigest, name: "notes.md", sizeBytes: writtenBytes, mimeType: "text/markdown" },
    ]);
    expect(listTaskArtifacts(b.services.runtime.db, taskId, "offered")).toMatchObject([{ peerArtifactId: offered.artifactId, state: "offered" }]);
    // The offer names the file by where it sits in the folder, and carries no path on B.
    const offerDocument = JSON.stringify(offer);
    expect(offerDocument).not.toContain(JSON.stringify(b.root).slice(1, -1));
    expect(offerDocument).not.toContain(JSON.stringify(b.services.runtime.dataDir).slice(1, -1));

    // A holds the bytes, checked against the digest, as an artifact from B attached to its own task's run.
    const [file] = listTaskArtifacts(a.services.runtime.db, taskId, "received");
    const artifact = getArtifact(a.services.runtime.db, String(file?.artifactId));
    expect(artifact).toMatchObject({ digest: writtenDigest, sizeBytes: writtenBytes, mimeType: "text/markdown", originNodeId: identityOf(b).nodeId });
    const stored = readBlob({
      dataDir: a.services.runtime.dataDir,
      blobPath: String(blobPathForDigest({ dataDir: a.services.runtime.dataDir, digest: writtenDigest })),
    });
    expect(stored.ok && Buffer.from(stored.bytes).toString("utf8")).toBe(written);
    const home = getTask(a.services.runtime.db, taskId);
    expect(home?.state).toBe("succeeded");
    const evidence = allRows<{ kind: string; verdict: string; ref: string | null; digest: string | null }>(
      a.services.runtime.db,
      "SELECT kind, verdict, ref, digest FROM evidence WHERE run_id = ? ORDER BY kind",
      String(home?.activeRunId),
    );
    expect(evidence).toEqual([
      { kind: "api-receipt", verdict: "verified", ref: null, digest: null },
      { kind: "file-version", verdict: "verified", ref: `artifact:${String(file?.artifactId)}`, digest: writtenDigest },
    ]);

    // Shown once, where the result is said: with the result when it arrived first, or just after it when not.
    expect(shownFiles(a, onA)).toEqual([
      {
        type: "artifact",
        artifactId: file?.artifactId,
        mimeType: "text/markdown",
        sizeBytes: writtenBytes,
        digest: writtenDigest,
        label: "notes.md",
        originNodeId: identityOf(b).nodeId,
      },
    ]);
    const told = said(a, onA);
    expect(
      told.some((text) => text.startsWith(`Xong (task ${taskId})`) && text.includes("Tệp: đã nhận notes.md.")) ||
        told.includes(`Đã nhận tệp notes.md từ ${identityOf(b).nodeId} cho task ${taskId}.`),
    ).toBe(true);
  });

  it("fetches, when it starts again, a file it accepted and had not received, and says it arrived", async () => {
    const { a, b, onA } = await allowingDesks();
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"], { maxArtifactBytes: 1024 });
    const taskId = await ranTask(a, onA);
    await waitUntil(() => listTaskArtifacts(a.services.runtime.db, taskId, "received")[0]?.state === "received", "the file to reach A");

    // A second file B offered and A accepted, whose bytes had not arrived when A stopped.
    const now = (): Instant => new Date().toISOString() as Instant;
    insertTaskArtifact(a.services.runtime.db, {
      taskId,
      direction: "received",
      peerArtifactId: "art_left_waiting",
      peerNodeId: identityOf(b).nodeId,
      name: "notes-copy.md",
      digest: writtenDigest,
      sizeBytes: writtenBytes,
      mimeType: "text/markdown",
      state: "accepted",
      at: now(),
    });

    expect(resumeArtifactIntake(artifactIntakeDeps(a.services, now))).toBe(1);
    await waitUntil(() => getTaskArtifact(a.services.runtime.db, taskId, "received", "art_left_waiting")?.state === "received", "the file to be fetched");
    await waitUntil(
      () => said(a, onA).includes(`Đã nhận tệp notes-copy.md từ ${identityOf(b).nodeId} cho task ${taskId}.`),
      "A to say the file arrived after the result",
    );
    expect(shownFiles(a, onA).map((block) => block.label)).toContain("notes-copy.md");
    // Nothing waits any more.
    expect(resumeArtifactIntake(artifactIntakeDeps(a.services, now))).toBe(0);
  });

  it("refuses a file larger than the sender's byte budget, and says why with the result", async () => {
    const { a, b, onA } = await allowingDesks();
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"], { maxArtifactBytes: 4 });

    const taskId = await ranTask(a, onA);

    expect(said(a, onA).find((text) => text.startsWith(`Xong (task ${taskId})`))).toContain(
      `Tệp: không nhận notes.md: the file is ${String(writtenBytes)} bytes and the automation allows 4 bytes of files back per run.`,
    );
    expect(listTaskArtifacts(a.services.runtime.db, taskId, "received")).toMatchObject([{ state: "refused", digest: writtenDigest }]);
    expect(allRows(a.services.runtime.db, "SELECT artifact_id FROM artifacts")).toEqual([]);
    expect(blobPathForDigest({ dataDir: a.services.runtime.dataDir, digest: writtenDigest })).toBeUndefined();
    expect(shownFiles(a, onA)).toEqual([]);
    expect(sentBy(b).filter((envelope) => envelope.kind === "artifact.offer")).toHaveLength(1);
  });

  it("takes no file back when the sender's owner allowed no bytes, and says so", async () => {
    const { a, b, onA } = await allowingDesks();
    const setUp = await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"]);
    expect(setUp).toContain("Files a run writes there stay there; set maxArtifactBytes to bring them back here.");

    const taskId = await ranTask(a, onA);

    expect(said(a, onA).find((text) => text.startsWith(`Xong (task ${taskId})`))).toContain(
      "Tệp: không nhận notes.md: the automation that handed this task over allows no file bytes back.",
    );
    expect(listTaskArtifacts(a.services.runtime.db, taskId, "received")).toMatchObject([{ state: "refused" }]);
    expect(allRows(a.services.runtime.db, "SELECT artifact_id FROM artifacts")).toEqual([]);
    expect(blobPathForDigest({ dataDir: a.services.runtime.dataDir, digest: writtenDigest })).toBeUndefined();
    expect(readFileSync(join(b.root, "notes.md"), "utf8")).toBe(written);
  });

  it("offers nothing to a sender that has not said it takes files, and answers it as before", async () => {
    // Paired as a build from before this: B has not heard A say it takes files when the task ends.
    const { a, b, onA } = await allowingDesks({ advertise: false });
    await handToLaptop(a, b, onA, [{ path: b.root, access: "write" }], ["read", "local-write"], { maxArtifactBytes: 1024 });
    expect(getPeer(b.services.runtime.db, identityOf(a).nodeId)?.features ?? []).not.toContain("artifacts");

    const taskId = await ranTask(a, onA);
    await waitUntil(() => pendingOutbox(b.services.runtime.db).length === 0, "B's answer to be delivered");

    const sent = sentBy(b);
    expect(sent.filter((envelope) => envelope.kind === "artifact.offer")).toEqual([]);
    const result = sent.find((envelope) => envelope.kind === "result");
    expect(result?.payload["evidence"]).not.toHaveProperty("artifacts");
    expect(said(a, onA).find((text) => text.startsWith(`Xong (task ${taskId})`))).not.toContain("Tệp:");
    expect(listTaskArtifacts(a.services.runtime.db, taskId, "received")).toEqual([]);
    expect(listTaskArtifacts(b.services.runtime.db, taskId, "offered")).toEqual([]);
  });
});

/** B's owner decides the approval B's task waits on, the way the approval card does. */
async function decide(node: LiveNode, taskId: string, decision: "granted" | "denied"): Promise<void> {
  const [approval] = allRows<{ approval_id: string; operation_digest: string }>(
    node.services.runtime.db,
    "SELECT approval_id, operation_digest FROM approvals WHERE task_id = ? AND decision = 'pending'",
    taskId,
  );
  if (approval === undefined) throw new Error(`no pending approval for ${taskId}`);
  const decided = await call(node, `/tasks/${taskId}/approvals/${approval.approval_id}/decide`, {
    body: { decision, digest: approval.operation_digest },
    token: node.token,
  });
  expect(decided.status).toBe(200);
}

/** Whether A's inbox, as its owner reads it, still says the task waits on the other node's owner. */
function waitingOnA(node: LiveNode, taskId: string): boolean {
  return (
    allRows(
      node.services.runtime.db,
      "SELECT notification_id FROM notifications WHERE dismissed_at IS NULL AND substr(dedup_key, 1, ?) = ?",
      `delegation-status:${taskId}:`.length,
      `delegation-status:${taskId}:`,
    ).length > 0
  );
}

/** What a node's inbox says is waiting for its owner, read through the route the surface reads. */
async function waitingOn(node: LiveNode): Promise<unknown[]> {
  const inbox = await call(node, "/inbox", { method: "GET", token: node.token });
  expect(inbox.status).toBe(200);
  return inbox.body["waiting"] as unknown[];
}

function onlyIntentId(node: LiveNode): string {
  const rows = allRows<{ intent_id: string }>(node.services.runtime.db, "SELECT intent_id FROM persistent_intents ORDER BY created_at");
  if (rows[0] === undefined) throw new Error("no automation");
  return rows[0].intent_id;
}

function actionGrantId(node: LiveNode, intentId: string): string {
  const intent = getPersistentIntent(node.services.runtime.db, intentId);
  if (intent?.do.kind !== "task" || intent.do.grantId === undefined) throw new Error("no grant recorded on the automation");
  return intent.do.grantId;
}

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
