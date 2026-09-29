import type { EffectRecord, Instant } from "@clarkcant/contracts";
import { DISMISSED_RETENTION_MS, getTask, unsettledEffects } from "@clarkcant/storage";

import { type NodeNotice, tryRecordNodeNotice } from "./notices.ts";
import type { NodeServices } from "./services.ts";

/**
 * A notice for an effect whose outcome nobody observed.
 *
 * The effect ledger calls an effect `unknown` when it was handed off — a push, a message, a deletion — and its answer
 * never came back: the command was stopped, ran out of time, or the node went down while it ran. That state is the one
 * place autonomy has to hand a question back to a person, because nothing on this node can tell whether it landed, and
 * running it again to find out is exactly how it would happen twice. The task already reads `uncertain`; this is what
 * makes the person hear about it when they were not looking at that conversation.
 *
 * A sweep over the ledger rather than a call at each place an effect becomes unknown, so the broker, the boot's
 * recovery and anything that writes the ledger later are reported the same way, once per effect.
 */
export type EffectNoticeServices = Pick<NodeServices, "runtime" | "conductor">;

/**
 * How far back the sweep looks.
 *
 * A dismissed notice is kept for `DISMISSED_RETENTION_MS` so its producer stays deduplicated; an effect older than that
 * would be announced again the moment its dismissed notice was cleaned up, which reads as new when it is not.
 */
const UNKNOWN_EFFECT_WINDOW_MS = DISMISSED_RETENTION_MS;

/** How long each quote may be, so what to do next still fits in the notice's 500 characters with both quotes full. */
const QUOTE_MAX = 90;

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= QUOTE_MAX ? flat : `${flat.slice(0, QUOTE_MAX - 1)}…`;
}

/**
 * What is uncertain, what was kept, and what the person can do — in that order, like every error this node reports.
 *
 * The effect's own intent is quoted rather than its id or digest, which say nothing to a person. The key is the effect
 * id, so a sweep that runs every minute leaves one notice per effect however long it stays unknown.
 */
export function unknownEffectNotice(input: {
  effect: Pick<EffectRecord, "effectId" | "taskId" | "intent">;
  task?: { conversationId: string; goal: string };
  at: Instant;
}): NodeNotice {
  const forTask = input.task === undefined ? "" : ` cho việc “${quote(input.task.goal)}”`;
  return {
    sourceKind: "worker",
    category: "alert",
    severity: "warning",
    title: "Chưa rõ một thao tác đã có hiệu lực hay chưa",
    body:
      `“${quote(input.effect.intent)}”${forTask} đã được gửi đi nhưng không báo lại kết quả, nên chưa rõ nó đã có hiệu lực hay chưa. ` +
      `Việc được giữ ở trạng thái chưa rõ kết quả và thao tác này sẽ không tự chạy lại, vì chạy lại có thể làm nó hai lần. ` +
      `Hãy kiểm tra ở nơi nhận (ví dụ remote Git hoặc dịch vụ) trước khi chạy lại.`,
    ...(input.task === undefined ? {} : { conversationId: input.task.conversationId }),
    subject: {
      kind: "task",
      taskId: input.effect.taskId,
      ...(input.task === undefined ? {} : { conversationId: input.task.conversationId }),
    },
    dedupKey: `effect-unknown:${input.effect.effectId}`,
    at: input.at,
  };
}

/** One pass: every effect this node executed that is `unknown`, each reported once. Never throws for one bad row. */
export function sweepUnknownEffects(services: EffectNoticeServices, now: Instant): void {
  const since = Date.parse(now) - UNKNOWN_EFFECT_WINDOW_MS;
  for (const effect of unsettledEffects(services.runtime.db, services.runtime.identity.nodeId)) {
    if (effect.state !== "unknown" || Date.parse(effect.preparedAt) < since) continue;
    try {
      const task = getTask(services.runtime.db, effect.taskId);
      tryRecordNodeNotice(
        services,
        unknownEffectNotice({
          effect,
          ...(task === undefined ? {} : { task: { conversationId: task.conversationId, goal: task.goal } }),
          at: now,
        }),
      );
    } catch (cause) {
      process.stderr.write(
        `effect notices: could not report ${effect.effectId} (${cause instanceof Error ? cause.message : String(cause)})\n`,
      );
    }
  }
}

/**
 * Run the sweep now and then periodically. Now, because the boot's recovery is what turns an effect the previous
 * process left behind into `unknown`, and the person should not wait a minute to hear about it. Unref'd, and stopped
 * by the caller when the node closes.
 */
export function startUnknownEffectNoticeSweep(
  services: EffectNoticeServices,
  options: { intervalMs?: number; now?: () => Instant } = {},
): { stop: () => void } {
  const now = options.now ?? ((): Instant => new Date().toISOString() as Instant);
  const run = (): void => {
    try {
      sweepUnknownEffects(services, now());
    } catch (cause) {
      process.stderr.write(`effect notices: could not run (${cause instanceof Error ? cause.message : String(cause)})\n`);
    }
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
