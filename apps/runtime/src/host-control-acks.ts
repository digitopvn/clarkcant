import type { AppIntentDecision, HostControlReport } from "@clarkcant/contracts";

/**
 * What became of an agent-issued app-control action, as far as this node can know.
 *
 * - a `HostControlReport`: the page's executor ran it, or said why it could not;
 * - `"deferred"`: no live screen was watching when it was issued, so it travels with the finished
 *   answer (the plain HTTP message route) and nobody can report on it before this turn ends;
 * - `"timeout"`: a live screen was sent it and did not answer in time.
 */
export type HostControlAwaited = HostControlReport | "deferred" | "timeout";

/**
 * The page's side of `control_app`, held for the moment between "sent" and "done".
 *
 * `control_app` must not tell the model an action succeeded because it was recognised or sent: only the
 * page's one executor knows whether Settings opened or the model switch was refused. So a transport that
 * forwards a `host-control` event to a live screen `expect`s its id first, the page reports back under that
 * id, and the tool `wait`s for the report. A transport that cannot deliver before the turn ends never
 * expects one, and the tool learns that immediately instead of stalling the turn it belongs to.
 *
 * In memory and per node, like the control sessions: an action belongs to the screen and the turn that are
 * running now, and after a restart there is neither to report on.
 */
export interface HostControlAcks {
  /** A transport is about to deliver this decision to a live screen that will report back. */
  expect(decision: AppIntentDecision): void;
  /** The page's report. `false` when nothing was expecting it: unknown, already reported, or given up on. */
  settle(controlId: string, report: HostControlReport): boolean;
  /** The report, `"deferred"` when no live screen was sent this id, or `"timeout"`. Settles each id once. */
  wait(controlId: string, timeoutMs?: number): Promise<HostControlAwaited>;
}

/**
 * Long enough for a panel to open or a model-pool call to answer on a slow machine, short enough that a
 * screen that went away does not hold the model's turn hostage. Opening voice only has to show the voice
 * surface in this time; the microphone prompt that follows is the operating system's, not this report's.
 */
export const HOST_CONTROL_TIMEOUT_MS = 8_000;

interface Pending {
  report: HostControlReport | undefined;
  resolve: ((report: HostControlReport) => void) | undefined;
}

export function createHostControlAcks(): HostControlAcks {
  const pending = new Map<string, Pending>();

  return {
    expect(decision) {
      if (decision.kind !== "intent" || decision.controlId === undefined) return;
      if (!pending.has(decision.controlId)) pending.set(decision.controlId, { report: undefined, resolve: undefined });
    },
    settle(controlId, report) {
      const entry = pending.get(controlId);
      if (entry === undefined || entry.report !== undefined) return false;
      entry.report = report;
      entry.resolve?.(report);
      return true;
    },
    async wait(controlId, timeoutMs = HOST_CONTROL_TIMEOUT_MS) {
      const entry = pending.get(controlId);
      if (entry === undefined) return "deferred";
      try {
        // A page fast enough to report before the tool asked is still a report.
        if (entry.report !== undefined) return entry.report;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const answered = new Promise<HostControlReport>((resolve) => {
          entry.resolve = resolve;
        });
        const expired = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const outcome = await Promise.race([answered, expired]);
        clearTimeout(timer);
        return outcome;
      } finally {
        // Forgotten either way, so a report that arrives after the tool gave up is answered `false`
        // rather than being held for a turn that already told the model it was not confirmed.
        pending.delete(controlId);
      }
    },
  };
}
