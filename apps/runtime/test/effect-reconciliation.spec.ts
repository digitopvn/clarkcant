import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceEffect,
  type CapabilityRef,
  type Instant,
  type Principal,
  effectReconcileResponseSchema,
  inboxResponseSchema,
} from "@clarkcant/contracts";
import {
  advanceResolving,
  applyTaskEvent,
  createTask,
  markEffectUnknown,
  prepareEffect,
  recordEvidence,
  settleDispatchedTask,
  type TaskServiceDeps,
} from "@clarkcant/core";
import { allRows, getEffect, getTask, upsertEffect } from "@clarkcant/storage";

import { decideAppIntent } from "../src/app-intents.ts";
import { sweepUnknownEffects, unknownEffectFollowUpKey } from "../src/effect-notices.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { recordNodeNotice } from "../src/notices.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import type { TaskDispatcher } from "../src/task-dispatch.ts";

/**
 * Answering an effect whose outcome nobody observed, over the wire (#273).
 *
 * The rows are written the way the command broker writes them and the notice the way the sweep does, so what is under
 * test is the whole loop a person sees: one notice offering the two answers, one answer recorded through the ledger,
 * the notice gone and not written again, and the conversation told how the task ended.
 */

const AT = "2026-09-30T07:00:00.000Z" as Instant;

