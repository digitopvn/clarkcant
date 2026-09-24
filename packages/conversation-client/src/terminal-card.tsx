import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";

import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";

import type { GatewayClient } from "./api.ts";
import type { MessageKey } from "./i18n/messages.ts";
import {
  type PiSessionSummaryView,
  type TerminalCommandView,
  type TerminalConnection,
  type TerminalInfoView,
  type TerminalOverview,
  type TerminalServerFrame,
  chooseShare,
  formatShare,
  renderPiEntry,
} from "./terminal-socket.ts";

/**
 * The terminal card: a real shell on the node, drawn with xterm.js, inside the conversation.
 *
 * Host-owned rather than a widget, because a shell is the most privileged thing a node has: the keystrokes go to a
 * process with the person's own rights, so the component that carries them is the host's, never third-party code.
 *
 * Three things it deliberately does not do:
 * - it never holds the token: the socket comes from the client, which authenticates it itself;
 * - it never types for the agent: an agent command reaches the shell through `terminal_run` and its policy check,
 *   and this card only shows what happened;
 * - it never calls a read-only snapshot live: without a client and a share action (a transcript, a search result)
 *   it draws what the card recorded and says it is a record.
 *
 * Escape belongs to the shell — vim, less and every TUI need it — so the way out of the terminal by keyboard is F6,
 * and the card says so beside the screen.
 */

export interface TerminalCardActions {
  onTerminalShare?: (input: { text: string }) => void;
}

type Viewing = { kind: "own" } | { kind: "terminal"; terminalId: string; title: string } | { kind: "session"; ref: string; title: string };

type Phase =
  | { kind: "loading" }
  | { kind: "connecting" }
  | { kind: "attached" }
  | { kind: "gone" }
  | { kind: "disconnected"; reason: string }
  | { kind: "load-failed"; reason: string };

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** The terminal's colours, read from the theme tokens so a shell looks like part of the product in both themes. */
function themeFromTokens(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === "" ? fallback : value;
  };
  const background = token("--cc-code", "#111418");
  const foreground = token("--cc-text", "#e6e6e6");
  return {
    background,
    foreground,
    cursor: token("--cc-focus", foreground),
    cursorAccent: background,
    selectionBackground: `${token("--cc-focus", "#6aa0ff")}55`,
    red: token("--cc-danger", "#e5484d"),
    green: token("--cc-success", "#46a758"),
    yellow: token("--cc-warning", "#f5a524"),
  };
}

function screenText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < term.rows; row += 1) {
    lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  }
  return lines.join("\n").replace(/\s+$/u, "");
}

function mergeCommand(commands: readonly TerminalCommandView[], record: TerminalCommandView): TerminalCommandView[] {
  const next = commands.filter((existing) => existing.id !== record.id);
  next.push(record);
  return next.slice(-20);
}

