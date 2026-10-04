import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ConnectionFailure, ConnectionStatus } from "./connection-watch.ts";
import { useT } from "./i18n/locale-context.tsx";
import type { MessageKey } from "./i18n/messages.ts";

const FAILURE_KEYS: Record<Exclude<ConnectionFailure["kind"], "refused">, MessageKey> = {
  unreachable: "shell.connection.unreachable",
  timeout: "shell.connection.timeout",
  notNode: "shell.connection.notNode",
};

function failureText(failure: ConnectionFailure, t: (key: MessageKey) => string): string {
  return failure.kind === "refused"
    ? t("shell.connection.refused").replace("{status}", String(failure.status))
    : t(FAILURE_KEYS[failure.kind]);
}

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
  const failed = failureText(status.failure, t);
  let next: string;
  if (status.checking) next = t("shell.connection.checking");
  else if (status.nextCheckAt !== undefined)
    next = t("shell.connection.nextCheck").replace("{seconds}", String(Math.max(0, Math.ceil((status.nextCheckAt - now) / 1000))));
  else if (status.paused === true) next = t("shell.connection.paused");
  else next = t("shell.connection.gaveUp");
  return { failed, kept: t("shell.connection.kept"), next };
}

/** What a screen reader was last told about the connection, and at which point of it. */
export interface ConnectionAnnouncement {
  phase: "none" | "offline" | "gaveUp";
  text: string;
}

export const NO_CONNECTION_ANNOUNCEMENT: ConnectionAnnouncement = { phase: "none", text: "" };

/**
 * What the polite live region says after `status`, given what it said before.
 *
 * It speaks twice at most for one outage: once when the page goes offline (what failed, and that the writing is kept)
 * and once when the automatic checks give up. Nothing else changes the text — not the countdown, not a check starting
 * or failing again, not the checks resuming once the page is shown — so a screen reader is not read the same news
 * every few seconds. Returns `previous` itself when nothing changes, so a caller can compare by identity.
 */
export function nextConnectionAnnouncement(
  previous: ConnectionAnnouncement,
  status: ConnectionStatus,
  t: (key: MessageKey) => string,
): ConnectionAnnouncement {
  if (status.state !== "offline" || status.failure === undefined) {
    // The header's own live region says the node is back; this one goes quiet so the next outage is news again.
    return status.state === "ready" && previous.phase !== "none" ? NO_CONNECTION_ANNOUNCEMENT : previous;
  }
  if (status.gaveUp === true) {
    return previous.phase === "gaveUp" ? previous : { phase: "gaveUp", text: t("shell.connection.gaveUp") };
  }
  if (previous.phase === "none") {
    return { phase: "offline", text: `${failureText(status.failure, t)} ${t("shell.connection.kept")}` };
  }
  // A check in flight keeps the phase it started from, so a "Try now" after giving up that fails again stays silent.
  // Automatic checks resuming after giving up only move the phase back, keeping the text and so saying nothing.
  if (status.checking || previous.phase === "offline") return previous;
  return { phase: "offline", text: previous.text };
}

/**
 * Why the header says the node is disconnected, and a way to check now.
 *
 * The visible notice is deliberately outside every live region: a countdown read aloud every second would be noise.
 * A screen reader hears the outage through the visually hidden region instead (see `nextConnectionAnnouncement`).
 * The countdown is the real timer of the next check, not an animation.
 *
 * `onFocusLost` is called when the notice goes away while keyboard focus was inside it — the node answered "Try now" —
 * so the owner can put focus somewhere meaningful instead of leaving it on the document body.
 */
export function ConnectionNotice({
  status,
  onCheckNow,
  onFocusLost,
}: {
  status: ConnectionStatus;
  onCheckNow: () => void;
  onFocusLost?: () => void;
}): ReactElement {
  const t = useT();
  const [announcement, setAnnouncement] = useState(NO_CONNECTION_ANNOUNCEMENT);
  const announced = nextConnectionAnnouncement(announcement, status, t);
  if (announced !== announcement) setAnnouncement(announced);

  const [now, setNow] = useState(() => Date.now());
  const counting = status.state === "offline" && !status.checking && status.nextCheckAt !== undefined;
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [counting, status.nextCheckAt]);

  const text = connectionNoticeText(status, now, t);
  return (
    <>
      <div className="cc-sr-only" role="status" aria-live="polite" aria-atomic="true" data-connection-announcement="true">
        {announced.text}
      </div>
      {text !== undefined && status.failure !== undefined && (
        <ConnectionNoticeBody
          text={text}
          kind={status.failure.kind}
          checking={status.checking}
          onCheckNow={onCheckNow}
          {...(onFocusLost === undefined ? {} : { onFocusLost })}
        />
      )}
    </>
  );
}

function ConnectionNoticeBody({
  text,
  kind,
  checking,
  onCheckNow,
  onFocusLost,
}: {
  text: { failed: string; kept: string; next: string };
  kind: ConnectionFailure["kind"];
  checking: boolean;
  onCheckNow: () => void;
  onFocusLost?: () => void;
}): ReactElement {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const focusLost = useRef(onFocusLost);
  useLayoutEffect(() => {
    focusLost.current = onFocusLost;
  }, [onFocusLost]);
  useLayoutEffect(() => {
    const element = box.current;
    return () => {
      // A layout cleanup runs before React takes the notice out of the document, so focus is still where it was.
      if (element === null) return;
      const doc = element.ownerDocument;
      if (!element.contains(doc.activeElement)) return;
      // Hand focus over once the commit is done, and only if nothing else took it in the meantime.
      queueMicrotask(() => {
        if (doc.activeElement === null || doc.activeElement === doc.body) focusLost.current?.();
      });
    };
  }, []);

  return (
    <div className="cc-connection-notice" data-connection-notice={kind} ref={box}>
      <p>
        {text.failed} {text.kept} <span data-connection-next="true">{text.next}</span>
      </p>
      {/* aria-disabled, not disabled: a disabled button drops keyboard focus to the body mid-check. A press during a
          check is ignored by the watch, which never runs two checks at once. */}
      <button type="button" className="cc-action" data-connection-check="true" aria-disabled={checking} onClick={onCheckNow}>
        {t("shell.connection.checkNow")}
      </button>
    </div>
  );
}
