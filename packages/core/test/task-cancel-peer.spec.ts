import { beforeEach, describe, expect, it } from "vitest";

import { instantSchema, nodeIdSchema, peerEnvelopeSchema, principalIdSchema, validatePeerEnvelope } from "@clarkcant/contracts";
import { getTask, migrate, openDatabase, pendingOutbox } from "@clarkcant/storage";

import { applyTaskEvent, cancelTask, createTask } from "../src/index.ts";

/**
 * Cancelling a task whose run is on a peer.
 *
 * `cancelTask` can only ever record the request locally — it has no way to observe what an executor
 * elsewhere is doing. When that executor is a peer rather than this node, recording the request is not
 * enough: nothing tells the peer to actually stop. These tests are about the message that closes that
 * gap: a `cancel.request` NodeLink envelope, queued through the same durable outbox every other
 * cross-node message uses, addressed only when there is somewhere else to address it.
 */

const AT = instantSchema.parse("2026-09-16T04:00:00.000Z");
const NODE_A = nodeIdSchema.parse("node_a");
const NODE_B = nodeIdSchema.parse("node_b");
const USER = { principalId: principalIdSchema.parse("prin_owner"), kind: "user" as const, nodeId: NODE_A };

let counter = 0;

function makeDeps() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  db.prepare(
    "INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)",
  ).run("conv_1", NODE_A, AT, AT);
  return {
    db,
    nodeId: NODE_A,
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  };
}

let deps: ReturnType<typeof makeDeps>;

beforeEach(() => {
  deps = makeDeps();
});

function newTask() {
  return createTask(deps, { conversationId: "conv_1" as never, goal: "đồng bộ dữ liệu", principal: USER });
}

describe("cancelTask against a peer-executed run", () => {
  it("enqueues a cancel.request envelope to the peer holding the run", () => {
    const task = newTask();
    applyTaskEvent(deps, task.taskId, "resolve.start", {
      executionNodeId: NODE_B as never,
      activeRunId: "run_1" as never,
    });

    const outcome = cancelTask(deps, task.taskId);
    if (!outcome.ok) throw new Error(`expected success, got ${outcome.code}: ${outcome.message}`);
    expect(outcome.confirmed).toBe(false);
    expect(getTask(deps.db, task.taskId)?.state).toBe("cancel_requested");

    const queued = pendingOutbox(deps.db, NODE_B);
    expect(queued).toHaveLength(1);

    const envelope = peerEnvelopeSchema.parse(queued[0]);
    expect(envelope.kind).toBe("cancel.request");
    expect(envelope.senderNodeId).toBe(NODE_A);
    expect(envelope.recipientNodeId).toBe(NODE_B);
    expect(envelope.taskId).toBe(task.taskId);
    expect(envelope.runId).toBe("run_1");
    expect(envelope.payload["reason"]).toBeTypeOf("string");

    // What actually matters: the peer's own gateway would accept this envelope, not merely that it
    // parses against the schema locally.
    const validation = validatePeerEnvelope(envelope, {
      authenticatedSenderNodeId: NODE_A,
      supportedVersions: { min: 1, max: 2 },
      lastSeenSequence: undefined,
      knownDelegationIds: new Set(),
    });
    expect(validation.valid).toBe(true);
  });

  it("does not enqueue anything when the run is on this node itself", () => {
    const task = newTask();
    applyTaskEvent(deps, task.taskId, "resolve.start", {
      executionNodeId: NODE_A as never,
      activeRunId: "run_1" as never,
    });

    const outcome = cancelTask(deps, task.taskId);
    if (!outcome.ok) throw new Error(`expected success, got ${outcome.code}: ${outcome.message}`);
    expect(outcome.confirmed).toBe(false);
    expect(pendingOutbox(deps.db, NODE_A)).toEqual([]);
    expect(pendingOutbox(deps.db)).toEqual([]);
  });

  it("does not enqueue anything when there is no run in flight, even with a remote executionNodeId on record", () => {
    const task = newTask();
    applyTaskEvent(deps, task.taskId, "resolve.start", { executionNodeId: NODE_B as never });

    const outcome = cancelTask(deps, task.taskId);
    if (!outcome.ok) throw new Error(`expected success, got ${outcome.code}: ${outcome.message}`);
    // Confirmed on the spot, matching the existing "dispatched but nothing running" behaviour.
    expect(outcome.confirmed).toBe(true);
    expect(pendingOutbox(deps.db, NODE_B)).toEqual([]);
  });

  it("assigns increasing sourceSequence numbers to a peer across repeated cancellations of different tasks", () => {
    const first = newTask();
    applyTaskEvent(deps, first.taskId, "resolve.start", { executionNodeId: NODE_B as never, activeRunId: "run_1" as never });
    cancelTask(deps, first.taskId);

    const second = newTask();
    applyTaskEvent(deps, second.taskId, "resolve.start", { executionNodeId: NODE_B as never, activeRunId: "run_2" as never });
    cancelTask(deps, second.taskId);

    const queued = pendingOutbox(deps.db, NODE_B).map((doc) => peerEnvelopeSchema.parse(doc));
    expect(queued.map((envelope) => envelope.sourceSequence).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
