import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { advanceEffect, type CapabilityRef, type Instant, type Principal } from "@clarkcant/contracts";
import {
  advanceResolving,
  applyTaskEvent,
  createTask,
  markEffectUnknown,
  prepareEffect,
  type TaskServiceDeps,
} from "@clarkcant/core";
import { allRows, DISMISSED_RETENTION_MS, upsertEffect } from "@clarkcant/storage";

import { sweepUnknownEffects } from "../src/effect-notices.ts";
import { readInbox } from "../src/inbox.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The notice for an effect nobody saw land.
 *
 * The rows are written the way the command broker and the boot's recovery write them — prepared, handed off, then
 * called unknown — and the sweep is run the way its timer runs it. What is under test is that one unknown effect is
 * one notice however often the sweep looks, and that the notice points at the task and its conversation.
 */

const AT = "2026-09-29T07:00:00.000Z" as Instant;
const PRINCIPAL: Principal = { principalId: "user_effect_test", kind: "user", nodeId: "node_test" as never };

let dir: string;
let services: NodeServices;
let deps: TaskServiceDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-effect-notices-"));
  services = bootNodeServices({ dataDir: dir, label: "effect notice test node" });
  deps = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => AT, newId: services.conductor.newId };
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function taskInConversation(goal: string): { taskId: string; conversationId: string } {
  const conversationId = `conv_effect_${services.conductor.newId("id")}`;
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run(conversationId, services.runtime.identity.nodeId, AT, AT);
  const task = createTask(deps, { conversationId: conversationId as never, goal, principal: PRINCIPAL });
  // Running here, as a dispatched task is when its worker asks the host to run a command.
  applyTaskEvent(deps, task.taskId, "resolve.start");
  advanceResolving(deps, task.taskId, { kind: "ready", executionNodeId: services.runtime.identity.nodeId });
  applyTaskEvent(deps, task.taskId, "dispatch.acknowledged");
  return { taskId: task.taskId, conversationId };
}

/** An effect handed off for the task, then left the way `settle` says. */
function handOff(taskId: string, intent: string, settle: "unknown" | "confirmed" | "submitted", preparedAt = AT): string {
  const prepared = prepareEffect(
    { ...deps, now: () => preparedAt },
    {
      taskId,
      executorNodeId: services.runtime.identity.nodeId,
      category: "external-write",
      capabilityRef: "project.command.run@1" as CapabilityRef,
      intent,
      operationDigest: `sha256:${intent}`,
      externalSupportsDedup: false,
    },
  );
  const submitted = advanceEffect(prepared, { to: "submitted", at: preparedAt });
  if (!submitted.ok) throw new Error(submitted.message);
  upsertEffect(services.runtime.db, submitted.effect);
  if (settle === "unknown") {
    // Through the same call the broker makes, so the ledger row is exactly what production leaves.
    expect(markEffectUnknown(deps, prepared.effectId, "the command ran out of time").ok).toBe(true);
  } else if (settle === "confirmed") {
    const observed = advanceEffect(submitted.effect, { to: "confirmed", at: AT });
    if (!observed.ok) throw new Error(observed.message);
    upsertEffect(services.runtime.db, observed.effect);
  }
  return prepared.effectId;
}

function storedNotices(): { dedup_key: string; conversation_id: string | null; subject: string | null; title: string; body: string | null }[] {
  return allRows(
    services.runtime.db,
    "SELECT dedup_key, conversation_id, subject, title, body FROM notifications WHERE dedup_key LIKE 'effect-unknown:%' ORDER BY rowid",
  );
}

describe("an effect whose outcome is unknown", () => {
  it("is reported once, pointing at its task and conversation, however often the sweep runs", () => {
    const { taskId, conversationId } = taskInConversation("mở pull request cho bản sửa");
    const effectId = handOff(taskId, "git push origin HEAD — /work/repo", "unknown");

    sweepUnknownEffects(services, AT);
    sweepUnknownEffects(services, "2026-09-29T07:01:00.000Z" as Instant);

    const notices = storedNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.dedup_key).toBe(`effect-unknown:${effectId}`);
    expect(notices[0]?.conversation_id).toBe(conversationId);
    expect(JSON.parse(notices[0]?.subject ?? "null")).toEqual({ kind: "task", taskId, conversationId });
    // What is uncertain, what was kept, and what to do next.
    expect(notices[0]?.body).toContain("git push origin HEAD");
    expect(notices[0]?.body).toContain("mở pull request cho bản sửa");
    expect(notices[0]?.body).toContain("sẽ không tự chạy lại");
    expect(notices[0]?.body).toContain("Hãy kiểm tra");

    const inbox = readInbox(services, AT);
    expect(inbox.notices.filter((notice) => notice.title.startsWith("Chưa rõ"))).toHaveLength(1);
  });

  it("gives each unknown effect its own notice", () => {
    const { taskId } = taskInConversation("gửi hai thay đổi");
    handOff(taskId, "git push origin a", "unknown");
    // A second task, so the first task's move to uncertain does not refuse the second effect's.
    const other = taskInConversation("gửi thay đổi khác");
    handOff(other.taskId, "git push origin b", "unknown");

    sweepUnknownEffects(services, AT);

    expect(storedNotices()).toHaveLength(2);
  });

  it("says nothing for an effect that was confirmed, is still in flight, or is older than a dismissal is kept", () => {
    const { taskId } = taskInConversation("đẩy nhánh");
    handOff(taskId, "git push origin confirmed", "confirmed");
    handOff(taskId, "git push origin in-flight", "submitted");
    const long = new Date(Date.parse(AT) - DISMISSED_RETENTION_MS - 60_000).toISOString() as Instant;
    const old = taskInConversation("việc cũ");
    handOff(old.taskId, "git push origin old", "unknown", long);

    sweepUnknownEffects(services, AT);

    expect(storedNotices()).toEqual([]);
  });

  it("does not come back once dismissed while the effect stays unknown", () => {
    const { taskId } = taskInConversation("đẩy nhánh");
    handOff(taskId, "git push origin HEAD", "unknown");
    sweepUnknownEffects(services, AT);
    services.runtime.db.prepare("UPDATE notifications SET dismissed_at = ? WHERE dedup_key LIKE 'effect-unknown:%'").run(AT);

    sweepUnknownEffects(services, "2026-09-29T08:00:00.000Z" as Instant);

    expect(storedNotices()).toHaveLength(1);
  });
});
