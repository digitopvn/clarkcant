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
 * that kept showing it as running would be a list that lies. Losing the list on restart is the honest outcome.
 */
export interface BackgroundSession {
  sessionId: string;
  /** What it is doing, in the words of whoever asked for it. */
  title: string;
  status: "running" | "done" | "failed";
  startedAt: Instant;
  endedAt?: Instant;
}

export interface BackgroundSessions {
  /** Records a session that has started, and answers with the entry as it will be listed. */
  start(input: { sessionId: string; title: string; at: Instant }): BackgroundSession;
  /**
   * Records how one ended.
   *
   * The entry is kept rather than removed: a count that drops to zero the moment work finishes tells a person
   * nothing about whether it succeeded, and the failure of a background request is exactly the thing they need to
   * see without asking.
   */
  finish(input: { sessionId: string; status: "done" | "failed"; at: Instant }): BackgroundSession | undefined;
  /** Newest first, because the one just started is the one being waited for. */
  list(): readonly BackgroundSession[];
  /** How many are running, which is what a status mark shows. */
  running(): number;
}

export function createBackgroundSessions(): BackgroundSessions {
  const sessions = new Map<string, BackgroundSession>();

  return {
    start(input) {
      const entry: BackgroundSession = {
        sessionId: input.sessionId,
        title: input.title.trim() === "" ? "Việc nền" : input.title.trim().slice(0, 200),
        status: "running",
        startedAt: input.at,
      };
      sessions.set(entry.sessionId, entry);
      return entry;
    },
    finish(input) {
      const existing = sessions.get(input.sessionId);
      if (existing === undefined) return undefined;
      const updated: BackgroundSession = { ...existing, status: input.status, endedAt: input.at };
      sessions.set(updated.sessionId, updated);
      return updated;
    },
    list() {
      return [...sessions.values()].sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1));
    },
    running() {
      return [...sessions.values()].filter((entry) => entry.status === "running").length;
    },
  };
}

/**
 * The node's own registry.
 *
 * One instance per process, because the things that start background work and the route that reports it are
 * different parts of the same node and have to be looking at the same list. Tests that need a clean one call
 * `createBackgroundSessions()` themselves.
 */
export const nodeBackgroundSessions = createBackgroundSessions();
