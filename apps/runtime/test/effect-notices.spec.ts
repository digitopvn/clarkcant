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

import { COMMAND_STOPPED_ON_REQUEST, sweepUnknownEffects, unknownEffectNotice } from "../src/effect-notices.ts";
import { readInbox } from "../src/inbox.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { taskDispatchReports } from "../src/task-reporting.ts";

/**
 * The notice for an effect nobody saw land.
 *
 * The rows are written the way the command broker and the boot's recovery write them — prepared, handed off, then
 * called unknown — and the sweep is run the way its timer runs it. What is under test is that a task with an unknown
 * effect is one notice however often the sweep looks and whichever of the sweep and the task's own report writes it
 * first, and that the notice points at the task and its conversation.
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
function handOff(
  taskId: string,
  intent: string,
  settle: "unknown" | "confirmed" | "submitted",
  options: { preparedAt?: Instant; reason?: string } = {},
): string {
  const preparedAt = options.preparedAt ?? AT;
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
    expect(markEffectUnknown(deps, prepared.effectId, options.reason ?? "the command ran out of time").ok).toBe(true);
  } else if (settle === "confirmed") {
    const observed = advanceEffect(submitted.effect, { to: "confirmed", at: AT });
    if (!observed.ok) throw new Error(observed.message);
    upsertEffect(services.runtime.db, observed.effect);
  }
  return prepared.effectId;
}

type StoredNotice = {
  dedup_key: string;
  conversation_id: string | null;
  subject: string | null;
  title: string;
  body: string | null;
  severity: string;
};

function storedNotices(): StoredNotice[] {
  return allRows(
    services.runtime.db,
    "SELECT dedup_key, conversation_id, subject, title, body, severity FROM notifications WHERE dedup_key LIKE 'worker:%' ORDER BY rowid",
  );
}

describe("an effect whose outcome is unknown", () => {
  it("is reported once, pointing at its task and conversation, however often the sweep runs", () => {
    const { taskId, conversationId } = taskInConversation("mở pull request cho bản sửa");
    handOff(taskId, "git push origin HEAD — /work/repo", "unknown");

    sweepUnknownEffects(services, AT);
    sweepUnknownEffects(services, "2026-09-29T07:01:00.000Z" as Instant);

    const notices = storedNotices();
    expect(notices).toHaveLength(1);
    // The key the task's own settled notice uses: one event, one notice.
    expect(notices[0]?.dedup_key).toBe(`worker:${taskId}`);
    expect(notices[0]?.severity).toBe("warning");
    expect(notices[0]?.conversation_id).toBe(conversationId);
    expect(JSON.parse(notices[0]?.subject ?? "null")).toEqual({ kind: "task", taskId, conversationId });
    // What is uncertain, what was kept, and what to do next.
    expect(notices[0]?.body).toContain("git push origin HEAD");
    expect(notices[0]?.body).toContain("mở pull request cho bản sửa");
    expect(notices[0]?.body).toContain("không báo lại kết quả");
    expect(notices[0]?.body).toContain("mọi lệnh ra bên ngoài mà nó nhận ra đều bị từ chối");
    expect(notices[0]?.body).toContain("Hãy kiểm tra");

    const inbox = readInbox(services, AT);
    expect(inbox.notices.filter((notice) => notice.title.startsWith("Chưa rõ"))).toHaveLength(1);
  });

  it("says the person's own stop was why, rather than something going wrong on its own", () => {
    const { taskId } = taskInConversation("mở pull request");
    handOff(taskId, "gh pr create --fill — /work/repo", "unknown", { reason: COMMAND_STOPPED_ON_REQUEST });

    sweepUnknownEffects(services, AT);

    const [notice] = storedNotices();
    expect(notice?.body).toContain("đã bị dừng theo yêu cầu trong lúc đang chạy");
    expect(notice?.body).not.toContain("không báo lại kết quả");
  });

  it("keeps what to do next inside the notice however long the command and the task's goal are", () => {
    const notice = unknownEffectNotice({
      effects: Array.from({ length: 100 }, (_, index) => ({
        taskId: "task_long",
        intent: `gh pr create --title "${"x".repeat(400)}" — /work/${String(index)}`,
        reconciliationEvidence: COMMAND_STOPPED_ON_REQUEST,
      })),
      task: { conversationId: "conv_long", goal: "sửa lỗi ".repeat(100) },
      at: AT,
    });
    const body = notice?.body ?? "";
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(500);
    expect(body.endsWith("trước khi chạy lại.")).toBe(true);
    expect(body).toContain("và 99 thao tác khác cũng vậy");
  });

  it("tells the person to check a browser submission on the site it went to, within the same length", () => {
    const notice = unknownEffectNotice({
      effects: Array.from({ length: 100 }, (_, index) => ({
        taskId: "task_browser",
        capabilityRef: "browser.playwright@1",
        intent: `browser click “${"Gửi đơn ".repeat(40)}” on shop.example/checkout — tgt_task-${String(index)}`,
        reconciliationEvidence: "click on el_1 sent 1 request(s) that had no answer after 5000 ms",
      })),
      task: { conversationId: "conv_browser", goal: "đặt hàng ".repeat(100) },
      at: AT,
    });
    const body = notice?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(500);
    expect(body).toContain("trang không trả lời");
    expect(body).toContain("Hãy kiểm tra trên trang đó");
    expect(body).not.toContain("remote Git");
    // The target the browser ran in says nothing to a person, so it is not quoted.
    expect(body).not.toContain("tgt_task");
    expect(body.endsWith("trước khi làm lại.")).toBe(true);
    // A button name cut short still closes its quote, and the action is never wrapped in a second pair.
    expect(body.startsWith("Thao tác bấm “Gửi đơn")).toBe(true);
    expect((body.match(/“/gu) ?? []).length).toBe((body.match(/”/gu) ?? []).length);
    expect(body).not.toContain("““");

    const short = unknownEffectNotice({
      effects: [
        {
          taskId: "task_browser",
          capabilityRef: "browser.playwright@1",
          intent: "browser click “Send” on shop.example/checkout — tgt_task-1",
        },
      ],
      task: { conversationId: "conv_browser", goal: "Đặt hàng\n\nBắt đầu từ: https://shop.example/checkout" },
      at: AT,
    });
    // The press is recorded as data and worded in the notice's language: Vietnamese throughout, the request without
    // its addresses line.
    expect(short?.body).toContain(
      "Thao tác bấm “Send” trên shop.example/checkout cho việc “Đặt hàng” đã được gửi đi nhưng trang không trả lời",
    );
    expect(short?.body).not.toContain("click");
  });

  it("gives each task its own notice, and counts a task's other unknown effects in it", () => {
    const { taskId } = taskInConversation("gửi hai thay đổi");
    handOff(taskId, "git push origin a", "unknown");
    // A second unknown effect of the same task, written the way the boot's recovery leaves one on an uncertain task.
    const second = handOff(taskId, "git push origin b", "submitted");
    const [row] = allRows<{ state: string }>(services.runtime.db, "SELECT state FROM effects WHERE effect_id = ?", second);
    expect(row?.state).toBe("submitted");
    services.runtime.db.prepare("UPDATE effects SET state = 'unknown' WHERE effect_id = ?").run(second);
    const other = taskInConversation("gửi thay đổi khác");
    handOff(other.taskId, "git push origin c", "unknown");

    sweepUnknownEffects(services, AT);

    const notices = storedNotices();
    expect(notices.map((notice) => notice.dedup_key).sort()).toEqual([`worker:${taskId}`, `worker:${other.taskId}`].sort());
    expect(notices.find((notice) => notice.dedup_key === `worker:${taskId}`)?.body).toContain("và 1 thao tác khác cũng vậy");
  });

  it("says nothing for an effect that was confirmed, is still in flight, or is older than a dismissal is kept", () => {
    const { taskId } = taskInConversation("đẩy nhánh");
    handOff(taskId, "git push origin confirmed", "confirmed");
    handOff(taskId, "git push origin in-flight", "submitted");
    const long = new Date(Date.parse(AT) - DISMISSED_RETENTION_MS - 60_000).toISOString() as Instant;
    const old = taskInConversation("việc cũ");
    handOff(old.taskId, "git push origin old", "unknown", { preparedAt: long });

    sweepUnknownEffects(services, AT);

    expect(storedNotices()).toEqual([]);
  });

  it("does not come back once dismissed while the effect stays unknown", () => {
    const { taskId } = taskInConversation("đẩy nhánh");
    handOff(taskId, "git push origin HEAD", "unknown");
    sweepUnknownEffects(services, AT);
    services.runtime.db.prepare("UPDATE notifications SET dismissed_at = ? WHERE dedup_key LIKE 'worker:%'").run(AT);

    sweepUnknownEffects(services, "2026-09-29T08:00:00.000Z" as Instant);

    expect(storedNotices()).toHaveLength(1);
  });
});

describe("a task that settles with an unknown effect", () => {
  it("is reported as that effect, once, whether the task's report or the sweep writes first", () => {
    const { taskId, conversationId } = taskInConversation("mở pull request");
    handOff(taskId, "gh pr create --fill — /work/repo", "unknown", { reason: COMMAND_STOPPED_ON_REQUEST });
    const reports = taskDispatchReports(services);

    reports.onSettled({ taskId, conversationId, outcome: "uncertain", message: "stopped on request before the worker finished" });
    sweepUnknownEffects(services, AT);

    const notices = storedNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe("Chưa rõ một thao tác đã có hiệu lực hay chưa");
    expect(notices[0]?.body).toContain("gh pr create --fill");
    expect(notices[0]?.body).toContain("dừng theo yêu cầu");
    expect(notices[0]?.severity).toBe("warning");

    // And the other way round: the sweep first, then the task's report, is still the one notice.
    const later = taskInConversation("đẩy nhánh");
    handOff(later.taskId, "git push origin HEAD", "unknown");
    sweepUnknownEffects(services, AT);
    reports.onSettled({ taskId: later.taskId, conversationId: later.conversationId, outcome: "uncertain", message: "timed out" });
    expect(storedNotices().filter((notice) => notice.dedup_key === `worker:${later.taskId}`)).toHaveLength(1);
  });

  it("is reported the ordinary way when it has no unknown effect", () => {
    const { taskId, conversationId } = taskInConversation("đẩy nhánh");
    handOff(taskId, "git push origin HEAD", "confirmed");

    taskDispatchReports(services).onSettled({ taskId, conversationId, outcome: "succeeded", message: "pushed" });

    const notices = storedNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).not.toBe("Chưa rõ một thao tác đã có hiệu lực hay chưa");
  });
});
