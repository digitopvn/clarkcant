import { randomBytes } from "node:crypto";

import type { Instant } from "@clarkcant/contracts";

import {
  type BackgroundSession,
  type BackgroundSessions,
  type FinishedStatus,
  createBackgroundSessions,
} from "./background-sessions.ts";

/**
 * The one owner of "what is running on this node, and how does it end".
 *
 * The person talks to one conversation and one Clark; everything behind that — background workers, the commands the
 * model ran, task workers, terminals — is an implementation detail they should never have to learn. What they do need
 * is two answers that are always true: *what is running* and *stop that*. Before this module each kind of work kept
 * its own map, and every caller that wanted the answer stitched the maps together itself (the stop, the shutdown, the
 * process panel, the header mark), each a little differently. The supervisor is where those answers come from now.
 *
 * It does two different jobs, and they are kept apart on purpose:
 *
 *   - **It owns the background lane.** A background request is admitted here, under a node-wide limit, with a bounded
 *     queue behind it and a deadline on each run. The main conversation turn never counts against the limit, so the
 *     conversation always answers. A full queue is refused in words rather than silently accepted.
 *   - **It reads the other kinds through sources.** A command, a task worker and a terminal each still belong to the
 *     module that starts them — that is where their process lives — and register a source that can list and stop
 *     them. The supervisor does not reach into their state; it asks.
 *
 * Every run it admits is written to the journal while it runs, so the next boot can tell what an earlier process
 * left unfinished (`work-recovery.ts`).
 */

export type WorkKind = "background" | "command" | "task" | "terminal";
export type WorkState = BackgroundSession["status"];

/** One piece of work, as a listing shows it: no pid, no path beyond what the person already saw, no environment. */
export interface WorkView {
  workId: string;
  kind: WorkKind;
  title: string;
  state: WorkState;
  conversationId?: string;
  startedAt: string;
  endedAt?: string;
  /** For queued background work: its place in the queue, 1 being next. */
  position?: number;
}

/** A kind of work the supervisor lists and stops, owned by the module that starts it. */
export interface WorkSource {
  kind: Exclude<WorkKind, "background">;
  list(): WorkView[];
  /** Stop one, answering whether it was running. */
  cancel(workId: string): boolean;
}

/**
 * Why a background run's signal was aborted.
 *
 * Carried as the abort reason, so the code that reports the outcome into the conversation can say what actually
 * happened: a person stopping it, the run overrunning its deadline, and the node shutting down are three different
 * sentences, and only the first is "stopped".
 */
export class WorkAbort extends Error {
  readonly cause_: "stopped" | "deadline" | "shutdown";
  constructor(cause: "stopped" | "deadline" | "shutdown", message: string) {
    super(message);
    this.name = "WorkAbort";
    this.cause_ = cause;
  }
}

/** The journal the supervisor writes while a run is open. Implemented over `work_runs` by `work-journal.ts`. */
export interface WorkJournal {
  opened(entry: {
    workId: string;
    kind: "background";
    conversationId: string;
    title: string;
    requestText: string;
    state: "queued" | "running";
    attempt: number;
    effectful: boolean;
    startedAt: Instant;
  }): void;
  moved(workId: string, state: WorkState, at: Instant): void;
}

export interface BackgroundSubmission {
  /** Given when re-running a known piece of work; otherwise a new id is made. */
  workId?: string;
  conversationId: string;
  title: string;
  /** What was asked, kept so a run the node lost to a restart can be asked again. */
  requestText: string;
  /** Re-runs after a restart so far. Zero for new work. */
  attempt?: number;
  /**
   * The work itself. Resolves when it is done, rejects when it failed; the signal aborts on a stop, the deadline, or
   * shutdown, with a `WorkAbort` as its reason. Reporting the outcome into the conversation is the run's job — it is
   * the part that knows what the work said.
   */
  run: (signal: AbortSignal, workId: string) => Promise<void>;
  /** Told when a person takes the request out of the queue before it started, since `run` is then never called. */
  onDequeued?: () => void;
}

