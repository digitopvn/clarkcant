import { type ReactElement, useEffect, useRef, useState } from "react";

import { WIDGET_DEV_DIAGNOSTIC_CODES, widgetDevRootRefusedCode, type WidgetDevSessionView } from "@clarkcant/contracts";

import type { WidgetDevSessionRead } from "./api.ts";
import { useT } from "./i18n/locale-context.tsx";
import type { MessageKey } from "./i18n/messages.ts";
import { nodeViewRefusalText } from "./node-view-refusal.ts";

/**
 * Host chrome beside a widget frame that runs a widget dev session's build: which build is on screen, and, when it is
 * not the newest one, why — a failed build, a build waiting for the person, or one the policy refused.
 *
 * Drawn by the host, outside the frame, so the widget cannot hide or forge it. It says "last successful build" exactly
 * when the node says the conversation shows older code than the folder holds (`showingLastKnownGood`), never as a
 * guess from timing.
 *
 * It also follows the session: when the node starts running another generation, `onRunningChange` asks the surface to
 * re-read, and the surface remounts only the frame, because only the frame's document changed.
 */

/** How often a live session is re-read while its frame is on screen. */
export const WIDGET_DEV_POLL_MS = 1_500;
/** How often a stopped session is re-read: it changes only when somebody starts it again. */
const STOPPED_POLL_MS = 10_000;
/** How long to wait after a read failed before trying again. */
const RETRY_MS = 5_000;

type Translate = (key: MessageKey) => string;

const fill = (text: string, values: Record<string, string | number>): string =>
  Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, String(value)), text);

/** Refusal codes the node uses for a session's builds, each said in the person's language. */
const REFUSAL_CODES = [
  "APPROVAL_DENIED",
  "APPROVAL_EXPIRED",
  "POLICY_REFUSED",
  "PACKAGE_LISTED",
  "PACKAGE_IN_OTHER_SESSION",
  "PACKAGE_INSTALLED_OTHERWISE",
  "INSTALL_NOT_ACTIVE",
] as const;

/**
 * Why a build was not run, in the person's language. The node's own message is English, so a code this surface knows is
 * said from its catalogue, and any other is named by its code rather than shown as English inside a translated line.
 */
export function widgetDevRefusalReason(code: string, t: Translate): string {
  const known = REFUSAL_CODES.find((candidate) => candidate === code);
  return known === undefined ? fill(t("shell.dev.reason.other"), { code }) : t(`shell.dev.reason.${known}`);
}

/** A problem the host found in a build (it carries a code), in the person's language; the package's own words as they are. */
export function widgetDevDiagnosticText(diagnostic: { code?: string | undefined; message: string }, t: Translate): string {
  const known = WIDGET_DEV_DIAGNOSTIC_CODES.find((candidate) => candidate === diagnostic.code);
  return known === undefined ? diagnostic.message : t(`shell.dev.diagnostic.${known}`);
}

/**
 * What the status reads of a session: everything but where its folder is and where it is placed, which the status never
 * shows. A detached window is given exactly this (the desktop host drops the folder path), and the conversation's full
 * read satisfies it too.
 */
export type WidgetDevStatusView = Omit<WidgetDevSessionRead, "root" | "placed">;

/** The one line the status says, and whether it is a notice (something is not current) rather than plain status. */
export function widgetDevStatusLine(view: Omit<WidgetDevSessionView, "root" | "placed">, t: Translate): { text: string; notice: boolean } {
  const running = view.running?.generation;
  const latest = view.latest?.generation ?? running ?? 0;
  if (view.status === "stopped") {
    const base = running === undefined ? t("shell.dev.stoppedNothing") : fill(t("shell.dev.stopped"), { generation: running });
    // A folder refused at a restart says which check refused it, since that decides whether choosing it again helps.
    const refusedCode = widgetDevRootRefusedCode(view);
    const reason =
      view.stopReason === undefined || view.stopReason === "requested"
        ? undefined
        : refusedCode === undefined
          ? t(`shell.dev.stopReason.${view.stopReason}`)
          : t(`shell.dev.stopReason.root-refused.${refusedCode}`);
    return reason === undefined ? { text: base, notice: false } : { text: `${base} ${reason}`, notice: true };
  }
  const shown = running ?? "—";
  if (view.lastBuild?.ok === false) {
    return { text: running === undefined ? t("shell.dev.failedNothing") : fill(t("shell.dev.failed"), { generation: running }), notice: true };
  }
  if (view.activation.state === "awaiting-approval") {
    return { text: fill(t("shell.dev.awaiting"), { latest: view.activation.generation, generation: shown }), notice: true };
  }
  if (view.activation.state === "refused") {
    const reason = widgetDevRefusalReason(view.activation.code, t);
    return { text: fill(t("shell.dev.refused"), { latest: view.activation.generation, reason, generation: shown }), notice: true };
  }
  return { text: fill(t("shell.dev.current"), { generation: running ?? latest }), notice: running !== undefined && view.showingLastKnownGood };
}

