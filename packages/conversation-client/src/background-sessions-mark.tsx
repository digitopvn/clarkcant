import { type ReactElement, useEffect, useState } from "react";

import type { GatewayClient } from "./api.ts";
import { useT } from "./i18n/locale-context.tsx";

interface BackgroundState {
  running: number;
  sessions: { sessionId: string; title: string; status: string }[];
}

/**
 * The work running behind the conversation, as a mark in the header.
 *
 * Absent when there is nothing running: a header that always shows "0 background" is a header with a permanent line of
 * noise, and the count is only interesting when it is not zero. What the last piece of work *did* is not here — that is
 * a message in the conversation, which carries the result and outlives the node's process, while this mark is a glance
 * at work in flight.
 *
 * Polled rather than streamed: this is a value a person glances at, and a stream for it would be a connection held
 * open to watch a number change. The poll interval is also why the mark can survive a finished session for a few
 * seconds; five seconds is the resolution of a glance, and asking for finer would be asking for a stream.
 */
export function BackgroundSessionsMark({
  client,
  refreshKey = 0,
}: {
  client: GatewayClient;
  /**
   * Changes when something has just started work, to make this read again now.
   *
   * A poll is the wrong shape for the start of work: the number has to appear when somebody causes it, not up to an
   * interval later, and a session can end before the next tick ever comes. The end still comes from the poll, which is
   * the right shape for it — nothing is waiting on it.
   */
  refreshKey?: number;
}): ReactElement | null {
  const t = useT();
  const [state, setState] = useState<BackgroundState>({ running: 0, sessions: [] });

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void client
        .backgroundSessions()
        .then((loaded) => {
          if (!cancelled) setState(loaded);
        })
        .catch(() => {
          // A node that cannot answer is not a reason to draw a mark: the header says what it knows, and nothing here
          // is worth showing a failure for.
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, refreshKey]);

  // Nothing running, nothing to say. A finished session is not drawn: its outcome is in the conversation, and a mark
  // that stayed after the work ended would be a permanent line about something that is over.
  if (state.running === 0) return null;
  const running = state.sessions.filter((session) => session.status === "running");

  return (
    <div className="cc-bg-mark" data-background-sessions={String(state.running)} tabIndex={0}>
      <span className="cc-dot" data-state="ready" aria-hidden="true" />
      <span data-background-count="true">{t("shell.background.runningCount").replace("{count}", String(state.running))}</span>
      <ul className="cc-bg-list" data-background-list="true">
        {running.map((session) => (
          <li key={session.sessionId}>
            <span data-background-title="true">{session.title}</span>
            <span className="cc-freshness">{t("shell.background.runningSuffix")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