let dir: string;
let services: NodeServices;
let deps: TaskServiceDeps;
let gateway: GatewayDeps;
let owner: Principal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-effect-reconcile-"));
  services = bootNodeServices({ dataDir: dir, label: "effect reconcile test node" });
  deps = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => AT, newId: services.conductor.newId };
  gateway = { services, now: () => AT, newConversationId: () => `conv_${services.conductor.newId("id")}` };
  owner = { principalId: services.runtime.identity.ownerPrincipalId as never, kind: "user", nodeId: services.runtime.identity.nodeId as never };
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function request(method: string, path: string, body?: unknown): Promise<GatewayResponse> {
  return handleRequest(gateway, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

function runningTask(goal: string, principal: Principal = owner): { taskId: string; conversationId: string } {
  const conversationId = `conv_reconcile_${services.conductor.newId("id")}`;
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run(conversationId, services.runtime.identity.nodeId, AT, AT);
  const task = createTask(deps, { conversationId: conversationId as never, goal, principal });
  applyTaskEvent(deps, task.taskId, "resolve.start");
  advanceResolving(deps, task.taskId, { kind: "ready", executionNodeId: services.runtime.identity.nodeId });
  applyTaskEvent(deps, task.taskId, "dispatch.acknowledged");
  return { taskId: task.taskId, conversationId };
}

/** Handed off, then never heard from, through the same call the broker makes. */
function unknownEffect(taskId: string, intent: string): string {
  const prepared = prepareEffect(deps, {
    taskId,
    executorNodeId: services.runtime.identity.nodeId,
    category: "external-write",
    capabilityRef: "project.command.run@1" as CapabilityRef,
    intent,
    operationDigest: `sha256:${intent}`,
    externalSupportsDedup: false,
  });
  const submitted = advanceEffect(prepared, { to: "submitted", at: AT });
  if (!submitted.ok) throw new Error(submitted.message);
  upsertEffect(services.runtime.db, submitted.effect);
  if (!markEffectUnknown(deps, prepared.effectId, "the command ran out of time").ok) {
    services.runtime.db.prepare("UPDATE effects SET state = 'unknown' WHERE effect_id = ?").run(prepared.effectId);
  }
  return prepared.effectId;
}

function verified(taskId: string): void {
  recordEvidence(deps, { taskId, evidence: { kind: "test-output", summary: "the checks passed", verdict: "verified" } });
}

type StoredNotice = { dedup_key: string; dismissed_at: string | null };

function storedNotices(taskId: string): StoredNotice[] {
  return allRows(
    services.runtime.db,
    "SELECT dedup_key, dismissed_at FROM notifications WHERE dedup_key = ? OR dedup_key LIKE ? ORDER BY rowid",
    `worker:${taskId}`,
    `worker:${taskId}:%`,
  );
}

async function inbox() {
  const response = await request("GET", "/inbox");
  expect(response.status).toBe(200);
  return inboxResponseSchema.parse(response.body);
}

function assistantTexts(conversationId: string): string[] {
  return allRows<{ document: string }>(
    services.runtime.db,
    "SELECT document FROM messages WHERE conversation_id = ? ORDER BY rowid",
    conversationId,
  ).flatMap((row) => {
    const message = JSON.parse(row.document) as { role: string; blocks: { type: string; content?: string }[] };
    return message.role === "assistant" ? message.blocks.map((block) => block.content ?? "") : [];
  });
}

describe("POST /effects/:effectId/reconcile", () => {
  it("records the answer, resolves the one notice, settles the task and tells its conversation", async () => {
    const { taskId, conversationId } = runningTask("mở pull request cho bản sửa");
    verified(taskId);
    const effectId = unknownEffect(taskId, "git push origin HEAD — /work/repo");
    sweepUnknownEffects(services, AT);

    // One notice, offering the two answers as its buttons, both naming the effect.
    const before = (await inbox()).notices.filter((notice) => notice.subject?.kind === "task");
    expect(before).toHaveLength(1);
    expect(before[0]?.actions?.slice(0, 2)).toEqual([
      { id: "reconcile-confirmed", placement: "primary", effectId },
      { id: "reconcile-failed", placement: "secondary", effectId },
    ]);

    const response = await request("POST", `/effects/${effectId}/reconcile`, { outcome: "confirmed" });

    expect(response.status).toBe(200);
    expect(effectReconcileResponseSchema.parse(response.body)).toEqual({
      effectId,
      taskId,
      outcome: "confirmed",
      taskState: "succeeded",
      settled: "succeeded",
      remainingUnknown: 0,
    });
    expect(getEffect(services.runtime.db, effectId)?.state).toBe("confirmed");
    expect(getTask(services.runtime.db, taskId)?.state).toBe("succeeded");
    // The notice is resolved, and the task's own settled notice does not come back under the same key.
    expect(storedNotices(taskId)).toEqual([{ dedup_key: `worker:${taskId}`, dismissed_at: AT }]);
    expect((await inbox()).notices.filter((notice) => notice.subject?.kind === "task")).toEqual([]);
    // The conversation hears how it ended, on the person's word.
    expect(assistantTexts(conversationId).join("\n")).toContain(`task ${taskId}`);
    expect(assistantTexts(conversationId).join("\n")).toContain("bạn xác nhận “git push origin HEAD” đã có hiệu lực");
  });

  it("answers a second press with 409 and writes no second notice or message", async () => {
    const { taskId, conversationId } = runningTask("đẩy nhánh");
    const effectId = unknownEffect(taskId, "git push origin HEAD — /work/repo");
    sweepUnknownEffects(services, AT);
    expect((await request("POST", `/effects/${effectId}/reconcile`, { outcome: "failed" })).status).toBe(200);
    const said = assistantTexts(conversationId).length;

    const again = await request("POST", `/effects/${effectId}/reconcile`, { outcome: "confirmed" });
    sweepUnknownEffects(services, "2026-09-30T07:05:00.000Z" as Instant);

    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "EFFECT_NOT_UNKNOWN" });
    expect(getEffect(services.runtime.db, effectId)?.state).toBe("failed");
    expect(getTask(services.runtime.db, taskId)?.state).toBe("failed");
    expect(storedNotices(taskId)).toHaveLength(1);
    expect(assistantTexts(conversationId)).toHaveLength(said);
  });

  it("offers the two answers only while the effect is unknown", async () => {
    const { taskId } = runningTask("đẩy nhánh");
    const effectId = unknownEffect(taskId, "git push origin HEAD — /work/repo");
    sweepUnknownEffects(services, AT);
    await request("POST", `/effects/${effectId}/reconcile`, { outcome: "confirmed" });
    // Brought back by hand, the notice no longer asks: nothing about its task is unknown.
    services.runtime.db.prepare("UPDATE notifications SET dismissed_at = NULL WHERE dedup_key = ?").run(`worker:${taskId}`);

    const [notice] = (await inbox()).notices.filter((item) => item.subject?.kind === "task");

    expect(notice?.actions?.map((action) => action.id)).not.toContain("reconcile-confirmed");
    expect(notice?.actions?.map((action) => action.id)).not.toContain("reconcile-failed");
  });

  it("refuses what it cannot answer: an unknown id, another person's task, a bad body, another method", async () => {
    const theirs = runningTask("việc của người khác", { principalId: "someone_else" as never, kind: "user", nodeId: owner.nodeId });
    const theirEffect = unknownEffect(theirs.taskId, "git push origin theirs");

    expect((await request("POST", "/effects/eff_missing/reconcile", { outcome: "confirmed" })).status).toBe(404);
    expect((await request("POST", `/effects/${theirEffect}/reconcile`, { outcome: "confirmed" })).status).toBe(404);
    expect((await request("POST", `/effects/${theirEffect}/reconcile`, { outcome: "maybe" })).status).toBe(400);
    expect((await request("GET", `/effects/${theirEffect}/reconcile`)).status).toBe(405);
    expect(getEffect(services.runtime.db, theirEffect)?.state).toBe("unknown");
  });

  it("names the next unknown effect in one follow-up notice, and settles only on the last answer", async () => {
    const { taskId, conversationId } = runningTask("gửi hai thay đổi");
    const first = unknownEffect(taskId, "git push origin a — /work/repo");
    const second = unknownEffect(taskId, "git push origin b — /work/repo");
    sweepUnknownEffects(services, AT);

    const one = await request("POST", `/effects/${first}/reconcile`, { outcome: "confirmed" });
    sweepUnknownEffects(services, "2026-09-30T07:05:00.000Z" as Instant);

    expect(effectReconcileResponseSchema.parse(one.body)).toMatchObject({ remainingUnknown: 1, taskState: "uncertain" });
    expect(storedNotices(taskId)).toEqual([
      { dedup_key: `worker:${taskId}`, dismissed_at: AT },
      { dedup_key: unknownEffectFollowUpKey(taskId, second), dismissed_at: null },
    ]);
    const [followUp] = (await inbox()).notices.filter((notice) => notice.subject?.kind === "task");
    expect(followUp?.body).toContain("git push origin b");
    expect(followUp?.actions?.[0]).toEqual({ id: "reconcile-confirmed", placement: "primary", effectId: second });
    expect(assistantTexts(conversationId).at(-1)).toContain("Còn 1 thao tác khác");

    await request("POST", `/effects/${second}/reconcile`, { outcome: "failed" });

    expect(getTask(services.runtime.db, taskId)?.state).toBe("failed");
    expect(storedNotices(taskId).every((notice) => notice.dismissed_at === AT)).toBe(true);
  });

  it("records without settling while the task's run is still going, and the run's own report settles it", async () => {
    const { taskId, conversationId } = runningTask("mở pull request");
    const effectId = unknownEffect(taskId, "gh pr create --fill — /work/repo");
    services.taskDispatch = { holds: (id: string) => id === taskId } as unknown as TaskDispatcher;

    const response = await request("POST", `/effects/${effectId}/reconcile`, { outcome: "confirmed" });

    expect(effectReconcileResponseSchema.parse(response.body)).toMatchObject({ taskState: "uncertain" });
    expect(assistantTexts(conversationId).at(-1)).toContain("Việc vẫn đang chạy");

    const settled = settleDispatchedTask(services.conductor, taskId, { kind: "test-output", summary: "opened", verified: true });
    expect(settled.outcome).toBe("succeeded");
    expect(settled.message).toContain("đã có hiệu lực");
  });

  it("does not offer the answers on a notice a paired node sent about its own task", async () => {
    const { taskId, conversationId } = runningTask("việc trên máy khác");
    unknownEffect(taskId, "git push origin HEAD");
    recordNodeNotice(services, {
      sourceKind: "worker",
      category: "alert",
      severity: "warning",
      title: "Từ máy khác",
      conversationId,
      originNodeId: "node_peer",
      subject: { kind: "task", taskId, conversationId },
      dedupKey: "peer:node_peer:worker:x",
      at: AT,
    });

    const [notice] = (await inbox()).notices.filter((item) => item.title === "Từ máy khác");

    expect(notice?.actions?.map((action) => action.id)).not.toContain("reconcile-confirmed");
  });
});

