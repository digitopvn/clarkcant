import { type ReactElement, useEffect, useState } from "react";

import type { ConnectionStatus } from "./connection-watch.ts";
import { useT } from "./i18n/locale-context.tsx";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * The sentences under the header while the node does not answer: what failed, what is kept, and what happens next.
 * Undefined while there is nothing to explain — before the first check has failed, and once the node answered.
 */
export function connectionNoticeText(
  status: ConnectionStatus,
  now: number,
  t: (key: MessageKey) => string,
): { failed: string; kept: string; next: string } | undefined {
  if (status.state !== "offline" || status.failure === undefined) return undefined;
  const failure = status.failure;
  const failed =
    failure.kind === "refused"
      ? t("shell.connection.refused").replace("{status}", String(failure.status))
      : t(failure.kind === "timeout" ? "shell.connection.timeout" : "shell.connection.unreachable");
  let next: string;
  if (status.checking) next = t("shell.connection.checking");
  else if (status.nextCheckAt !== undefined)
    next = t("shell.connection.nextCheck").replace("{seconds}", String(Math.max(0, Math.ceil((status.nextCheckAt - now) / 1000))));
  else if (status.paused === true) next = t("shell.connection.paused");
  else next = t("shell.connection.gaveUp");
  return { failed, kept: t("shell.connection.kept"), next };
}

/**
 * Why the header says the node is disconnected, and a way to check now.
 *
 * Deliberately outside the header's live region: the header announces the state once when it changes, and a countdown
 * read aloud every second would be noise. The countdown is the real timer of the next check, not an animation.
 */
export function ConnectionNotice({ status, onCheckNow }: { status: ConnectionStatus; onCheckNow: () => void }): ReactElement | null {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const counting = status.state === "offline" && !status.checking && status.nextCheckAt !== undefined;
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [counting, status.nextCheckAt]);

  const text = connectionNoticeText(status, now, t);
  if (text === undefined) return null;
  return (
    <div className="cc-connection-notice" data-connection-notice={status.failure?.kind}>
      <p>
        {text.failed} {text.kept} <span data-connection-next="true">{text.next}</span>
      </p>
      <button type="button" className="cc-badge" data-connection-check="true" disabled={status.checking} onClick={onCheckNow}>
        {t("shell.connection.checkNow")}
      </button>
    </div>
  );
}
