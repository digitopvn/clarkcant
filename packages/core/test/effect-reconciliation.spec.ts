import { beforeEach, describe, expect, it } from "vitest";

import { advanceEffect, type CapabilityRef, instantSchema, nodeIdSchema, principalIdSchema } from "@clarkcant/contracts";
import { allRows, getEffect, getTask, migrate, openDatabase, upsertEffect } from "@clarkcant/storage";

import {
  advanceResolving,
  answerableUnknownEffect,
  answerableUnknownEffects,
  applyTaskEvent,
  createTask,
  markEffectUnknown,
  prepareEffect,
  reconcileEffect,
  recordEvidence,
  settleReconciledTask,
} from "../src/index.ts";

/**
 * A person's answer to an effect nobody saw land, written through the ledger's own state machine.
 *
 * What matters is that the answer moves only an `unknown` effect, only for the person the task belongs to, and that the
 * task leaves `uncertain` honestly: on the person's word for the effect, and on the run's own evidence for the task.
 */

const AT = instantSchema.parse("2026-09-30T04:00:00.000Z");
const NODE = nodeIdSchema.parse("node_a");
const OWNER = principalIdSchema.parse("prin_owner");
const OTHER = principalIdSchema.parse("prin_other");

let counter = 0;

function makeDeps() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  db.prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)").run(
    "conv_1",
    NODE,
    AT,
    AT,
  );
  return { db, nodeId: NODE as string, now: () => AT, newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}` };
}

let deps: ReturnType<typeof makeDeps>;
beforeEach(() => {
  deps = makeDeps();
});

function runningTask(principalId: string = OWNER): string {
  const task = createTask(deps, {
    conversationId: "conv_1" as never,
    goal: "mở pull request",
    principal: { principalId: principalId as never, kind: "user", nodeId: NODE },
  });
  applyTaskEvent(deps, task.taskId, "resolve.start");
  advanceResolving(deps, task.taskId, { kind: "ready", executionNodeId: NODE });
  applyTaskEvent(deps, task.taskId, "dispatch.acknowledged");
  return task.taskId;
}

/** Handed off, then never heard from: what the command broker leaves for a push that timed out. */
function unknownEffect(taskId: string, intent = "git push origin HEAD — /work/repo", executorNodeId: string = NODE): string {
  const prepared = prepareEffect(deps, {
    taskId,
    executorNodeId,
    category: "external-write",
    capabilityRef: "project.command.run@1" as CapabilityRef,
    intent,
    operationDigest: `sha256:${intent}`,
    externalSupportsDedup: false,
  });
  const submitted = advanceEffect(prepared, { to: "submitted", at: AT });
  if (!submitted.ok) throw new Error(submitted.message);
  upsertEffect(deps.db, submitted.effect);
  const marked = markEffectUnknown(deps, prepared.effectId, "the command ran out of time");
  if (!marked.ok) {
    // A second unknown effect of a task that is already uncertain: the broker moves the row alone.
    deps.db.prepare("UPDATE effects SET state = 'unknown' WHERE effect_id = ?").run(prepared.effectId);
  }
  return prepared.effectId;
}

function answer(effectId: string, outcome: "confirmed" | "failed", options: { principalId?: string; settle?: boolean } = {}) {
  return reconcileEffect(deps, {
    effectId,
    outcome,
    principalId: options.principalId ?? OWNER,
    source: "click",
    settle: options.settle ?? true,
  });
}

describe("recording what an unknown effect did", () => {
  it("moves the effect through the ledger's state machine, saying who answered and when", () => {
    const taskId = runningTask();
    const effectId = unknownEffect(taskId);

    const result = answer(effectId, "confirmed");

    expect(result.ok).toBe(true);
    const effect = getEffect(deps.db, effectId);
    expect(effect?.state).toBe("confirmed");
    expect(effect?.settledAt).toBe(AT);
    expect(effect?.reconciliationEvidence).toBe(`recorded by ${OWNER} at ${AT}: it took effect`);
    const events = allRows<{ document: string }>(deps.db, "SELECT document FROM events WHERE kind = 'effect.reconciled'");
    expect(events.map((event) => JSON.parse(event.document))).toEqual([
      { taskId, effectId, outcome: "confirmed", decidedBy: OWNER, source: "click", at: AT },
    ]);
  });

  it("is not found for an id that does not exist or a task another person asked for", () => {
    const mine = runningTask();
    unknownEffect(mine);
    const theirs = unknownEffect(runningTask(OTHER));

    expect(answer("eff_missing", "confirmed")).toMatchObject({ ok: false, code: "EFFECT_NOT_FOUND" });
    expect(answer(theirs, "confirmed")).toMatchObject({ ok: false, code: "EFFECT_NOT_FOUND" });
    // Not answered either: the row is exactly as it was.
    expect(getEffect(deps.db, theirs)?.state).toBe("unknown");
    expect(answerableUnknownEffects({ db: deps.db, nodeId: NODE, principalId: OWNER }).map((effect) => effect.taskId)).toEqual([mine]);
  });

  it("is not found for an effect another node carried out, even for the person's own task", () => {
    const taskId = runningTask();
    // Carried out on a peer: only that node saw it handed off, so only that node's owner answers for it there.
    const elsewhere = unknownEffect(taskId, "git push origin HEAD — /peer/repo", "node_peer");
    const scope = { db: deps.db, nodeId: NODE, principalId: OWNER };

    expect(answer(elsewhere, "confirmed")).toMatchObject({ ok: false, code: "EFFECT_NOT_FOUND" });
    expect(getEffect(deps.db, elsewhere)?.state).toBe("unknown");
    expect(answerableUnknownEffect(scope, taskId)).toBeUndefined();
    expect(answerableUnknownEffects(scope)).toEqual([]);
  });

  it("refuses an effect that is not unknown, so a second answer cannot overwrite the first", () => {
    const effectId = unknownEffect(runningTask());
    expect(answer(effectId, "failed").ok).toBe(true);

    const again = answer(effectId, "confirmed");

    expect(again).toMatchObject({ ok: false, code: "EFFECT_NOT_UNKNOWN", state: "failed" });
    expect(getEffect(deps.db, effectId)?.state).toBe("failed");
  });

  it("offers to answer only an effect that is still unknown", () => {
    const taskId = runningTask();
    const effectId = unknownEffect(taskId);
    const scope = { db: deps.db, nodeId: NODE, principalId: OWNER };
    expect(answerableUnknownEffect(scope, taskId)?.effectId).toBe(effectId);

    answer(effectId, "confirmed");

    expect(answerableUnknownEffect(scope, taskId)).toBeUndefined();
    expect(answerableUnknownEffects(scope)).toEqual([]);
  });
});

describe("the task an answer settles", () => {
  it("succeeds when the effect took effect and the run verified its result", () => {
    const taskId = runningTask();
    recordEvidence(deps, { taskId, evidence: { kind: "test-output", summary: "the checks passed", verdict: "verified" } });
    const effectId = unknownEffect(taskId);
    expect(getTask(deps.db, taskId)?.state).toBe("uncertain");

    const result = answer(effectId, "confirmed");

    expect(result.ok && result.settlement?.outcome).toBe("succeeded");
    expect(getTask(deps.db, taskId)?.state).toBe("succeeded");
  });

  it("fails, saying why, when the effect took effect but the run never verified its result", () => {
    const taskId = runningTask();
    const effectId = unknownEffect(taskId);

    const result = answer(effectId, "confirmed");

    expect(result.ok && result.settlement?.outcome).toBe("failed");
    expect(result.ok && result.settlement?.message).toContain("chưa xác minh được kết quả");
    expect(getTask(deps.db, taskId)?.state).toBe("failed");
  });

  it("fails when the effect did not take effect", () => {
    const taskId = runningTask();
    recordEvidence(deps, { taskId, evidence: { kind: "test-output", summary: "the checks passed", verdict: "verified" } });
    const effectId = unknownEffect(taskId);

    const result = answer(effectId, "failed");

    expect(result.ok && result.settlement).toEqual({
      outcome: "failed",
      message: "bạn xác nhận “git push origin HEAD” chưa có hiệu lực",
      // The same answer as data, so the owner is told it in their own language.
      reason: { code: "reconciled", stopped: false, didNotLand: "git push origin HEAD — /work/repo", landed: [], unverified: false },
    });
    expect(getTask(deps.db, taskId)?.state).toBe("failed");
  });

  it("keeps a stop the person asked for, whatever the effect did", () => {
    const taskId = runningTask();
    applyTaskEvent(deps, taskId, "cancel.requested");
    const effectId = unknownEffect(taskId);
    expect(getTask(deps.db, taskId)?.state).toBe("uncertain");

    const result = answer(effectId, "confirmed");

    expect(result.ok && result.settlement?.outcome).toBe("cancelled");
    expect(getTask(deps.db, taskId)?.state).toBe("cancelled");
  });

  it("waits for every unknown effect of the task before settling it", () => {
    const taskId = runningTask();
    const first = unknownEffect(taskId, "git push origin a");
    const second = unknownEffect(taskId, "git push origin b");

    const one = answer(first, "confirmed");
    expect(one.ok && one.settlement).toBeUndefined();
    expect(one.ok && one.remainingUnknown.map((effect) => effect.effectId)).toEqual([second]);
    expect(getTask(deps.db, taskId)?.state).toBe("uncertain");

    const two = answer(second, "failed");
    expect(two.ok && two.settlement?.outcome).toBe("failed");
  });

  it("records without settling while the run is still going, and settles when asked later", () => {
    const taskId = runningTask();
    recordEvidence(deps, { taskId, evidence: { kind: "test-output", summary: "the checks passed", verdict: "verified" } });
    const effectId = unknownEffect(taskId);

    const result = answer(effectId, "confirmed", { settle: false });
    expect(result.ok && result.settlement).toBeUndefined();
    expect(getTask(deps.db, taskId)?.state).toBe("uncertain");

    expect(settleReconciledTask(deps, taskId)?.outcome).toBe("succeeded");
    expect(getTask(deps.db, taskId)?.state).toBe("succeeded");
  });

  it("does not settle a task that is uncertain for a reason no effect explains", () => {
    const task = createTask(deps, {
      conversationId: "conv_1" as never,
      goal: "chạy việc",
      principal: { principalId: OWNER, kind: "user", nodeId: NODE },
    });
    applyTaskEvent(deps, task.taskId, "resolve.start");
    advanceResolving(deps, task.taskId, { kind: "ready", executionNodeId: NODE });
    // Whether the worker ever started is not an effect anyone can answer for.
    applyTaskEvent(deps, task.taskId, "dispatch.timed_out");
    expect(getTask(deps.db, task.taskId)?.state).toBe("uncertain");

    expect(settleReconciledTask(deps, task.taskId)).toBeUndefined();
    expect(getTask(deps.db, task.taskId)?.state).toBe("uncertain");
  });
});
