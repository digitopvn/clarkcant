import { type ReactElement, useEffect, useState } from "react";

import type { GatewayClient } from "./api.ts";

interface BackgroundState {
  running: number;
  sessions: { sessionId: string; title: string; status: string }[];
}

/**
 * The work running behind the conversation, as a mark in the header.
 *
 * Absent when there is nothing to say: a header that always shows "0 background" is a header with a permanent line of
 * noise, and the count is only interesting when it is not zero. Finished work is listed too, because the useful
 * question is not only "is something running" but "did the last one finish", and a count that dropped to zero says
 * nothing about which.
 *
 * Polled rather than streamed: this is a value a person glances at, and a stream for it would be a connection held
 * open to watch a number change.
 */
export function BackgroundSessionsMark({ client }: { client: GatewayClient }): ReactElement | null {
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
  }, [client]);

  if (state.sessions.length === 0) return null;

  return (
    <div className="cc-bg-mark" data-background-sessions={String(state.running)} tabIndex={0}>
      <span className="cc-dot" data-state={state.running > 0 ? "ready" : "idle"} aria-hidden="true" />
      <span data-background-count="true">
        {state.running > 0 ? `${state.running} việc nền đang chạy` : "không có việc nền đang chạy"}
      </span>
      <ul className="cc-bg-list" data-background-list="true">
        {state.sessions.map((session) => (
          <li key={session.sessionId}>
            <span data-background-title="true">{session.title}</span>
            <span className="cc-freshness"> — {session.status === "running" ? "đang chạy" : session.status === "done" ? "xong" : "lỗi"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
