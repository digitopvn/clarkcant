import type { Instant } from "@clarkcant/contracts";

/**
 * The work running behind the conversation.
 *
 * A background session is a worker this node started so that a request could keep going while the person carried
 * on with something else. It is not a conversation: it has a title, a state and a result that will be reported back
 * when it finishes, and it has no transcript of its own until it reports.
 *
 * Held in memory rather than in the database, deliberately. A background session that outlived the process that
 * started it would be a session nobody can reach: its worker is gone, its result would never arrive, and a list
 * that kept showing it as running would be a list that lies. What survives a restart is the durable `work_runs`
 * row the supervisor writes beside this entry, and what the next boot does with it is say so in the conversation.
 */
export type BackgroundStatus = "queued" | "running" | "done" | "failed" | "stopped" | "interrupted";

export interface BackgroundSession {
  /** The work id: the same id a listing shows and a stop takes. */
  sessionId: string;
  /** What it is doing, in the words of whoever asked for it. */
  title: string;
  /**
   * Where it is. `queued` is waiting for a place under the node's limit; `stopped` is a person's decision, which is
   * a different fact from `failed`; `interrupted` is the node going away underneath it.
   */
  status: BackgroundStatus;
  /** The conversation that asked for it, where its outcome is reported. */
  conversationId?: string;
  startedAt: Instant;
  endedAt?: Instant;
}

export type FinishedStatus = Exclude<BackgroundStatus, "queued" | "running">;

export interface BackgroundSessions {
  /** Records a session that has started, and answers with the entry as it will be listed. */
  start(input: {
    sessionId: string;
    title: string;
    at: Instant;
    conversationId?: string;
    /** `queued` when it is waiting for a place; running otherwise. */
    status?: "queued" | "running";
  }): BackgroundSession;
  /** A queued entry that has been given its place. */
  markRunning(input: { sessionId: string; at: Instant }): BackgroundSession | undefined;
  /**
   * Records how one ended.
   *
   * The entry is kept for a while rather than removed: a count that drops to zero the moment work finishes tells a
   * person nothing about whether it succeeded, and the failure of a background request is exactly the thing they need
   * to see without asking. How long is the retention below, and past it the entry goes — the outcome itself is a
   * message in the conversation, which outlives this list.
   */
  finish(input: { sessionId: string; status: FinishedStatus; at: Instant }): BackgroundSession | undefined;
  /** One entry, or undefined when it was never started or has aged out. */
  get(sessionId: string): BackgroundSession | undefined;
  /** Newest first, because the one just started is the one being waited for. */
  list(): readonly BackgroundSession[];
  /** How many are running, which is what a status mark shows. */
  running(): number;
  /** How many are waiting for a place. */
  queued(): number;
}

/**
 * How long a finished entry is kept, and how many of them.
 *
 * The outcome of the work is a message in the conversation, which outlives this process; the list is here so a glance
 * at the header right after something ends can still say what happened. Keeping every finished entry forever would be
 * an unbounded list answering a question the conversation already answers, so the tail is bounded at both ends.
 */
export const FINISHED_RETENTION_MS = 10 * 60_000;
export const MAX_FINISHED_ENTRIES = 20;

export function createBackgroundSessions(options: { now?: () => Instant } = {}): BackgroundSessions {
  const sessions = new Map<string, BackgroundSession>();
  const now = options.now ?? ((): Instant => new Date().toISOString() as Instant);

  /*
   * Drop what nothing can be waiting for any more.
   *
   * Two bounds, and they are different kinds of bound. Age drops a finished entry nobody is looking at any more. The
   * count caps the list when work finishes faster than it ages out. A *running* entry is never dropped by either: it
   * is the one thing this list exists to report, and a count that quietly forgot a worker would be worse than a list
   * that is long. A queued entry is kept for the same reason: it is work somebody is still waiting for.
   */
  const open = (entry: BackgroundSession): boolean => entry.status === "running" || entry.status === "queued";
  const prune = (): void => {
    const cutoff = new Date(Date.parse(now()) - FINISHED_RETENTION_MS).toISOString();
    for (const [sessionId, entry] of sessions) {
      if (!open(entry) && entry.endedAt !== undefined && entry.endedAt < cutoff) {
        sessions.delete(sessionId);
      }
    }
    const finished = [...sessions.values()]
      .filter((entry) => !open(entry))
      .sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1));
    for (const entry of finished.slice(MAX_FINISHED_ENTRIES)) sessions.delete(entry.sessionId);
  };

  return {
    start(input) {
      prune();
      const entry: BackgroundSession = {
        sessionId: input.sessionId,
        title: input.title.trim() === "" ? "Việc nền" : input.title.trim().slice(0, 200),
        status: input.status ?? "running",
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        startedAt: input.at,
      };
      sessions.set(entry.sessionId, entry);
      return entry;
    },
    markRunning(input) {
      const existing = sessions.get(input.sessionId);
      if (existing === undefined || existing.status !== "queued") return existing;
      // The start time moves to when it actually started: "running for 2 minutes" must not count the wait.
      const updated: BackgroundSession = { ...existing, status: "running", startedAt: input.at };
      sessions.set(updated.sessionId, updated);
      return updated;
    },
    get(sessionId) {
      prune();
      return sessions.get(sessionId);
    },
    finish(input) {
      prune();
      const existing = sessions.get(input.sessionId);
      if (existing === undefined) return undefined;
      const updated: BackgroundSession = { ...existing, status: input.status, endedAt: input.at };
      sessions.set(updated.sessionId, updated);
      return updated;
    },
    list() {
      prune();
      return [...sessions.values()].sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1));
    },
    running() {
      prune();
      return [...sessions.values()].filter((entry) => entry.status === "running").length;
    },
    queued() {
      prune();
      return [...sessions.values()].filter((entry) => entry.status === "queued").length;
    },
  };
}

