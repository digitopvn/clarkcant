/**
 * Driven surfaces, and who is driving.
 *
 * The node can drive a managed browser profile, and on a supported desktop it can drive the machine itself.
 * Both are useful precisely because they run unsupervised most of the time, which is also what makes them the
 * capabilities where "the agent is still holding the wheel" has to be a fact the host can change rather than
 * something the user waits out.
 *
 * One model for both rather than two. The question "who may act on this surface" does not change with the
 * surface, and two implementations of it would drift in exactly the place where drift is a safety problem.
 *
 * Two verbs, and they are different:
 *
 * - **Takeover** hands the wheel to the user. The session keeps running and keeps its page or its screen; what
 *   changes is who may act on it. The agent's next action is refused, not queued.
 * - **Stop** ends the session.
 *
 * The mechanism is the lease epoch that automation already carries: every action is submitted with the epoch it
 * was planned under, and an action whose epoch is stale is refused. Takeover therefore does not need to reach
 * into a running automation and interrupt it — it makes that automation's own next action invalid, which is the
 * only kind of cancellation that works when the actor is a process this node does not synchronously control.
 *
 * This module deliberately holds no browser and no desktop. It holds the authority records that decide whether
 * an action against a surface may proceed, so it can be reasoned about and tested without launching anything.
 */

export type ControlSurface = "browser" | "computer";

/**
 * How the surface can currently be observed.
 *
 * `needs-permission` is a first-class state rather than an error, because on a desktop the operating system
 * owns that permission: the node cannot grant it, and a card that showed a stale or blank preview as if it were
 * live would be claiming a view of the screen that nobody has.
 */
export type PreviewState = "available" | "needs-permission" | "unavailable";

export type ControlSessionOwner = "agent" | "user";

export interface ControlSession {
  sessionId: string;
  surface: ControlSurface;
  /** What the user would recognise: the page, or the window task, the session is on. */
  label: string;
  owner: ControlSessionOwner;
  status: "running" | "stopped";
  /**
   * Fencing token. An action planned under an older epoch is refused, which is what makes a takeover take
   * effect on a process this node is not synchronously controlling.
   */
  leaseEpoch: number;
  preview: PreviewState;
  /** Why the preview is not available. Shown to the user rather than kept internal. */
  previewReason: string | undefined;
  /** Set when the user took the wheel, so the transcript can say who has it. */
  takenOverAt: string | undefined;
  stoppedAt: string | undefined;
}

export type ControlSessionRefusal =
  | "NO_SUCH_SESSION"
  | "SESSION_STOPPED"
  | "STALE_LEASE"
  | "USER_HAS_CONTROL"
  | "PREVIEW_UNAVAILABLE";

export interface ControlSessionRegistry {
  create(input: {
    sessionId: string;
    surface: ControlSurface;
    label: string;
    preview?: PreviewState;
    previewReason?: string;
  }): ControlSession;
  get(sessionId: string): ControlSession | undefined;
  list(): ControlSession[];
  /** Hand the wheel to the user. Returns undefined when there is nothing to hand over. */
  takeover(sessionId: string, at: string): ControlSession | undefined;
  stop(sessionId: string, at: string): ControlSession | undefined;
  /**
   * Whether an action may proceed.
   *
   * Refused for five distinct reasons, and the caller is told which: a stopped session cannot act; an action
   * planned under a stale epoch arrived after somebody else took the wheel; an action the agent planned while
   * the user is driving is the agent trying to take the wheel back; and a surface that cannot be observed
   * cannot be acted on, because acting blind is how an unsupervised effect lands somewhere nobody is looking.
   */
  admitAction(
    sessionId: string,
    leaseEpoch: number,
  ): { ok: true; session: ControlSession } | { ok: false; code: ControlSessionRefusal; message: string };
}

export function createControlSessionRegistry(): ControlSessionRegistry {
  const sessions = new Map<string, ControlSession>();

  const read = (sessionId: string): ControlSession | undefined => sessions.get(sessionId);

  return {
    create(input) {
      const session: ControlSession = {
        sessionId: input.sessionId,
        surface: input.surface,
        label: input.label,
        owner: "agent",
        status: "running",
        leaseEpoch: 0,
        // A browser session is observable through its own page view; a desktop session is observable only when
        // the operating system has granted the permission, so it says so until told otherwise.
        preview: input.preview ?? (input.surface === "browser" ? "available" : "needs-permission"),
        previewReason: input.previewReason,
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
      // A stopped session has nothing to take over, and flipping its owner would describe a state that cannot
      // be acted on by anybody.
      if (session === undefined || session.status === "stopped") return undefined;
      const next: ControlSession = {
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
      const next: ControlSession = {
        ...session,
        status: "stopped",
        // Bumped as well, so any action already in flight for this session is refused rather than landing on a
        // session that has ended.
        leaseEpoch: session.leaseEpoch + 1,
        stoppedAt: at,
      };
      sessions.set(sessionId, next);
      return next;
    },

    admitAction(sessionId, leaseEpoch) {
      const session = read(sessionId);
      if (session === undefined) {
        return { ok: false, code: "NO_SUCH_SESSION", message: `không có phiên nào với id ${sessionId}` };
      }
      if (session.status === "stopped") {
        return { ok: false, code: "SESSION_STOPPED", message: "phiên này đã dừng, nên không hành động tiếp" };
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
          message: "người dùng đang trực tiếp điều khiển phiên này",
        };
      }
      if (session.preview !== "available") {
        // Acting on a surface nobody can see is how an unsupervised effect lands where no one is looking, and on
        // a desktop the missing permission is the operating system's to grant, not this node's to assume.
        return {
          ok: false,
          code: "PREVIEW_UNAVAILABLE",
          message:
            session.previewReason ??
            "chưa quan sát được bề mặt này, nên không hành động khi không nhìn thấy gì",
        };
      }
      return { ok: true, session };
    },
  };
}