export interface WidgetDevStatusProps {
  /** The conversation's client, or a detached window's relay that answers the same view without the folder path. */
  client: { widgetDevSession: (sessionId: string) => Promise<WidgetDevStatusView> };
  sessionId: string;
  /** Told when the node runs another generation of the session, so the surface re-reads and remounts the frame. */
  onRunningChange: () => void;
}

/**
 * What the line says when the session's status could not be read. A view this app does not read names which Clark each
 * side runs; anything else is the node not answering. The widget keeps running what it shows either way.
 */
export function widgetDevUnreachableText(cause: unknown, t: Translate): string {
  return nodeViewRefusalText(cause, t, "shell.dev.viewUnreadable") ?? t("shell.dev.unreachable");
}

export function WidgetDevStatus({ client, sessionId, onRunningChange }: WidgetDevStatusProps): ReactElement | null {
  const t = useT();
  const [view, setView] = useState<WidgetDevStatusView | undefined>(undefined);
  // Why the status is not known, as the sentence the line shows; undefined while it is.
  const [unreachable, setUnreachable] = useState<string | undefined>(undefined);
  const seenRunning = useRef<string | undefined>(undefined);
  const changed = useRef(onRunningChange);
  // Read when a poll fails, in the language the person has then, without restarting the polling when it changes.
  const words = useRef(t);
  words.current = t;
  changed.current = onRunningChange;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const next = await client.widgetDevSession(sessionId);
        if (cancelled) return;
        setView(next);
        setUnreachable(undefined);
        const running = next.running?.digest;
        if (running !== undefined && seenRunning.current !== undefined && running !== seenRunning.current) changed.current();
        if (running !== undefined) seenRunning.current = running;
        timer = setTimeout(() => void read(), next.status === "live" ? WIDGET_DEV_POLL_MS : STOPPED_POLL_MS);
      } catch (cause) {
        if (cancelled) return;
        // The widget keeps running what it shows; only the status is unknown, and said so. A view this app does not read
        // says which version is newer instead of only that it could not be read.
        setUnreachable(widgetDevUnreachableText(cause, words.current));
        timer = setTimeout(() => void read(), RETRY_MS);
      }
    };
    void read();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, sessionId]);

  if (unreachable !== undefined) {
    return (
      <p className="cc-freshness" role="status" data-widget-dev-status="unreachable" style={{ margin: 0 }}>
        {unreachable}
      </p>
    );
  }
  if (view === undefined) return null;
  return <WidgetDevStatusReport view={view} />;
}

/** What the status says for one read of the session: drawn from the view alone, so it can be checked without a node. */
export function WidgetDevStatusReport({ view }: { view: WidgetDevStatusView }): ReactElement {
  const t = useT();
  const line = widgetDevStatusLine(view, t);
  const problems = view.lastBuild?.ok === false ? view.lastBuild.diagnostics : [];
  const more = view.lastBuild?.ok === false ? (view.lastBuild.diagnosticsMore ?? 0) : 0;
  const wider = view.running?.delta.verdict === "wider";
  return (
    <div
      className="cc-freshness"
      role="status"
      aria-live="polite"
      data-widget-dev-status={view.status}
      data-widget-dev-generation={view.running?.generation ?? ""}
      data-showing-last-good={view.showingLastKnownGood ? "true" : "false"}
      data-live-notice={line.notice || view.unreadFields !== undefined ? "true" : undefined}
    >
      <p style={{ margin: 0 }}>{line.text}</p>
      {/* A newer node sent more than this app reads: said, so the line is never taken for the whole session. */}
      {view.unreadFields !== undefined && (
        <p style={{ margin: 0 }} data-widget-dev-node-newer={String(view.unreadFields.count)}>
          {t("shell.dev.nodeNewer")}
        </p>
      )}
      {wider && <p style={{ margin: 0 }} data-widget-dev-wider="true">{t("shell.dev.wider")}</p>}
      {problems.length > 0 && (
        <details data-widget-dev-problems="true">
          <summary>{fill(t("shell.dev.problems"), { count: problems.length + more })}</summary>
          <ul style={{ margin: 0, paddingInlineStart: "var(--cc-space-md)" }}>
            {problems.map((problem, index) => (
              // The package's own words, shown as text: never markup.
              <li key={`${String(index)}:${problem.path ?? ""}`}>
                {problem.path === undefined ? "" : <code>{problem.path}</code>}
                {problem.path === undefined ? "" : ": "}
                {widgetDevDiagnosticText(problem, t)}
              </li>
            ))}
            {more > 0 && <li>{fill(t("shell.dev.more"), { count: more })}</li>}
          </ul>
        </details>
      )}
    </div>
  );
}
