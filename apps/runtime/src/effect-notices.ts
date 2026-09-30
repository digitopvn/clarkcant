import type { EffectRecord, Instant } from "@clarkcant/contracts";
import { browserPressOfIntent, describeBrowserPress } from "@clarkcant/core";
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

/** How the effect ledger names a browser action's capability (`browser-effects.ts`). */
const BROWSER_CAPABILITY_PREFIX = "browser.";

/** How long each quote may be, so what to do next still fits in the notice's 500 characters with both quotes full. */
const QUOTE_MAX = 70;

/** The most a notice body may hold (`NodeNotice`'s own limit). */
const BODY_MAX = 500;

function quote(text: string, max = QUOTE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  // A cut inside a quoted name closes the quote, so the sentence around it still reads as one.
  const open = (cut.match(/“/gu) ?? []).length > (cut.match(/”/gu) ?? []).length;
  return open ? `${cut.slice(0, -1)}…”` : `${cut}…`;
}

/**
 * What is uncertain, what was kept, and what the person can do — in that order, like every error this node reports.
 *
 * The first unknown effect's own intent is quoted rather than its id or digest, which say nothing to a person; any
 * others are counted. A stop the person made is named as theirs, so the notice does not read as something that went
 * wrong on its own.
 */
export function unknownEffectNotice(input: {
  effects: readonly (Pick<EffectRecord, "taskId" | "intent" | "reconciliationEvidence"> & { capabilityRef?: string })[];
  task?: { conversationId: string; goal: string };
  at: Instant;
  /** The key it is recorded under: the task's own worker key, unless it follows an answer for an earlier effect. */
  dedupKey?: string;
}): NodeNotice | undefined {
  const [first] = input.effects;
  if (first === undefined) return undefined;
  // A submission in the browser is checked on the site it went to, not on a remote a command pushed to. A press is
  // recorded as data and worded here, in the notice's own language like the rest of it; the target it ran in is left off.
  const browser = first.capabilityRef?.startsWith(BROWSER_CAPABILITY_PREFIX) === true;
  const press = browser ? browserPressOfIntent(first.intent) : undefined;
  const intent = press !== undefined ? describeBrowserPress(press, "vi") : browser ? (first.intent.split(" — ")[0] ?? first.intent) : first.intent;
  // A browser task's goal ends with the addresses it starts at; the request before them is what the person asked for.
  const goal = input.task === undefined ? undefined : browser ? (input.task.goal.split("\n\n")[0] ?? input.task.goal) : input.task.goal;
  const forTask = goal === undefined ? "" : ` cho việc “${quote(goal)}”`;
  const what =
    first.reconciliationEvidence === COMMAND_STOPPED_ON_REQUEST
      ? "đã bị dừng theo yêu cầu trong lúc đang chạy"
      : browser
        ? "đã được gửi đi nhưng trang không trả lời"
        : "đã được gửi đi nhưng không báo lại kết quả";
  const others = input.effects.length > 1 ? ` (và ${String(input.effects.length - 1)} thao tác khác cũng vậy)` : "";
  const next = browser
    ? `Việc được giữ ở trạng thái chưa rõ kết quả và trình duyệt không gửi thêm gì, vì gửi lại có thể làm nó hai lần. ` +
      `Hãy kiểm tra trên trang đó (ví dụ email xác nhận) rồi ghi nhận kết quả, trước khi làm lại.`
    : `Việc được giữ ở trạng thái chưa rõ kết quả; mọi lệnh ra bên ngoài mà nó nhận ra đều bị từ chối, vì chạy lại có thể làm nó hai lần. ` +
      `Hãy kiểm tra ở nơi nhận (ví dụ remote Git) rồi ghi nhận kết quả, trước khi chạy lại.`;
  return {
    sourceKind: "worker",
    category: "alert",
    severity: "warning",
    title: "Chưa rõ một thao tác đã có hiệu lực hay chưa",
    body: press !== undefined
      ? browserBody(intent, `${forTask} ${what}${others}, nên chưa rõ nó đã có hiệu lực hay chưa. ${next}`)
      : `“${quote(intent)}”${forTask} ${what}${others}, nên chưa rõ nó đã có hiệu lực hay chưa. ${next}`,
    ...(input.task === undefined ? {} : { conversationId: input.task.conversationId }),
    subject: {
      kind: "task",
      taskId: first.taskId,
      ...(input.task === undefined ? {} : { conversationId: input.task.conversationId }),
    },
    dedupKey: input.dedupKey ?? workerNoticeKey(first.taskId),
    at: input.at,
  };
}

/**
 * A press is worded as a phrase with its own quoted button name (`bấm “Gửi” trên shop.example/apply`), so it is said as
 * the action it was rather than quoted again, and given as much of the body as the rest leaves.
 */
function browserBody(intent: string, rest: string): string {
  const room = Math.max(40, BODY_MAX - rest.length - "Thao tác ".length);
  return `Thao tác ${quote(intent, room)}${rest}`.slice(0, BODY_MAX);
}

/**
 * A task's effects whose outcome is unknown, oldest first: the order the notice quotes them in, and so the order the
 * inbox offers to answer for them in. One function for both, so the button never answers for an effect the words
 * beside it do not name.
 */
export function unknownEffectsOf(db: Database, taskId: string): EffectRecord[] {
  return effectsForTask(db, taskId).filter((effect) => effect.state === "unknown");
}

/** The notice for a task's unknown effects, read from the ledger, or nothing when it has none. */
export function unknownEffectsNotice(db: Database, taskId: string, at: Instant, dedupKey?: string): NodeNotice | undefined {
  const effects = unknownEffectsOf(db, taskId);
  if (effects.length === 0) return undefined;
  const task = getTask(db, taskId);
  return unknownEffectNotice({
    effects,
    ...(task === undefined ? {} : { task: { conversationId: task.conversationId, goal: task.goal } }),
    at,
    ...(dedupKey === undefined ? {} : { dedupKey }),
  });
}

/**
 * The key of the notice that follows an answer while the task still has another unknown effect: one per effect, so
 * the next one is heard once, and never under the task's own key — that one was resolved by the answer, and the
 * sweep, which keeps writing under it, stays deduplicated against it.
 */
export function unknownEffectFollowUpKey(taskId: string, effectId: string): string {
  return `${workerNoticeKey(taskId)}:unknown:${effectId}`;
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
