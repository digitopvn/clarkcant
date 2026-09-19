/**
 * Browser sessions, and who is driving.
 *
 * The node can drive a managed browser profile on the user's behalf. That is useful precisely because it
 * is unsupervised most of the time, which is also what makes it the one capability where "the agent is
 * still holding the wheel" has to be a fact the host can change rather than something the user can only
 * wait out.
 *
 * Two verbs, and they are different:
 *
 * - **Takeover** hands the wheel to the user. The session keeps running and keeps its page; what changes
 *   is who may act on it. The agent's next action is refused, not queued.
 * - **Stop** ends the session.
 *
 * The mechanism is the lease epoch that automation already carries: every action is submitted with the
 * epoch it was planned under, and an action whose epoch is stale is refused. Takeover therefore does not
 * need to reach into a running automation and interrupt it — it makes the automation's own next action
 * invalid, which is the only kind of cancellation that works when the actor is a process you do not
 * control.
 *
 * This module deliberately holds no browser. It holds the authority records that decide whether an action
 * against a session may proceed, so it can be reasoned about and tested without launching anything.
 */

export type BrowserSessionOwner = "agent" | "user";

export interface BrowserSession {
  sessionId: string;
  /** What the user would recognise: the page or task the session is on. */
  label: string;
  owner: BrowserSessionOwner;
  status: "running" | "stopped";
  /**
   * Fencing token. An action planned under an older epoch is refused, which is what makes a takeover take
   * effect on a process this node is not synchronously controlling.
   */
  leaseEpoch: number;
  /** Set when the user took the wheel, so the transcript can say who has it. */
  takenOverAt: string | undefined;
  stoppedAt: string | undefined;
}

export interface BrowserSessionRegistry {
  create(input: { sessionId: string; label: string }): BrowserSession;
  get(sessionId: string): BrowserSession | undefined;
  list(): BrowserSession[];
  /** Hand the wheel to the user. Returns undefined when there is no such session. */
  takeover(sessionId: string, at: string): BrowserSession | undefined;
  stop(sessionId: string, at: string): BrowserSession | undefined;
  /**
   * Whether an action may proceed.
   *
   * Refused for three distinct reasons, and the caller is told which: a stopped session cannot act, an
   * action planned under a stale epoch arrived after somebody else took the wheel, and an action the agent
   * planned while the user is driving is the agent trying to take the wheel back.
   */
  admitAction(
    sessionId: string,
    leaseEpoch: number,
  ): { ok: true; session: BrowserSession } | { ok: false; code: BrowserSessionRefusal; message: string };
}

export type BrowserSessionRefusal = "SESSION_STOPPED" | "STALE_LEASE" | "USER_HAS_CONTROL" | "NO_SUCH_SESSION";

export function createBrowserSessionRegistry(): BrowserSessionRegistry {
  const sessions = new Map<string, BrowserSession>();

  const read = (sessionId: string): BrowserSession | undefined => sessions.get(sessionId);

  return {
    create(input) {
      const session: BrowserSession = {
        sessionId: input.sessionId,
        label: input.label,
        owner: "agent",
        status: "running",
        leaseEpoch: 0,
        takenOverAt: undefined,
        stoppedAt: undefined,
      };
      sessions.set(session.sessionId, session);
      return session;
    },

    get: read,

    list() {
      return [...sessions.values()];
    },

    takeover(sessionId, at) {
      const session = read(sessionId);
      // A stopped session has nothing to take over, and flipping its owner would describe a state that
      // cannot be acted on by anybody.
      if (session === undefined || session.status === "stopped") return undefined;
      const next: BrowserSession = {
        ...session,
        owner: "user",
        leaseEpoch: session.leaseEpoch + 1,
        takenOverAt: at,
      };
      sessions.set(sessionId, next);
      return next;
    },

    stop(sessionId, at) {
      const session = read(sessionId);
      if (session === undefined || session.status === "stopped") return undefined;
      const next: BrowserSession = {
        ...session,
        status: "stopped",
        // Bumped as well, so any action already in flight for this session is refused rather than landing
        // on a session that has ended.
        leaseEpoch: session.leaseEpoch + 1,
        stoppedAt: at,
      };
      sessions.set(sessionId, next);
      return next;
    },

    admitAction(sessionId, leaseEpoch) {
      const session = read(sessionId);
      if (session === undefined) {
        return { ok: false, code: "NO_SUCH_SESSION", message: `không có phiên browser nào với id ${sessionId}` };
      }
      if (session.status === "stopped") {
        return { ok: false, code: "SESSION_STOPPED", message: "phiên browser này đã dừng, nên không hành động tiếp" };
      }
      if (leaseEpoch !== session.leaseEpoch) {
        return {
          ok: false,
          code: "STALE_LEASE",
          message: `hành động được lên kế hoạch ở epoch ${leaseEpoch} nhưng phiên đang ở epoch ${session.leaseEpoch}`,
        };
      }
      if (session.owner !== "agent") {
        return {
          ok: false,
          code: "USER_HAS_CONTROL",
          message: "người dùng đang trực tiếp điều khiển phiên browser này",
        };
      }
      return { ok: true, session };
    },
  };
}
