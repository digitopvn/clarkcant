import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityRef, ConversationId, Instant, Principal } from "@clarkcant/contracts";
import { advanceResolving, applyTaskEvent, createTask, handleUserMessage, updateReadiness } from "@clarkcant/core";
import { allRows, createConversation, getTask } from "@clarkcant/storage";

import { resumeTasksWaitingOnCapability } from "../src/capability-waiters.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/**
 * A task a person asked for while nothing could do it yet goes ahead once something can.
 *
 * Against a booted node and its real store: whether a task is still parked, and whether a restart finds it parked, is
 * the store's answer. The worker itself is not the subject, so the runner is a recorder.
 */

const AT = "2026-09-29T09:00:00.000Z" as Instant;
const CONVERSATION_ID = "conv_waiting" as ConversationId;
const CODE_CHANGE = "project.code.change@1" as CapabilityRef;

let dir: string;
let services: NodeServices;
let started: { taskId: string; capabilityRef: string; executionNodeId: string }[];

function boot(): NodeServices {
  const booted = bootNodeServices({ dataDir: dir, label: "capability waiters node" });
  started = [];
  booted.conductor.runTask = (input) => started.push(input);
  return booted;
}

function principal(): Principal {
  return { principalId: services.runtime.identity.ownerPrincipalId, kind: "user", nodeId: services.runtime.identity.nodeId as never };
}

/** What the project-work pack writes once a worker has loaded it and a run demonstrated something. */
function packReportsHealthy(): void {
  updateReadiness(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId },
    {
      ref: CODE_CHANGE,
      executionNodeId: services.runtime.identity.nodeId,
      change: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true, blockedReason: undefined },
      at: AT,
    },
  );
}

function said(text: string): string[] {
  return allRows<{ document: string }>(services.runtime.db, "SELECT document FROM messages WHERE conversation_id = ? ORDER BY sequence", CONVERSATION_ID)
    .map((row) => row.document)
    .filter((document) => document.includes(text));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-waiters-"));
  services = boot();
  createConversation(services.runtime.db, { conversationId: CONVERSATION_ID, homeNodeId: services.runtime.identity.nodeId, at: AT });
});

afterEach(async () => {
  services.runtime.close();
  await removeTestDirectory(dir);
});

describe("a task parked on a capability goes ahead when the capability becomes usable", () => {
  it("dispatches a person's task once after the pack reports healthy, and never again across a restart", async () => {
    // Asked while the pack is still loading: nothing can do it, so the task parks, as it always has.
    const outcome = await handleUserMessage(services.conductor, { conversationId: CONVERSATION_ID, principal: principal(), text: "sửa lỗi trong repo", at: AT });
    expect(outcome.resolution).toBe("task-parked");
    const taskId = outcome.taskId ?? "";
    expect(getTask(services.runtime.db, taskId)?.state).toBe("waiting_capability");

    // Nothing is usable yet: it stays parked.
    expect(resumeTasksWaitingOnCapability(services, { now: () => AT })).toEqual([]);
    expect(started).toEqual([]);

    packReportsHealthy();
    const resumed = resumeTasksWaitingOnCapability(services, { now: () => AT });

    const nodeId = services.runtime.identity.nodeId;
    expect(resumed).toEqual([{ taskId, conversationId: CONVERSATION_ID, capabilityRef: CODE_CHANGE, executionNodeId: nodeId }]);
    expect(started).toEqual([{ taskId, capabilityRef: CODE_CHANGE, executionNodeId: nodeId }]);
    expect(getTask(services.runtime.db, taskId)?.state).toBe("running");
    // The person is told once, in the task's conversation.
    expect(said(`task ${taskId} đang chờ nó giờ chạy tiếp`)).toHaveLength(1);

    // Asked again, it finds nothing waiting.
    expect(resumeTasksWaitingOnCapability(services, { now: () => AT })).toEqual([]);
    expect(started).toHaveLength(1);

    // And a restart does not find it waiting either: it left `waiting_capability` in the store, not in memory.
    services.runtime.close();
    services = boot();
    expect(resumeTasksWaitingOnCapability(services, { now: () => AT })).toEqual([]);
    expect(started).toEqual([]);
    expect(said(`task ${taskId} đang chờ nó giờ chạy tiếp`)).toHaveLength(1);
  });

  it("leaves an automation's parked task to the automation service", () => {
    const task = createTask(services.conductor, {
      conversationId: CONVERSATION_ID,
      goal: "fix the labelled issue",
      principal: principal(),
      origin: {
        kind: "persistent",
        principalId: principal().principalId,
        intentId: "intent_1",
        triggerSignalId: "signal_1",
        allowedCategories: ["read", "local-write"],
      },
    });
    applyTaskEvent(services.conductor, task.taskId, "resolve.start");
    advanceResolving(services.conductor, task.taskId, { kind: "needs-capability", capabilityRef: CODE_CHANGE });
    packReportsHealthy();

    expect(resumeTasksWaitingOnCapability(services, { now: () => AT })).toEqual([]);
    expect(started).toEqual([]);
    expect(getTask(services.runtime.db, task.taskId)?.state).toBe("waiting_capability");
  });

  it("moves nothing on a node that has no runner, rather than dispatching to nobody", async () => {
    const outcome = await handleUserMessage(services.conductor, { conversationId: CONVERSATION_ID, principal: principal(), text: "sửa lỗi trong repo", at: AT });
    packReportsHealthy();
    delete services.conductor.runTask;

    expect(resumeTasksWaitingOnCapability(services, { now: () => AT })).toEqual([]);
    expect(getTask(services.runtime.db, outcome.taskId ?? "")?.state).toBe("waiting_capability");
  });
});