describe("saying it took effect, typed or spoken", () => {
  const intentDeps = () => ({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => AT, newId: services.conductor.newId });
  const decide = (text: string, source: "chat" | "voice" | "agent" | "voice-agent" = "chat") =>
    decideAppIntent(intentDeps(), { principalId: services.runtime.identity.ownerPrincipalId, request: { text, source } }, () => {
      throw new Error("no confirmation is minted for an answer");
    });

  it("names the one waiting effect in the decision and its read-back", () => {
    const { taskId } = runningTask("đẩy nhánh");
    const effectId = unknownEffect(taskId, "git push origin HEAD — /work/repo");

    expect(decide("Đã có hiệu lực")).toEqual({
      kind: "intent",
      intent: { kind: "effect.confirmed", effectId },
      requiresConfirmation: false,
      readBack: "Tôi ghi nhận “git push origin HEAD” đã có hiệu lực nhé.",
    });
    expect(decide("chưa có hiệu lực", "voice")).toMatchObject({ kind: "intent", intent: { kind: "effect.failed", effectId } });
    // Only decided: nothing is recorded until the person's own screen calls the route.
    expect(getEffect(services.runtime.db, effectId)?.state).toBe("unknown");
  });

  it("refuses rather than guesses when nothing, or more than one thing, is waiting", () => {
    expect(decide("đã có hiệu lực")).toMatchObject({ kind: "refused", say: expect.stringContaining("Không có việc nào") });

    const { taskId } = runningTask("gửi hai thay đổi");
    unknownEffect(taskId, "git push origin a");
    unknownEffect(taskId, "git push origin b");

    expect(decide("đã có hiệu lực")).toMatchObject({ kind: "refused", say: expect.stringContaining("Có 2 việc") });
  });

  it("refuses the agent's own sources: the answer is the person's", () => {
    const { taskId } = runningTask("đẩy nhánh");
    unknownEffect(taskId, "git push origin HEAD");

    expect(decide("đã có hiệu lực", "agent")).toMatchObject({ kind: "refused" });
    expect(decide("đã có hiệu lực", "voice-agent")).toMatchObject({ kind: "refused" });
  });
});
