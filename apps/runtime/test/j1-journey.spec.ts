import { beforeEach, describe, expect, it } from "vitest";

import { QUICK_PLAY_RECIPES } from "@clarkcant/data-canvas/sample";
import { instantSchema, nodeIdSchema, principalIdSchema, type MessageRecord } from "@clarkcant/contracts";
import { createConversation, getConversation, migrate, openDatabase, oneRow } from "@clarkcant/storage";
import { handleUserMessage, registerCapability, runDispatchedTask } from "@clarkcant/core";

/**
 * Journey J1 — "curiosity".
 *
 * The blueprint requires this journey to work with **no provider credentials**: open the
 * app, try something immediately, interact with a sample chart, a note and a pin, and
 * understand how chat works. It also requires the sample to be labelled and not dressed
 * up as inference over the user's own data.
 *
 * These tests assert both halves. The second half is the part usually skipped: that a
 * real capability, once installed, takes precedence over the demo, and that the demo
 * cannot claim to be live.
 */

const AT = instantSchema.parse("2026-09-16T04:00:00.000Z");
const NODE = nodeIdSchema.parse("node_local");
const OWNER = principalIdSchema.parse("prin_owner");
const CONVERSATION = "conv_j1" as never;

let counter = 0;
function build() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  createConversation(db, { conversationId: CONVERSATION, homeNodeId: NODE, title: "J1", at: AT });
  return {
    db,
    nodeId: NODE,
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
    sampleRecipes: QUICK_PLAY_RECIPES,
  };
}

let deps: ReturnType<typeof build>;
beforeEach(() => {
  deps = build();
});

const ask = (text: string) =>
  handleUserMessage(deps, {
    conversationId: CONVERSATION,
    principal: { principalId: OWNER, kind: "user", nodeId: NODE },
    text,
    at: AT,
  });

function blocksOf(messages: MessageRecord[]) {
  return messages.flatMap((message) => message.blocks);
}

describe("J1: an empty install still does something useful", () => {
  it("answers a chart request with a widget, a snapshot and a sample label", () => {
    const outcome = ask("cho tui xem biểu đồ");
    expect(outcome.resolution).toBe("sample");
    // A sample needs no durable task: nothing is running, so claiming one would be a lie.
    expect(outcome.taskId).toBeUndefined();

    const blocks = blocksOf(outcome.messages);
    const types = blocks.map((block) => block.type);
    expect(types).toContain("system-card");
    expect(types).toContain("surface");
    expect(types).toContain("widget-ref");
    expect(types).toContain("text");
  });

  it("labels the sample as sample data, in a host-owned card", () => {
    const outcome = ask("cho tui xem biểu đồ");
    const card = blocksOf(outcome.messages).find((block) => block.type === "system-card");
    expect(card).toBeDefined();
    if (card?.type !== "system-card") return;

    // Host-owned, so a pack or a model cannot forge this label.
    expect(card.owner).toBe("host");
    expect(card.detail).toContain("dữ liệu mẫu");
    expect(card.detail).toContain("không có model nào được gọi");
    const freshness = card.fields.find((field) => field.label === "Nguồn dữ liệu");
    expect(freshness?.value).toBe("sample");
    expect(freshness?.freshness).toBe("sample");
  });

  it("creates a real widget instance and snapshot so the surface can be re-rendered later", () => {
    ask("cho tui xem biểu đồ");
    const instance = oneRow<{ instance_id: string }>(
      deps.db,
      "SELECT instance_id FROM widget_instances ORDER BY rowid DESC LIMIT 1",
    );
    expect(instance).toBeDefined();

    const snapshot = oneRow<{ document: string; captured_revision: number }>(
      deps.db,
      "SELECT document, captured_revision FROM widget_snapshots ORDER BY rowid DESC LIMIT 1",
    );
    expect(snapshot?.captured_revision).toBe(1);
    // History must stay readable without the renderer, so a text alternative is mandatory.
    expect(snapshot?.document).toContain("textAlternative");
  });

  it("records the user's own message in the timeline before answering", () => {
    ask("cho tui xem biểu đồ");
    const rows = deps.db
      .prepare("SELECT role FROM messages WHERE conversation_id = ? ORDER BY sequence")
      .all(CONVERSATION) as { role: string }[];
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
  });

  it("offers a note that needs no network and no model", () => {
    const outcome = ask("tạo note nhanh cho tui");
    const blocks = blocksOf(outcome.messages);
    const surface = blocks.find((block) => block.type === "surface");
    expect(surface).toBeDefined();
    if (surface?.type !== "surface") return;
    expect(surface.definitionRef?.id).toBe("canvas.note@1");
    expect(surface.snapshot.textAlternative).toContain("plain text");
  });

  it("falls through to a useful default rather than admitting it cannot do anything", () => {
    const outcome = ask("hello");
    expect(outcome.resolution).toBe("sample");
    const text = blocksOf(outcome.messages)
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.content : ""))
      .join(" ");
    // The empty state should hint at the next step, not just render a demo.
    expect(text).toContain("capability");
  });

  it("answers a table request with a table over the sample dataset", () => {
    const outcome = ask("cho tui xem bảng dữ liệu");
    const surface = blocksOf(outcome.messages).find((block) => block.type === "surface");
    expect(surface?.type === "surface" && surface.definitionRef?.id).toBe("canvas.table@1");
  });
});

