import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, type Principal } from "@clarkcant/contracts";
import { createTask, requestApproval } from "@clarkcant/core";
import { appendMessage, nextMessageSequence } from "@clarkcant/storage";

import { sweepExpired } from "../src/expiry-notices.ts";
import { QUESTION_TTL_MS, createQuestion } from "../src/interactions.ts";
import { readInbox } from "../src/inbox.ts";
import { interactionDepsFor } from "../src/routes/conversations.ts";
import { commandDigest } from "../src/run-command.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The sweep that notices what nobody answered.
 *
 * A waiting item drops off the inbox silently the moment its deadline passes - that silence is the point for the
 * list, and the reason this sweep exists: the person who never looked deserves one sentence saying that a command
 * never ran, or a question never got answered, pointing at the conversation it happened in.
 */

const AT = "2026-09-24T07:00:00.000Z" as Instant;
const PRINCIPAL: Principal = { principalId: "user_expiry_test", kind: "user", nodeId: "node_test" as never };

let dir: string;
let services: NodeServices;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-expiry-"));
  services = bootNodeServices({ dataDir: dir, label: "expiry test node" });
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function createConversation(): Promise<string> {
  const conversationId = `conv_expiry_${services.conductor.newId("id")}`;
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run(conversationId, services.runtime.identity.nodeId, AT, AT);
  return conversationId;
}

/** The card a model turn would have produced, for a command approval that a person never decided. */
function proposeCommand(conversationId: string, command: string, ttlMs: number) {
  const approval = requestApproval(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => AT, newId: services.conductor.newId },
    { operationDigest: commandDigest(command, dir), operationDescription: `Chạy lệnh trong ${dir}`, effectCategory: "local-write", ttlMs },
  );
  const message = {
    messageId: services.conductor.newId("msg"),
    conversationId,
    role: "assistant" as const,
    blocks: [
      {
        type: "approval-card",
        owner: "host",
        approvalId: approval.approvalId,
        operationDescription: approval.operationDescription,
        operationDigest: approval.operationDigest,
        effectCategory: "local-write",
        expiresAt: approval.expiresAt,
        decider: "user",
        decision: "pending",
        payload: JSON.stringify({ command, cwd: dir }),
      },
    ],
    authorNodeId: services.runtime.identity.nodeId,
    createdAt: AT,
    delivery: "accepted" as const,
  };
  appendMessage(services.runtime.db, message as never, nextMessageSequence(services.runtime.db, conversationId));
  return approval;
}

/** A task approval as the execution-policy gate raises it: no card, bound to the task by `taskId` alone. */
function raiseTaskApproval(conversationId: string, ttlMs: number) {
  const task = createTask(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => AT, newId: services.conductor.newId },
    { conversationId: conversationId as never, goal: "chạy lệnh git status", principal: PRINCIPAL },
  );
  const approval = requestApproval(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => AT, newId: services.conductor.newId },
    {
      taskId: task.taskId,
      operationDigest: `sha256:task-effect:${task.taskId}:demo.write@1`,
      operationDescription: "ghi một file demo",
      effectCategory: "local-write",
      ttlMs,
    },
  );
  return { task, approval };
}

function askQuestion(conversationId: string) {
  const created = createQuestion(
    { ...interactionDepsFor(services, conversationId), now: () => AT },
    { question: "Chọn môi trường triển khai.", kind: "single-choice", options: [{ id: "staging", label: "Staging" }, { id: "production", label: "Production" }] },
  );
  if (!created.ok) throw new Error("test setup: the question was not created");
  return created;
}

function laterBy(ms: number): Instant {
  return new Date(Date.parse(AT) + ms).toISOString() as Instant;
}

describe("noticing what expired unanswered", () => {
  it("records one notice for a command approval nobody decided, pointing at its conversation, and never twice", async () => {
    const conversationId = await createConversation();
    const approval = proposeCommand(conversationId, "git status", 60_000);
    const past = laterBy(120_000);

    sweepExpired(services, past);
    sweepExpired(services, past);

    const notices = readInbox(services, past).notices;
    const matching = notices.filter((notice) => notice.title.includes("hết hạn"));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ conversationId, severity: "warning", body: expect.stringContaining(dir) });
    void approval;
  });

  it("records one notice for a task approval nobody decided, pointing at the task's conversation", async () => {
    const conversationId = await createConversation();
    raiseTaskApproval(conversationId, 60_000);
    const past = laterBy(120_000);

    sweepExpired(services, past);
    sweepExpired(services, past);

    const notices = readInbox(services, past).notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ conversationId, severity: "warning" });
  });

  it("records one notice for a question nobody answered, pointing at its conversation, and closes it the same way answering would", async () => {
    const conversationId = await createConversation();
    const created = askQuestion(conversationId);
    const past = laterBy(QUESTION_TTL_MS + 60_000);

    sweepExpired(services, past);
    sweepExpired(services, past);

    const notices = readInbox(services, past).notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      conversationId,
      severity: "warning",
      body: "Chọn môi trường triển khai.",
    });
    expect(readInbox(services, past).waiting).toEqual([]);
    void created;
  });

  it("does not notice anything still inside its deadline", async () => {
    const conversationId = await createConversation();
    proposeCommand(conversationId, "git status", 900_000);
    raiseTaskApproval(conversationId, 900_000);
    askQuestion(conversationId);

    sweepExpired(services, AT);

    expect(readInbox(services, AT).notices).toEqual([]);
  });

  it("does not notice a capability approval, which has no conversation to point at", async () => {
    requestApproval(
      { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => AT, newId: services.conductor.newId },
      { operationDigest: "sha256:mot-goi", operationDescription: "Cài gói mở rộng", effectCategory: "local-write", ttlMs: 60_000 },
    );
    const past = laterBy(120_000);

    sweepExpired(services, past);

    expect(readInbox(services, past).notices).toEqual([]);
  });
});
