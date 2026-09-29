import type { EffectRecord, Instant } from "@clarkcant/contracts";
import { DISMISSED_RETENTION_MS, type Database, effectsForTask, getTask, unknownEffectsSince } from "@clarkcant/storage";

import { type NodeNotice, tryRecordNodeNotice, workerNoticeKey } from "./notices.ts";
import type { NodeServices } from "./services.ts";

/**
 * A notice for an effect whose outcome nobody observed.
 *
 * The effect ledger calls an effect `unknown` when it was handed off — a push, a pull request, an upload — and its
 * answer never came back: the command was stopped, ran out of time, or the node went down while it ran. That state is
 * the one place autonomy has to hand a question back to a person, because nothing on this node can tell whether it
 * landed, and running it again to find out is exactly how it would happen twice. The task already reads `uncertain`;
 * this is what makes the person hear about it when they were not looking at that conversation.
 *
 * One notice per task, under the same key as the notice the task leaves when it settles (`workerNoticeKey`): the
 * effect is why the task is uncertain, so the two are one event, and a person who pressed Stop during a push hears
 * once that the push may or may not have landed — not once that the task stopped and again that something is unknown.
 * Whichever is written first wins, and both are this notice when the task has an unknown effect: the dispatcher's
 * report asks `unknownEffectsNotice` first, and the sweep below covers a task no dispatcher is left to report, such as
 * one the boot's recovery found.
 */
export type EffectNoticeServices = Pick<NodeServices, "runtime" | "conductor">;

/** Why an effect is unknown when a person stopped its command, so the notice can say it was their stop. */
export const COMMAND_STOPPED_ON_REQUEST = "the command was stopped on request before it finished";

/**
 * How far back the sweep looks.
 *
 * A dismissed notice is kept for `DISMISSED_RETENTION_MS` so its producer stays deduplicated; an effect older than that
 * would be announced again the moment its dismissed notice was cleaned up, which reads as new when it is not.
 */
const UNKNOWN_EFFECT_WINDOW_MS = DISMISSED_RETENTION_MS;

/** How long each quote may be, so what to do next still fits in the notice's 500 characters with both quotes full. */
const QUOTE_MAX = 70;

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= QUOTE_MAX ? flat : `${flat.slice(0, QUOTE_MAX - 1)}…`;
}

/**
 * What is uncertain, what was kept, and what the person can do — in that order, like every error this node reports.
 *
 * The first unknown effect's own intent is quoted rather than its id or digest, which say nothing to a person; any
 * others are counted. A stop the person made is named as theirs, so the notice does not read as something that went
 * wrong on its own.
 */
export function unknownEffectNotice(input: {
  effects: readonly Pick<EffectRecord, "taskId" | "intent" | "reconciliationEvidence">[];
  task?: { conversationId: string; goal: string };
  at: Instant;
}): NodeNotice | undefined {
  const [first] = input.effects;
  if (first === undefined) return undefined;
  const forTask = input.task === undefined ? "" : ` cho việc “${quote(input.task.goal)}”`;
  const what =
    first.reconciliationEvidence === COMMAND_STOPPED_ON_REQUEST
      ? "đã bị dừng theo yêu cầu trong lúc đang chạy"
      : "đã được gửi đi nhưng không báo lại kết quả";
  const others = input.effects.length > 1 ? ` (và ${String(input.effects.length - 1)} thao tác khác cũng vậy)` : "";
  return {
    sourceKind: "worker",
    category: "alert",
    severity: "warning",
    title: "Chưa rõ một thao tác đã có hiệu lực hay chưa",
    body:
      `“${quote(first.intent)}”${forTask} ${what}${others}, nên chưa rõ nó đã có hiệu lực hay chưa. ` +
      `Việc được giữ ở trạng thái chưa rõ kết quả; mọi lệnh ra bên ngoài mà nó nhận ra đều bị từ chối, vì chạy lại có thể làm nó hai lần. ` +
      `Hãy kiểm tra ở nơi nhận (ví dụ remote Git hoặc dịch vụ) trước khi chạy lại.`,
    ...(input.task === undefined ? {} : { conversationId: input.task.conversationId }),
    subject: {
      kind: "task",
      taskId: first.taskId,
      ...(input.task === undefined ? {} : { conversationId: input.task.conversationId }),
    },
    dedupKey: workerNoticeKey(first.taskId),
    at: input.at,
  };
}

/** The notice for a task's unknown effects, read from the ledger, or nothing when it has none. */
export function unknownEffectsNotice(db: Database, taskId: string, at: Instant): NodeNotice | undefined {
  const effects = effectsForTask(db, taskId).filter((effect) => effect.state === "unknown");
  if (effects.length === 0) return undefined;
  const task = getTask(db, taskId);
  return unknownEffectNotice({
    effects,
    ...(task === undefined ? {} : { task: { conversationId: task.conversationId, goal: task.goal } }),
    at,
  });
}

/** One pass: every task with an effect this node executed that is `unknown`, each reported once. Never throws for one. */
export function sweepUnknownEffects(services: EffectNoticeServices, now: Instant): void {
  const since = new Date(Date.parse(now) - UNKNOWN_EFFECT_WINDOW_MS).toISOString() as Instant;
  const db = services.runtime.db;
  const tasks = new Set(unknownEffectsSince(db, services.runtime.identity.nodeId, since).map((effect) => effect.taskId));
  for (const taskId of tasks) {
    try {
      const notice = unknownEffectsNotice(db, taskId, now);
      if (notice !== undefined) tryRecordNodeNotice(services, notice);
    } catch (cause) {
      process.stderr.write(
        `effect notices: could not report task ${taskId} (${cause instanceof Error ? cause.message : String(cause)})\n`,
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
