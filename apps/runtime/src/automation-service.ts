import { execFileSync } from "node:child_process";

import type { Instant, IntentRun, Signal } from "@clarkcant/contracts";
import {
  fireDueTimers,
  matchDueSignals,
  pendingRuns,
  prepareIntentRun,
  settleIntentRun,
  type TaskServiceDeps,
} from "@clarkcant/core";
import { GITHUB_PROVIDER, githubRepositoryFromRemote, remoteMatchesRepository } from "@clarkcant/signal-sources";
import { getPersistentIntent, getSignalDelivery, getTask, setIntentRunState } from "@clarkcant/storage";

import { tryRecordNodeNotice } from "./notices.ts";
import { appendHostReply } from "./routes/conversations.ts";
import type { NodeServices } from "./services.ts";

/**
 * What makes a standing request happen on its own.
 *
 * Each tick does three things in order, all of them from what is written down rather than from what this process
 * remembers: timers that came due become signals, signals are matched into runs, and runs are started. A node that
 * stopped anywhere in the middle does the rest on its first tick after it starts again, and nothing twice: a signal is
 * unique per source, a run per (automation, signal), and a run's task is created under the id the run recorded.
 *
 * The person hears about it where they set it up. A reminder is said in that conversation and left in the inbox; a
 * task says it started, and its own result is reported there by the dispatcher when it settles, the same as any task.
 */

export type AutomationServices = Pick<NodeServices, "runtime" | "conductor" | "search">;