export type SubmitOutcome =
  | { accepted: true; workId: string; state: "running" | "queued"; position?: number }
  | { accepted: false; reason: "queue-full" | "closing"; message: string; running: readonly WorkView[] };

export type CancelOutcome = "stopped" | "dequeued" | "already-ended" | "unknown";

export interface WorkSupervisor {
  /** Admit one background request: running now, queued for a place, or refused because the queue is full. */
  submitBackground(input: BackgroundSubmission): SubmitOutcome;
  /** Stop one piece of work, of any kind, by the id a listing showed. */
  cancel(workId: string): CancelOutcome;
  /** Stop every background run and empty the queue, answering how many there were. */
  cancelBackground(reason?: "stopped" | "shutdown"): number;
  /** Everything, newest first; finished background entries are kept for a while (see `background-sessions.ts`). */
  list(filter?: { conversationId?: string; includeFinished?: boolean }): WorkView[];
  /** The background lane alone, as the header mark and `/background-sessions` show it. */
  background(): { running: number; queued: number; sessions: readonly BackgroundSession[] };
  addSource(source: WorkSource): () => void;
  /** How many background runs may run at once. */
  backgroundLimit(): number;
  /** Start queued runs that now have a place, after the limit was raised. */
  refill(): void;
  /** Stop the background lane and wait, at most `timeoutMs`, for its runs to settle. */
  drain(timeoutMs: number): Promise<void>;
}

/** The limit a node starts with, and the choices Settings offers. */
export const DEFAULT_BACKGROUND_LIMIT = 3;
export const BACKGROUND_LIMIT_CHOICES = [1, 3, 5] as const;
/** How many requests may wait for a place. Past this a request is refused in words, not queued out of sight. */
export const BACKGROUND_QUEUE_LIMIT = 10;
/** How long one background run may take before it is stopped. */
export const DEFAULT_BACKGROUND_DEADLINE_MS = 20 * 60_000;

/** The deadline from the environment, or the default. A value that is not a positive number is ignored, not guessed at. */
export function backgroundDeadlineFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = Number(env["CC_BACKGROUND_MAX_MS"]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BACKGROUND_DEADLINE_MS;
}

/** A limit read from storage, reduced to one of the choices; anything else is the default. */
export function normalizeBackgroundLimit(value: unknown): number {
  return typeof value === "number" && (BACKGROUND_LIMIT_CHOICES as readonly number[]).includes(value)
    ? value
    : DEFAULT_BACKGROUND_LIMIT;
}

interface OpenRun {
  submission: BackgroundSubmission;
  workId: string;
  controller: AbortController;
  settled?: Promise<void>;
}

