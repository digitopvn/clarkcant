import type { WidgetPerformReport } from "@clarkcant/contracts";

/**
 * What became of an action Clark asked a widget's frame to perform, as far as this node can know.
 *
 * - a `WidgetPerformReport`: the page asked the frame and says what it answered, or why it could not ask;
 * - `"no-surface"`: no live page was sent the request, so nothing was asked and nothing ran;
 * - `"timeout"`: a live page was sent it and did not report in time. The frame may have done it.
 */
export type WidgetPerformAwaited = WidgetPerformReport | "no-surface" | "timeout";

/**
 * The page's side of performing an offered action, held between "sent" and "answered".
 *
 * Only the page that mounts the widget can hand the request to its frame, and only the frame knows whether it did it.
 * So a transport that forwards a `widget-perform` event to a live page `expect`s its id first, the page reports back
 * under that id, and the dispatch `wait`s for the report. A transport that cannot deliver before the turn ends never
 * expects one, and the dispatch learns at once that there is nobody to ask — nothing is queued for later.
 *
 * In memory and per node: a perform belongs to the page and the turn that are running now.
 */
export interface WidgetPerformAcks {
  /** A transport is about to deliver this perform to a live page that will report back. */
  expect(performId: string): void;
  /** The page's report. `false` when nothing was expecting it: unknown, already reported, or given up on. */
  settle(performId: string, report: WidgetPerformReport): boolean;
  /** The report, `"no-surface"` when no live page was sent this id, or `"timeout"`. Settles each id once. */
  wait(performId: string, timeoutMs?: number): Promise<WidgetPerformAwaited>;
}

/**
 * A little longer than the frame's own wait for its widget's answer, so a frame that does not answer is reported as
 * such by the page rather than the node giving up first; short enough that a page that went away does not hold the
 * model's turn hostage.
 */
export const WIDGET_PERFORM_TIMEOUT_MS = 8_000;

interface Pending {
  report: WidgetPerformReport | undefined;
  resolve: ((report: WidgetPerformReport) => void) | undefined;
}

export function createWidgetPerformAcks(): WidgetPerformAcks {
  const pending = new Map<string, Pending>();

  return {
    expect(performId) {
      if (!pending.has(performId)) pending.set(performId, { report: undefined, resolve: undefined });
    },
    settle(performId, report) {
      const entry = pending.get(performId);
      if (entry === undefined || entry.report !== undefined) return false;
      entry.report = report;
      entry.resolve?.(report);
      return true;
    },
    async wait(performId, timeoutMs = WIDGET_PERFORM_TIMEOUT_MS) {
      const entry = pending.get(performId);
      if (entry === undefined) return "no-surface";
      try {
        if (entry.report !== undefined) return entry.report;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const answered = new Promise<WidgetPerformReport>((resolve) => {
          entry.resolve = resolve;
        });
        const expired = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const outcome = await Promise.race([answered, expired]);
        clearTimeout(timer);
        return outcome;
      } finally {
        // Forgotten either way, so a late report is answered `false` rather than held for a turn that moved on.
        pending.delete(performId);
      }
    },
  };
}