describe("J1: a real capability is never shadowed by the demo", () => {
  it("prefers an installed capability and creates a durable task instead of a sample", () => {
    registerCapability(deps, {
      ref: "project.code.change@1" as never,
      executionNodeId: NODE,
      summary: "apply a bounded code change",
      resourceKinds: ["workspace"],
      effectCategory: "local-write",
      supportsCancellation: true,
      requiresConnection: false,
      readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      uiAffordances: [],
    });

    const outcome = ask("cho tui xem biểu đồ");
    expect(outcome.resolution).toBe("task-dispatched");
    expect(outcome.taskId).toBeDefined();
    // No sample card, because the registry could answer.
    const types = blocksOf(outcome.messages).map((block) => block.type);
    expect(types).not.toContain("surface");
  });

  it("parks a task on a capability rather than inventing a tool when nothing is installed", () => {
    const outcome = handleUserMessage(
      { ...deps, sampleRecipes: [] },
      {
        conversationId: CONVERSATION,
        principal: { principalId: OWNER, kind: "user", nodeId: NODE },
        text: "sửa file giúp tui",
        at: AT,
      },
    );
    expect(outcome.resolution).toBe("task-parked");
    expect(outcome.taskId).toBeDefined();

    const card = blocksOf(outcome.messages).find((block) => block.type === "system-card");
    expect(card?.type === "system-card" && card.subject).toBe("capability");
    expect(card?.type === "system-card" && card.status).toBe("blocked");

    const task = oneRow<{ state: string; waiting_capability_ref: string | null }>(
      deps.db,
      "SELECT state, waiting_capability_ref FROM tasks WHERE task_id = ?",
      outcome.taskId,
    );
    expect(task?.state).toBe("waiting_capability");
    expect(task?.waiting_capability_ref).toBe("project.code.change@1");
  });
});

describe("J1: run outcomes are decided by evidence, not by the worker stopping", () => {
  async function dispatched() {
    registerCapability(deps, {
      ref: "project.code.change@1" as never,
      executionNodeId: NODE,
      summary: "apply a bounded code change",
      resourceKinds: ["workspace"],
      effectCategory: "local-write",
      supportsCancellation: true,
      requiresConnection: false,
      readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      uiAffordances: [],
    });
    const outcome = ask("sửa file giúp tui");
    return outcome.taskId!;
  }

  it("reports failure, not success, when the run produces no evidence", async () => {
    const taskId = await dispatched();
    const result = await runDispatchedTask(deps, { taskId, collectEvidence: async () => undefined });
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("no evidence");
  });

  it("reports failure when the evidence is recorded but not verified", async () => {
    const taskId = await dispatched();
    const result = await runDispatchedTask(deps, {
      taskId,
      collectEvidence: async () => ({ kind: "test-output", summary: "2 of 5 tests failed", verified: false }),
    });
    expect(result.outcome).toBe("failed");
  });

  it("reports success only with verified evidence, and records the event trail", async () => {
    const taskId = await dispatched();
    const result = await runDispatchedTask(deps, {
      taskId,
      collectEvidence: async () => ({ kind: "file-diff", summary: "the fixture file changed as expected", verified: true }),
    });
    expect(result.outcome).toBe("succeeded");

    const task = oneRow<{ state: string; disposition: string }>(
      deps.db,
      "SELECT state, disposition FROM tasks WHERE task_id = ?",
      taskId,
    );
    expect(task).toEqual({ state: "succeeded", disposition: "succeeded" });

    const events = deps.db
      .prepare("SELECT kind FROM events WHERE task_id = ? ORDER BY source_sequence")
      .all(taskId) as { kind: string }[];
    expect(events.map((event) => event.kind)).toContain("task.state_changed");
    expect(events.map((event) => event.kind)).toContain("evidence.recorded");
  });

  it("leaves the conversation title and update time coherent after the exchange", () => {
    ask("cho tui xem biểu đồ");
    const conversation = getConversation(deps.db, CONVERSATION);
    expect(conversation?.updatedAt).toBe(AT);
  });
});