export interface AutomationService {
  /** Run a tick soon, rather than waiting for the interval: after a signal arrives or an automation changes. */
  kick(): void;
  /** Run one tick now. Never throws; what failed is reported, and tried again on the next tick where it can be. */
  tick(): void;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 30_000;

/** A signal in words a person reads: what happened and to what. */
export function describeSignal(signal: Signal | undefined): string {
  if (signal === undefined) return "một tín hiệu";
  if (signal.source.kind === "timer") return "đến giờ đã hẹn";
  const subject = signal.subject;
  const what = subject?.id === undefined ? "" : ` (${subject.type === undefined ? "" : `${subject.type} `}${subject.id})`;
  const where = subject?.refs?.repository === undefined ? "" : ` ở ${subject.refs.repository}`;
  return `${signal.topic}${what}${where}`;
}

/** The `origin` remote of a clone, or nothing when it has none or is not a clone. Never printed: it may carry a token. */
export function readOriginRemote(path: string): string | undefined {
  try {
    const remote = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    return remote === "" ? undefined : remote;
  } catch {
    return undefined;
  }
}

/**
 * Why a run must not start in the repositories it was given, or nothing.
 *
 * A signal about `acme/widgets` starts work in a local folder only when that folder is a clone of `acme/widgets`:
 * a person who pointed an automation at the wrong checkout, or a repository whose remote has since changed, gets a
 * refusal that says so, never a task that changes some other project because a label appeared somewhere.
 */
export function repositoryBindingRefusal(
  signal: Signal | undefined,
  repositories: readonly string[],
  readRemote: (path: string) => string | undefined,
): string | undefined {
  const repository = signal?.subject?.refs?.repository;
  if (signal?.source.provider !== GITHUB_PROVIDER || repository === undefined) return undefined;
  const host = signal.subject?.refs?.host;
  for (const path of repositories) {
    const remote = readRemote(path);
    if (remote === undefined) return `${path} has no origin remote, so it cannot be checked against ${repository}`;
    if (!remoteMatchesRepository(remote, repository, host)) {
      const actual = githubRepositoryFromRemote(remote);
      // The parsed name only: a remote URL may carry a token, and this sentence goes into the conversation.
      const where = actual === undefined ? "a remote that is not a GitHub repository" : `${actual.host}/${actual.fullName}`;
      return `${path} is a clone of ${where}, not ${host ?? "github.com"}/${repository}`;
    }
  }
  return undefined;
}

export function startAutomationService(
  services: AutomationServices,
  options: { intervalMs?: number; now?: () => Instant; readRemote?: (path: string) => string | undefined } = {},
): AutomationService {
  const now = options.now ?? ((): Instant => new Date().toISOString() as Instant);
  const readRemote = options.readRemote ?? readOriginRemote;
  const deps: TaskServiceDeps = {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now,
    newId: services.conductor.newId,
  };
  let stopped = false;
  let kicked = false;

  const say = (conversationId: string, text: string): void => {
    try {
      appendHostReply(services, { conversationId, text, at: now() });
    } catch (cause) {
      process.stderr.write(
        `automation: could not write to conversation ${conversationId} (${cause instanceof Error ? cause.message : String(cause)})\n`,
      );
    }
  };

  const start = (run: IntentRun): void => {
    const signal = getSignalDelivery(deps.db, run.signalId)?.signal;
    const because = describeSignal(signal);

    // Checked once, before the task exists: a run whose task was already created passed this before the node stopped.
    const intent = getPersistentIntent(deps.db, run.intentId);
    if (intent?.state === "active" && intent.do.kind === "task" && getTask(deps.db, run.taskId) === undefined) {
      const repositories = intent.do.resources.flatMap((resource) => (resource.kind === "repository" ? [resource.path] : []));
      const refusal = repositoryBindingRefusal(signal, repositories, readRemote);
      if (refusal !== undefined) {
        settleIntentRun(deps, run.runId, "failed", refusal);
        const text = `Việc tự động "${intent.summary}" không chạy cho ${because}: ${refusal}.`;
        say(intent.conversationId, text);
        tryRecordNodeNotice(services, {
          sourceKind: "automation",
          category: "alert",
          severity: "warning",
          title: "Việc tự động bị từ chối",
          body: text,
          conversationId: intent.conversationId,
          dedupKey: `automation:${run.runId}`,
          at: now(),
        });
        return;
      }
    }

    let prepared: ReturnType<typeof prepareIntentRun>;
    try {
      prepared = prepareIntentRun(deps, run, { sourceRef: because });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      settleIntentRun(deps, run.runId, "failed", reason);
      tryRecordNodeNotice(services, {
        sourceKind: "automation",
        category: "alert",
        severity: "error",
        title: "Việc tự động không bắt đầu được",
        body: reason,
        dedupKey: `automation:${run.runId}`,
        at: now(),
      });
      return;
    }

    switch (prepared.kind) {
      case "skipped":
        // The person paused or removed it after it matched; they asked for it to stop, so nothing is said.
        settleIntentRun(deps, run.runId, "failed", prepared.reason);
        return;
      case "remind": {
        // Said before it is marked, so a node that stops in between says it again rather than never.
        say(prepared.intent.conversationId, `Nhắc bạn — ${prepared.intent.summary}: ${prepared.message}`);
        tryRecordNodeNotice(services, {
          sourceKind: "automation",
          category: "message",
          severity: "info",
          title: prepared.intent.summary,
          body: prepared.message,
          conversationId: prepared.intent.conversationId,
          dedupKey: `automation:${run.runId}`,
          at: now(),
        });
        settleIntentRun(deps, run.runId, "reminded");
        return;
      }
      case "parked": {
        // Left pending, so every tick looks again and the task goes on once something can run it. Said once.
        if (!prepared.newlyParked) return;
        const text = `Việc tự động "${prepared.intent.summary}" đã khớp ${because}, nhưng đang chờ: ${prepared.reason}. Task ${prepared.taskId} sẽ tiếp tục khi có thứ chạy được nó.`;
        say(prepared.intent.conversationId, text);
        tryRecordNodeNotice(services, {
          sourceKind: "automation",
          category: "alert",
          severity: "warning",
          title: "Việc tự động đang chờ",
          body: text,
          conversationId: prepared.intent.conversationId,
          dedupKey: `automation:${run.runId}`,
          at: now(),
        });
        setIntentRunState(deps.db, run.runId, "pending", now(), prepared.reason);
        return;
      }
      case "dispatch": {
        // Already marked started, together with the dispatch: from here the task is the dispatcher's to report. Left in
        // the inbox as well, because nobody asked for it just now: work that starts on its own is something to find.
        const text = `Việc tự động "${prepared.intent.summary}" bắt đầu vì ${because}: task ${prepared.taskId} đang chạy trên ${prepared.executionNodeId}.`;
        say(prepared.intent.conversationId, text);
        tryRecordNodeNotice(services, {
          sourceKind: "automation",
          category: "message",
          severity: "info",
          title: prepared.intent.summary,
          body: text,
          conversationId: prepared.intent.conversationId,
          dedupKey: `automation:${run.runId}`,
          at: now(),
        });
        services.conductor.runTask?.({
          taskId: prepared.taskId,
          capabilityRef: prepared.capabilityRef,
          executionNodeId: prepared.executionNodeId,
        });
        return;
      }
      case "already-started":
        settleIntentRun(deps, run.runId, "started");
        return;
    }
  };

  const tick = (): void => {
    if (stopped) return;
    kicked = false;
    try {
      fireDueTimers(deps);
      const matched = matchDueSignals(deps);
      for (const dead of matched.dead) {
        tryRecordNodeNotice(services, {
          sourceKind: "automation",
          category: "alert",
          severity: "warning",
          title: "Một tín hiệu không xử lý được",
          body: `${dead.topic}: ${dead.error}. Đã thử lại nhiều lần; tín hiệu được giữ lại nhưng không chạy gì.`,
          dedupKey: `signal-dead:${dead.signalId}`,
          at: now(),
        });
      }
      for (const run of pendingRuns(deps)) {
        if (stopped) return;
        start(run);
      }
    } catch (cause) {
      process.stderr.write(`automation: tick failed (${cause instanceof Error ? cause.message : String(cause)})\n`);
    }
  };

  const timer = setInterval(tick, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();

  return {
    kick() {
      if (stopped || kicked) return;
      kicked = true;
      setImmediate(tick);
    },
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