export function createWorkSupervisor(
  options: {
    now?: () => Instant;
    /** Read at every admission, so a change in Settings applies to the next request without a restart. */
    backgroundLimit?: () => number;
    queueLimit?: number;
    deadlineMs?: number;
    journal?: WorkJournal;
    store?: BackgroundSessions;
  } = {},
): WorkSupervisor {
  const now = options.now ?? ((): Instant => new Date().toISOString() as Instant);
  const store = options.store ?? createBackgroundSessions({ now });
  const readLimit = (): number => {
    try {
      return normalizeBackgroundLimit(options.backgroundLimit?.() ?? DEFAULT_BACKGROUND_LIMIT);
    } catch {
      // A preference that cannot be read is not a reason to refuse work; the default is what a new node runs with.
      return DEFAULT_BACKGROUND_LIMIT;
    }
  };
  const queueLimit = options.queueLimit ?? BACKGROUND_QUEUE_LIMIT;
  const deadlineMs = options.deadlineMs ?? DEFAULT_BACKGROUND_DEADLINE_MS;
  const sources: WorkSource[] = [];
  const running = new Map<string, OpenRun>();
  const queue: OpenRun[] = [];
  /** Set once the node starts shutting down: nothing new is admitted into a lane that is being drained. */
  let closing = false;

  const journal = (write: (journal: WorkJournal) => void): void => {
    if (options.journal === undefined) return;
    try {
      write(options.journal);
    } catch {
      // The journal is how a later boot learns about this run; failing to write it does not stop the run itself.
    }
  };

  const settle = (workId: string, status: FinishedStatus): void => {
    store.finish({ sessionId: workId, status, at: now() });
    // A run the shutdown interrupted keeps its open row: that open row is how the next boot finds it and says so in
    // the conversation (`work-recovery.ts`). Closing it here would make the restart silent.
    if (status === "interrupted") return;
    journal((j) => j.moved(workId, status, now()));
  };

  const start = (open: OpenRun): void => {
    running.set(open.workId, open);
    store.markRunning({ sessionId: open.workId, at: now() });
    journal((j) => j.moved(open.workId, "running", now()));
    const { signal } = open.controller;
    const timer = setTimeout(() => {
      open.controller.abort(
        new WorkAbort("deadline", `việc nền chạy quá ${describeDuration(deadlineMs)} nên đã bị dừng`),
      );
    }, deadlineMs);
    timer.unref?.();
    open.settled = (async () => {
      let status: FinishedStatus;
      try {
        await open.submission.run(signal, open.workId);
        status = signal.aborted ? statusFor(signal.reason) : "done";
      } catch {
        status = signal.aborted ? statusFor(signal.reason) : "failed";
      } finally {
        clearTimeout(timer);
        running.delete(open.workId);
      }
      settle(open.workId, status);
      pump();
    })();
  };

  const pump = (): void => {
    while (!closing && running.size < readLimit()) {
      const next = queue.shift();
      if (next === undefined) return;
      start(next);
    }
  };

  const views = (entries: readonly BackgroundSession[]): WorkView[] =>
    entries.map((entry) => {
      const position = queue.findIndex((open) => open.workId === entry.sessionId);
      return {
        workId: entry.sessionId,
        kind: "background",
        title: entry.title,
        state: entry.status,
        ...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
        startedAt: entry.startedAt,
        ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
        ...(position < 0 ? {} : { position: position + 1 }),
      };
    });

  const cancelOpen = (workId: string, reason: "stopped" | "shutdown"): CancelOutcome | undefined => {
    const queuedAt = queue.findIndex((open) => open.workId === workId);
    if (queuedAt >= 0) {
      const [dequeued] = queue.splice(queuedAt, 1);
      if (dequeued !== undefined) {
        dequeued.controller.abort(new WorkAbort(reason, "đã dừng trước khi bắt đầu"));
        settle(workId, reason === "shutdown" ? "interrupted" : "stopped");
        if (reason === "stopped") {
          try {
            dequeued.submission.onDequeued?.();
          } catch {
            // The dequeue happened; only its line in the conversation was lost.
          }
        }
      }
      return "dequeued";
    }
    const open = running.get(workId);
    if (open !== undefined) {
      open.controller.abort(
        new WorkAbort(reason, reason === "shutdown" ? "node đang tắt" : "người dùng đã dừng việc này"),
      );
      return "stopped";
    }
    return undefined;
  };

  const cancelBackground = (reason: "stopped" | "shutdown" = "stopped"): number => {
    const open = [...queue, ...running.values()];
    for (const entry of open) cancelOpen(entry.workId, reason);
    return open.length;
  };

  return {
    submitBackground(input) {
      const workId = input.workId ?? `bg-${randomBytes(6).toString("hex")}`;
      const title = input.title.trim() === "" ? "Việc nền" : input.title.trim().slice(0, 200);
      if (closing) {
        return {
          accepted: false,
          reason: "closing",
          message: "Node đang tắt nên việc này chưa được bắt đầu. Nhắn lại sau khi node chạy lại.",
          running: [],
        };
      }
      // A limit raised since the last admission frees places for what is already waiting, ahead of this request.
      pump();
      const hasPlace = running.size < readLimit() && queue.length === 0;
      if (!hasPlace && queue.length >= queueLimit) {
        const busy = views(store.list().filter((entry) => entry.status === "running"));
        return {
          accepted: false,
          reason: "queue-full",
          message: `Node đang bận: ${String(running.size)} việc nền đang chạy và ${String(queue.length)} việc đang chờ, là mức tối đa. Việc này chưa được bắt đầu; hãy dừng bớt một việc hoặc thử lại sau.`,
          running: busy,
        };
      }
      const open: OpenRun = { submission: input, workId, controller: new AbortController() };
      const state = hasPlace ? "running" : "queued";
      store.start({ sessionId: workId, title, at: now(), conversationId: input.conversationId, status: "queued" });
      journal((j) =>
        j.opened({
          workId,
          kind: "background",
          conversationId: input.conversationId,
          title,
          requestText: input.requestText,
          state: "queued",
          attempt: input.attempt ?? 0,
          // A background worker has no project root and only read-only tools (`createWorkerSession`), so nothing it
          // does can change anything outside this node. That is what makes it safe to run again after a restart.
          effectful: false,
          startedAt: now(),
        }),
      );
      if (hasPlace) {
        start(open);
        return { accepted: true, workId, state };
      }
      queue.push(open);
      return { accepted: true, workId, state, position: queue.length };
    },

    cancel(workId) {
      const own = cancelOpen(workId, "stopped");
      if (own !== undefined) return own;
      if (store.get(workId) !== undefined) return "already-ended";
      for (const source of sources) {
        if (source.cancel(workId)) return "stopped";
      }
      return "unknown";
    },

    cancelBackground,

    list(filter = {}) {
      const all = [...views(store.list()), ...sources.flatMap((source) => source.list())];
      return all
        .filter((view) => filter.conversationId === undefined || view.conversationId === filter.conversationId)
        .filter((view) => filter.includeFinished === true || view.state === "running" || view.state === "queued")
        .sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1));
    },

    background() {
      return { running: store.running(), queued: store.queued(), sessions: store.list() };
    },

    addSource(source) {
      sources.push(source);
      return () => {
        const index = sources.indexOf(source);
        if (index >= 0) sources.splice(index, 1);
      };
    },

    backgroundLimit: readLimit,

    refill: pump,

    async drain(timeoutMs) {
      closing = true;
      const settling = [...running.values()].flatMap((open) => (open.settled === undefined ? [] : [open.settled]));
      cancelBackground("shutdown");
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(settling),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** A duration as the conversation says it: seconds under a minute, so a short deadline never reads "0 phút". */
export function describeDuration(ms: number): string {
  if (ms < 60_000) return `${String(Math.max(1, Math.round(ms / 1_000)))} giây`;
  return `${String(Math.round(ms / 60_000))} phút`;
}

function statusFor(reason: unknown): FinishedStatus {
  if (reason instanceof WorkAbort) {
    if (reason.cause_ === "stopped") return "stopped";
    if (reason.cause_ === "shutdown") return "interrupted";
  }
  return "failed";
}

/**
 * The node's own supervisor.
 *
 * One per process, like the command registry it sits beside: the routes that start work, the stop, the shutdown and
 * the model's tools are different parts of the same node and have to be looking at the same list. `main.ts` gives it
 * its journal and its limit at boot (`configureNodeWork`); a test that needs a clean one calls `createWorkSupervisor`.
 */
let nodeSupervisor: WorkSupervisor = createWorkSupervisor();

export function nodeWork(): WorkSupervisor {
  return nodeSupervisor;
}

/** Replace the node's supervisor. Called once at boot, before anything can submit work. */
export function configureNodeWork(supervisor: WorkSupervisor): WorkSupervisor {
  nodeSupervisor = supervisor;
  return supervisor;
}