function timeOf(iso: string): string {
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

export function TerminalCardBlock({
  block,
  client,
  actions,
  t,
}: {
  block: Record<string, unknown>;
  client?: GatewayClient | undefined;
  actions?: TerminalCardActions;
  t: (key: MessageKey) => string;
}): ReactElement | null {
  if (block.owner !== "host") return null;
  const terminalId = text(block.terminalId);
  const title = text(block.title, "terminal");
  const cwd = text(block.cwd);
  const prefill = typeof block.prefill === "string" ? block.prefill : undefined;
  const ran = typeof block.ran === "string" ? block.ran : undefined;
  const share = actions?.onTerminalShare;

  if (client === undefined || share === undefined || terminalId === "") {
    return (
      <section className="cc-card cc-terminal" data-host-card="terminal-session" data-owner="host" data-terminal-mode="snapshot" aria-label={t("blocks.terminal.aria").replace("{title}", title)}>
        <header className="cc-card-head">
          <span className="cc-card-title">{title}</span>
          <code className="cc-terminal-cwd">{cwd}</code>
        </header>
        <div className="cc-card-body">
          {ran === undefined ? null : (
            <p className="cc-terminal-line">
              <span className="cc-terminal-label">{t("blocks.terminal.ran")}</span> <code>{ran}</code>
            </p>
          )}
          {prefill === undefined ? null : (
            <p className="cc-terminal-line">
              <span className="cc-terminal-label">{t("blocks.terminal.prefilled")}</span> <code>{prefill}</code>
            </p>
          )}
          <p className="cc-freshness" data-terminal-notice="snapshot">
            {t("blocks.terminal.snapshot")}
          </p>
        </div>
      </section>
    );
  }

  return <LiveTerminal terminalId={terminalId} title={title} cwd={cwd} client={client} share={share} t={t} />;
}

function LiveTerminal({
  terminalId,
  title,
  cwd,
  client,
  share,
  t,
}: {
  terminalId: string;
  title: string;
  cwd: string;
  client: GatewayClient;
  share: (input: { text: string }) => void;
  t: (key: MessageKey) => string;
}): ReactElement {
  const screenRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const driverRef = useRef(false);
  const viewingRef = useRef<Viewing>({ kind: "own" });
  const shareButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelToggleRef = useRef<HTMLButtonElement | null>(null);

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [info, setInfo] = useState<TerminalInfoView | undefined>(undefined);
  const [driver, setDriver] = useState(false);
  const [commands, setCommands] = useState<TerminalCommandView[]>([]);
  const [selection, setSelection] = useState("");
  const [viewing, setViewing] = useState<Viewing>({ kind: "own" });
  const [expanded, setExpanded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [killing, setKilling] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  driverRef.current = driver;
  viewingRef.current = viewing;
  // Read through a ref so a locale change re-labels the card without reconnecting the shell.
  const tRef = useRef(t);
  tRef.current = t;

  const size = useCallback((): { cols: number; rows: number } => {
    const term = termRef.current;
    return { cols: term?.cols ?? 80, rows: term?.rows ?? 24 };
  }, []);

  const attach = useCallback(
    (target: Viewing) => {
      const connection = connectionRef.current;
      const term = termRef.current;
      if (connection === null || term === null) return;
      setViewing(target);
      viewingRef.current = target;
      setDriver(false);
      driverRef.current = false;
      setNotice(undefined);
      term.reset();
      if (target.kind === "session") {
        term.options.disableStdin = true;
        connection.send({ type: "watch-session", ref: target.ref });
        return;
      }
      term.options.disableStdin = false;
      fitRef.current?.fit();
      connection.send({ type: "attach", terminalId: target.kind === "own" ? terminalId : target.terminalId, ...size() });
    },
    [size, terminalId],
  );

  useEffect(() => {
    const element = screenRef.current;
    if (element === null) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    setPhase({ kind: "loading" });

    void (async () => {
      let modules: [typeof import("@xterm/xterm"), typeof import("@xterm/addon-fit")];
      try {
        modules = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      } catch (error) {
        if (!disposed) setPhase({ kind: "load-failed", reason: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (disposed) return;
      const [{ Terminal: TerminalClass }, { FitAddon: FitClass }] = modules;
      const term = new TerminalClass({
        cursorBlink: false,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 5_000,
        theme: themeFromTokens(element),
        screenReaderMode: false,
        allowProposedApi: false,
      });
      const fit = new FitClass();
      term.loadAddon(fit);
      term.open(element);
      termRef.current = term;
      fitRef.current = fit;
      try {
        fit.fit();
      } catch {
        // A card that is not laid out yet has no size; the resize observer fits it once it has one.
      }

      // F6 leaves the terminal; every other key, Escape included, belongs to the shell.
      term.attachCustomKeyEventHandler((event) => {
        if (event.key === "F6" && event.type === "keydown") {
          event.preventDefault();
          shareButtonRef.current?.focus();
          return false;
        }
        return true;
      });
      term.onData((data) => {
        if (viewingRef.current.kind === "session" || !driverRef.current) return;
        connectionRef.current?.send({ type: "input", data });
      });
      term.onSelectionChange(() => setSelection(term.getSelection()));

      observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          return;
        }
        if (driverRef.current && viewingRef.current.kind !== "session") {
          connectionRef.current?.send({ type: "resize", cols: term.cols, rows: term.rows });
        }
      });
      observer.observe(element);

      const onFrame = (frame: TerminalServerFrame): void => {
        if (disposed) return;
        switch (frame.type) {
          case "ready":
            return;
          case "attached":
            term.reset();
            term.write(frame.replay);
            setInfo(frame.info);
            setDriver(frame.driver);
            driverRef.current = frame.driver;
            if (!frame.driver) term.resize(frame.info.cols, frame.info.rows);
            setCommands(frame.commands);
            setPhase({ kind: "attached" });
            return;
          case "output":
            term.write(frame.data);
            return;
          case "command":
            setCommands((current) => mergeCommand(current, frame.record));
            setInfo((current) =>
              current === undefined
                ? current
                : {
                    ...current,
                    running:
                      frame.phase === "started" ? { command: frame.record.command, startedAt: frame.record.startedAt } : null,
                  },
            );
            return;
          case "exit":
            setInfo((current) => (current === undefined ? current : { ...current, status: "exited", exitCode: frame.exitCode, running: null }));
            setDriver(false);
            driverRef.current = false;
            setKilling(false);
            return;
          case "driver":
            setDriver(frame.driver);
            driverRef.current = frame.driver;
            if (frame.driver) {
              try {
                fit.fit();
              } catch {
                // Fitted by the observer once the card has a size.
              }
              connectionRef.current?.send({ type: "resize", cols: term.cols, rows: term.rows });
            }
            return;
          case "size":
            if (!driverRef.current) term.resize(frame.cols, frame.rows);
            return;
          case "session-start":
            term.reset();
            term.write(`\u001b[2m${frame.summary.cwd ?? ""}\u001b[0m\r\n`);
            setPhase({ kind: "attached" });
            return;
          case "session-entries":
            if (frame.initial && frame.entries.length === 0) term.write(`${tRef.current("blocks.terminal.sessionEmpty")}\r\n`);
            for (const entry of frame.entries) term.write(renderPiEntry(entry));
            return;
          case "error":
            if (frame.code === "TERMINAL_GONE") {
              if (viewingRef.current.kind === "own") setPhase({ kind: "gone" });
              else setNotice(frame.message);
              return;
            }
            setNotice(frame.message);
            return;
        }
      };

      let connection: TerminalConnection;
      try {
        connection = client.openTerminalSocket({
          onFrame,
          onClose: (reason) => {
            if (!disposed) setPhase({ kind: "disconnected", reason });
          },
        });
      } catch (error) {
        setPhase({ kind: "disconnected", reason: error instanceof Error ? error.message : String(error) });
        return;
      }
      connectionRef.current = connection;
      setPhase({ kind: "connecting" });
      const target = viewingRef.current;
      if (target.kind === "session") {
        term.options.disableStdin = true;
        connection.send({ type: "watch-session", ref: target.ref });
      } else {
        connection.send({ type: "attach", terminalId: target.kind === "own" ? terminalId : target.terminalId, cols: term.cols, rows: term.rows });
      }
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      connectionRef.current?.close();
      connectionRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [client, terminalId, attempt]);

  // The expanded height is a new size for the shell as well as for the card.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (term === null || fit === null) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    if (driverRef.current && viewingRef.current.kind !== "session") {
      connectionRef.current?.send({ type: "resize", cols: term.cols, rows: term.rows });
    }
  }, [expanded]);

  const own = viewing.kind === "own";
  const inSession = viewing.kind === "session";
  const exited = info?.status === "exited";
  const runningCommand = info?.running ?? null;
  const live = phase.kind === "attached";

  const choice = chooseShare({
    selection,
    commands: inSession ? [] : commands,
    screen: live && termRef.current !== null ? "screen" : "",
  });
  const shareLabel =
    choice.kind === "selection"
      ? t("blocks.terminal.shareSelection")
      : choice.kind === "command"
        ? t("blocks.terminal.shareCommand")
        : choice.kind === "screen"
          ? t("blocks.terminal.shareScreen")
          : t("blocks.terminal.shareNothing");

  const onShare = (): void => {
    const term = termRef.current;
    if (term === null) return;
    const decided = chooseShare({ selection: term.getSelection(), commands: inSession ? [] : commands, screen: screenText(term) });
    const shownTitle = viewing.kind === "own" ? title : viewing.title;
    const shownCwd = viewing.kind === "own" ? cwd : viewing.kind === "terminal" ? (info?.cwd ?? "") : "";
    const message = formatShare(decided, { title: shownTitle, cwd: shownCwd });
    if (message !== "") share({ text: message });
  };

  const onTake = (): void => {
    const term = termRef.current;
    if (term === null) return;
    try {
      fitRef.current?.fit();
    } catch {
      // Sent with the size it has.
    }
    connectionRef.current?.send({ type: "take", cols: term.cols, rows: term.rows });
    term.focus();
  };

  const onKill = (): void => {
    const target = viewing.kind === "terminal" ? viewing.terminalId : terminalId;
    setKilling(true);
    client.killTerminal(target).catch((error: unknown) => {
      setKilling(false);
      setNotice(error instanceof Error ? error.message : String(error));
    });
  };

  const closePanel = (): void => {
    setPanelOpen(false);
    panelToggleRef.current?.focus();
  };

  const statusBadge = exited
    ? { tone: "", label: t("blocks.terminal.exited") }
    : runningCommand !== null
      ? { tone: "warn", label: t("blocks.terminal.running") }
      : { tone: "ok", label: t("blocks.terminal.idle") };

  const exitNote = t("blocks.terminal.exitedNotice").replace(
    "{code}",
    info?.exitCode === null || info?.exitCode === undefined ? "" : t("blocks.terminal.exitCode").replace("{code}", String(info.exitCode)),
  );

  return (
    <section
      className="cc-card cc-terminal"
      data-host-card="terminal-session"
      data-owner="host"
      data-terminal-mode="live"
      data-terminal-id={terminalId}
      data-terminal-phase={phase.kind}
      data-terminal-driver={driver ? "true" : "false"}
      data-terminal-viewing={viewing.kind}
      data-terminal-status={info?.status ?? "unknown"}
      data-expanded={expanded ? "true" : "false"}
      aria-label={t("blocks.terminal.aria").replace("{title}", title)}
    >
      <header className="cc-card-head">
        <span className="cc-terminal-heading">
          <span className="cc-card-title">{own ? title : viewing.title}</span>
          <code className="cc-terminal-cwd">{inSession ? "" : own ? cwd : (info?.cwd ?? "")}</code>
        </span>
        {inSession || !live ? null : (
          <span className="cc-badge" data-tone={statusBadge.tone} data-terminal-badge="true">
            {statusBadge.label}
          </span>
        )}
      </header>

      {own ? null : (
        <p className="cc-terminal-viewing" data-terminal-viewing-notice="true">
          <span>
            {viewing.kind === "session"
              ? t("blocks.terminal.viewingSession").replace("{title}", viewing.title)
              : t("blocks.terminal.viewing").replace("{title}", viewing.title)}
          </span>
          <button type="button" className="cc-chip" data-terminal-back="true" onClick={() => attach({ kind: "own" })}>
            {t("blocks.terminal.backToOwn")}
          </button>
        </p>
      )}

      <div className="cc-terminal-frame">
        <div ref={screenRef} className="cc-terminal-screen" data-terminal-screen="true" />
        {phase.kind === "loading" || phase.kind === "connecting" ? (
          <p className="cc-terminal-overlay" role="status" data-terminal-overlay={phase.kind}>
            {phase.kind === "loading" ? t("blocks.terminal.loading") : t("blocks.terminal.connecting")}
          </p>
        ) : null}
      </div>

      <div className="cc-terminal-status" aria-live="polite">
        {phase.kind === "gone" ? (
          <p className="cc-freshness" data-terminal-notice="gone">{t("blocks.terminal.gone")}</p>
        ) : phase.kind === "load-failed" ? (
          <p className="cc-freshness" data-terminal-notice="load-failed">{t("blocks.terminal.loadFailed").replace("{reason}", phase.reason)}</p>
        ) : phase.kind === "disconnected" ? (
          <p className="cc-freshness" data-terminal-notice="disconnected">
            {t("blocks.terminal.disconnected").replace("{reason}", phase.reason)}{" "}
            <button type="button" className="cc-chip" data-terminal-reconnect="true" onClick={() => setAttempt((value) => value + 1)}>
              {t("blocks.terminal.reconnect")}
            </button>
          </p>
        ) : live && exited && !inSession ? (
          <p className="cc-freshness" data-terminal-notice="exited">{exitNote}</p>
        ) : live && inSession ? (
          <p className="cc-freshness" data-terminal-notice="session">{t("blocks.terminal.sessionLimit")}</p>
        ) : live && !driver ? (
          <p className="cc-freshness" data-terminal-notice="observer">{t("blocks.terminal.observer")}</p>
        ) : live && runningCommand !== null ? (
          <p className="cc-freshness" data-terminal-notice="running">
            {t("blocks.terminal.runningCommand").replace("{command}", runningCommand.command ?? "…")}
          </p>
        ) : null}
        {notice === undefined ? null : (
          <p className="cc-freshness" data-terminal-error="true">{notice}</p>
        )}
      </div>

      <div className="cc-chip-row cc-terminal-actions">
        {live && !driver && !exited && !inSession ? (
          <button type="button" className="cc-chip" data-terminal-take="true" onClick={onTake}>
            {t("blocks.terminal.takeControl")}
          </button>
        ) : null}
        <button
          ref={shareButtonRef}
          type="button"
          className="cc-chip"
          data-terminal-share={choice.kind}
          disabled={!live || choice.kind === "nothing"}
          onClick={onShare}
        >
          {shareLabel}
        </button>
        <button
          type="button"
          className="cc-chip"
          data-terminal-expand="true"
          aria-pressed={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("blocks.terminal.collapse") : t("blocks.terminal.expand")}
        </button>
        <button
          ref={panelToggleRef}
          type="button"
          className="cc-chip"
          data-terminal-processes="true"
          aria-expanded={panelOpen}
          aria-controls={`cc-terminal-panel-${terminalId}`}
          onClick={() => setPanelOpen((value) => !value)}
        >
          {t("blocks.terminal.processes")}
        </button>
        {live && !exited && !inSession ? (
          <button type="button" className="cc-chip" data-terminal-kill="true" disabled={killing} onClick={onKill}>
            {killing ? t("blocks.terminal.killing") : t("blocks.terminal.kill")}
          </button>
        ) : null}
        <span className="cc-terminal-hint">{t("blocks.terminal.focusHint")}</span>
      </div>

      {panelOpen ? (
        <ProcessPanel
          id={`cc-terminal-panel-${terminalId}`}
          client={client}
          ownTerminalId={terminalId}
          viewing={viewing}
          t={t}
          onClose={closePanel}
          onViewTerminal={(target) => attach(target.terminalId === terminalId ? { kind: "own" } : { kind: "terminal", terminalId: target.terminalId, title: target.title })}
          onWatchSession={(session: PiSessionSummaryView) => attach({ kind: "session", ref: session.ref, title: session.title })}
        />
      ) : null}
    </section>
  );
}

/**
 * Everything running on the node, refreshed while the panel is open.
 *
 * A `run_command` process and a background task are listed with their status only: neither has a stream this node
 * keeps, and a "view" button beside them would be a control with nothing behind it.
 */
function ProcessPanel({
  id,
  client,
  ownTerminalId,
  viewing,
  t,
  onClose,
  onViewTerminal,
  onWatchSession,
}: {
  id: string;
  client: GatewayClient;
  ownTerminalId: string;
  viewing: Viewing;
  t: (key: MessageKey) => string;
  onClose: () => void;
  onViewTerminal: (target: { terminalId: string; title: string }) => void;
  onWatchSession: (session: PiSessionSummaryView) => void;
}): ReactElement {
  const [overview, setOverview] = useState<TerminalOverview | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = (): void => {
      client
        .terminals()
        .then((value) => {
          if (stopped) return;
          setOverview(value);
          setError(undefined);
        })
        .catch((reason: unknown) => {
          if (!stopped) setError(reason instanceof Error ? reason.message : String(reason));
        });
    };
    load();
    const timer = setInterval(load, 3_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  const viewedTerminal = viewing.kind === "own" ? ownTerminalId : viewing.kind === "terminal" ? viewing.terminalId : undefined;
  const viewedSession = viewing.kind === "session" ? viewing.ref : undefined;

  return (
    <div id={id} className="cc-terminal-panel" role="region" aria-label={t("blocks.terminal.panelTitle")} data-terminal-panel="true" onKeyDown={onKeyDown}>
      <div className="cc-terminal-panel-head">
        <h3 ref={headingRef} tabIndex={-1}>
          {t("blocks.terminal.panelTitle")}
        </h3>
        <button type="button" className="cc-chip" data-terminal-panel-close="true" onClick={onClose}>
          {t("blocks.terminal.panelClose")}
        </button>
      </div>
      {error !== undefined ? (
        <p className="cc-freshness" data-terminal-panel-error="true">{t("blocks.terminal.panelError").replace("{reason}", error)}</p>
      ) : null}
      {overview === undefined ? (
        error === undefined ? <p className="cc-freshness" role="status">{t("blocks.terminal.panelLoading")}</p> : null
      ) : (
        <>
          <PanelSection title={t("blocks.terminal.panelTerminals")} empty={overview.terminals.length === 0} t={t}>
            {overview.terminals.map((terminal) => (
              <li key={terminal.terminalId} data-panel-terminal={terminal.terminalId}>
                <span className="cc-terminal-panel-main">
                  <strong>{terminal.title}</strong>
                  {terminal.terminalId === ownTerminalId ? <span className="cc-terminal-panel-meta"> · {t("blocks.terminal.panelThis")}</span> : null}
                  <code className="cc-terminal-panel-meta">{terminal.cwd}</code>
                  <span className="cc-terminal-panel-meta">
                    {terminal.status === "exited"
                      ? t("blocks.terminal.exited")
                      : terminal.running === null
                        ? t("blocks.terminal.idle")
                        : t("blocks.terminal.runningCommand").replace("{command}", terminal.running.command ?? "…")}
                  </span>
                </span>
                <button
                  type="button"
                  className="cc-chip"
                  data-panel-view={terminal.terminalId}
                  disabled={viewedTerminal === terminal.terminalId}
                  onClick={() => onViewTerminal({ terminalId: terminal.terminalId, title: terminal.title })}
                >
                  {t("blocks.terminal.panelView")}
                </button>
              </li>
            ))}
          </PanelSection>
          <PanelSection title={t("blocks.terminal.panelCommands")} empty={overview.commands.length === 0} t={t}>
            {overview.commands.map((command, index) => (
              <li key={`${command.startedAt}-${String(index)}`}>
                <span className="cc-terminal-panel-main">
                  <code>{command.command}</code>
                  <span className="cc-terminal-panel-meta">
                    {command.cwd} · {t("blocks.terminal.panelSince").replace("{at}", timeOf(command.startedAt))}
                  </span>
                  <span className="cc-terminal-panel-meta">{t("blocks.terminal.panelNoStream")}</span>
                </span>
              </li>
            ))}
          </PanelSection>
          <PanelSection title={t("blocks.terminal.panelBackground")} empty={overview.background.length === 0} t={t}>
            {overview.background.map((task) => (
              <li key={task.sessionId}>
                <span className="cc-terminal-panel-main">
                  <strong>{task.title}</strong>
                  <span className="cc-terminal-panel-meta">
                    {task.status} · {t("blocks.terminal.panelSince").replace("{at}", timeOf(task.startedAt))}
                  </span>
                </span>
              </li>
            ))}
          </PanelSection>
          <PanelSection title={t("blocks.terminal.panelPiSessions")} empty={overview.piSessions.length === 0} t={t}>
            {overview.piSessions.map((session) => (
              <li key={session.ref} data-panel-session={session.ref}>
                <span className="cc-terminal-panel-main">
                  <strong>{session.title}</strong>
                  {session.active ? <span className="cc-badge" data-tone="ok">{t("blocks.terminal.panelRecent")}</span> : null}
                  <span className="cc-terminal-panel-meta">
                    {session.source} · {session.cwd ?? ""} · {timeOf(session.updatedAt)}
                  </span>
                </span>
                <button
                  type="button"
                  className="cc-chip"
                  data-panel-watch={session.ref}
                  disabled={viewedSession === session.ref}
                  onClick={() => onWatchSession(session)}
                >
                  {t("blocks.terminal.panelWatch")}
                </button>
              </li>
            ))}
          </PanelSection>
        </>
      )}
    </div>
  );
}

function PanelSection({
  title,
  empty,
  t,
  children,
}: {
  title: string;
  empty: boolean;
  t: (key: MessageKey) => string;
  children: ReactElement[];
}): ReactElement {
  return (
    <section className="cc-terminal-panel-section">
      <h4>{title}</h4>
      {empty ? <p className="cc-terminal-panel-meta">{t("blocks.terminal.panelEmpty")}</p> : <ul>{children}</ul>}
    </section>
  );
}
