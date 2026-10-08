import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";

import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";

import type { SurfacePhase } from "@clarkcant/contracts";
import { monoFontStack } from "@clarkcant/design-tokens";

import type { GatewayClient } from "./api.ts";
import type { MessageKey } from "./i18n/messages.ts";
import { LiveNote, PhaseBadge } from "./surface-status.tsx";
import { subscribeToDocumentTheme } from "./theme.ts";
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
  /** Terminals opened by a message that arrived while the person was here (`BlockActions.freshTerminalIds`). */
  freshTerminalIds?: readonly string[];
}

type Viewing = { kind: "own" } | { kind: "terminal"; terminalId: string; title: string } | { kind: "session"; ref: string; title: string };

type Phase =
  | { kind: "loading" }
  | { kind: "connecting" }
  | { kind: "attached" }
  | { kind: "gone" }
  | { kind: "disconnected"; reason: string }
  | { kind: "load-failed"; reason: string };

/** What the shell itself is doing, as the badge names it: ended, running a command, or ready for one. */
export type TerminalShellState = "exited" | "running" | "idle";
export const TERMINAL_SHELL_PHASE: Record<TerminalShellState, SurfacePhase> = {
  // The shell ended; nothing failed because of it, and it will not come back.
  exited: "cancelled",
  // A command is work in progress, not a warning.
  running: "pending",
  idle: "success",
};

/** The line under the screen: why the terminal cannot be used, or what it is doing. */
export type TerminalNotice = "gone" | "load-failed" | "disconnected" | "exited" | "session" | "observer" | "running";
export const TERMINAL_NOTICE_PHASE: Record<TerminalNotice, SurfacePhase> = {
  gone: "unavailable",
  "load-failed": "error",
  // The view lost the shell; the shell may still run. Said at once, with Reconnect beside it.
  disconnected: "error",
  exited: "cancelled",
  session: "unavailable",
  observer: "unavailable",
  running: "pending",
};

/**
 * Which notice the terminal shows, from its machine. The connection comes first: a terminal that cannot be reached says
 * so before anything it last knew about the shell.
 */
export function terminalNotice(input: {
  phase: Phase["kind"];
  exited: boolean;
  inSession: boolean;
  driver: boolean;
  running: boolean;
}): TerminalNotice | undefined {
  if (input.phase === "gone" || input.phase === "load-failed" || input.phase === "disconnected") return input.phase;
  if (input.phase !== "attached") return undefined;
  if (input.exited && !input.inSession) return "exited";
  if (input.inSession) return "session";
  if (!input.driver) return "observer";
  return input.running ? "running" : undefined;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** The monospace stack Clark Default draws, used when the page has no `--cc-font-mono`: the one stack every surface uses. */
const MONO_FALLBACK = monoFontStack("clark");

/**
 * A colour at a third of its strength, for the selection.
 *
 * A six-digit hex takes an alpha suffix; a theme may give its colours in any CSS form, and `color-mix` is how those are
 * thinned without parsing them here.
 */
function translucent(colour: string): string {
  return /^#[0-9a-f]{6}$/i.test(colour) ? `${colour}55` : `color-mix(in srgb, ${colour} 33%, transparent)`;
}

/**
 * The terminal's colours and font, read from the theme tokens so a shell looks like part of the product in every theme.
 *
 * Exported for the test that proves a theme's tokens reach the shell.
 */
export function terminalAppearance(element: HTMLElement): { theme: ITheme; fontFamily: string } {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === "" ? fallback : value;
  };
  const background = token("--cc-code", "#111418");
  const foreground = token("--cc-text", "#e6e6e6");
  return {
    theme: {
      background,
      foreground,
      cursor: token("--cc-focus", foreground),
      cursorAccent: background,
      selectionBackground: translucent(token("--cc-focus", "#6aa0ff")),
      red: token("--cc-danger", "#e5484d"),
      green: token("--cc-success", "#46a758"),
      yellow: token("--cc-warning", "#f5a524"),
    },
    fontFamily: token("--cc-font-mono", MONO_FALLBACK),
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

  const fresh = actions?.freshTerminalIds?.includes(terminalId) === true;
  return <LiveTerminal terminalId={terminalId} title={title} cwd={cwd} client={client} share={share} fresh={fresh} t={t} />;
}

function LiveTerminal({
  terminalId,
  title,
  cwd,
  client,
  share,
  fresh,
  t,
}: {
  terminalId: string;
  title: string;
  cwd: string;
  client: GatewayClient;
  share: (input: { text: string }) => void;
  /** The person asked for this terminal while here, so the state it first settles on is news. */
  fresh: boolean;
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
  /**
   * For a card drawn again from history (a reload, a conversation opened again, a scroll back), true until it first
   * settles after it mounts: whatever the shell is in then — gone, exited, unreachable, the terminal code that failed to
   * load — was already true before this card was drawn, so it is shown and not announced. A terminal the person just
   * asked for (`fresh`) announces its first state too, a failure to load or connect included. Every later change is
   * announced, a load that fails after Reconnect included.
   */
  const [restoring, setRestoring] = useState(!fresh);
  const settling = phase.kind === "loading" || phase.kind === "connecting";
  useEffect(() => {
    if (!settling) setRestoring(false);
  }, [settling]);

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
    let stopFollowingTheme = (): void => {};
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
      const drawn = terminalAppearance(element);
      const term = new TerminalClass({
        cursorBlink: false,
        fontFamily: drawn.fontFamily,
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 5_000,
        theme: drawn.theme,
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
      /*
       * The shell is painted on a canvas, which the stylesheet cannot reach: a theme or light/dark change is followed
       * by reading the tokens again, so a terminal already open does not keep the previous look.
       */
      stopFollowingTheme = subscribeToDocumentTheme(() => {
        const next = terminalAppearance(element);
        term.options.theme = next.theme;
        if (term.options.fontFamily === next.fontFamily) return;
        term.options.fontFamily = next.fontFamily;
        try {
          fit.fit();
        } catch {
          // Fitted by the observer once the card has a size.
        }
      });

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
          case "replay":
            term.reset();
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
      stopFollowingTheme();
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
    // Cleared first, so a kill that fails again for the same reason is said again.
    setNotice(undefined);
    client.killTerminal(target).catch((error: unknown) => {
      setKilling(false);
      setNotice(error instanceof Error ? error.message : String(error));
    });
  };

  const closePanel = (): void => {
    setPanelOpen(false);
    panelToggleRef.current?.focus();
  };

  const shellState: TerminalShellState = exited ? "exited" : runningCommand !== null ? "running" : "idle";
  const shellLabel: Record<TerminalShellState, MessageKey> = {
    exited: "blocks.terminal.exited",
    running: "blocks.terminal.running",
    idle: "blocks.terminal.idle",
  };
  const shownNotice = terminalNotice({ phase: phase.kind, exited, inSession, driver, running: runningCommand !== null });
  const noticeText = (shown: TerminalNotice): string => {
    switch (shown) {
      case "gone":
        return t("blocks.terminal.gone");
      case "load-failed":
        return t("blocks.terminal.loadFailed").replace("{reason}", phase.kind === "load-failed" ? phase.reason : "");
      case "disconnected":
        return t("blocks.terminal.disconnected").replace("{reason}", phase.kind === "disconnected" ? phase.reason : "");
      case "exited":
        return exitNote;
      case "session":
        return t("blocks.terminal.sessionLimit");
      case "observer":
        return t("blocks.terminal.observer");
      case "running":
        return t("blocks.terminal.runningCommand").replace("{command}", runningCommand?.command ?? "…");
    }
  };

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
          <PhaseBadge phase={TERMINAL_SHELL_PHASE[shellState]} data-terminal-badge={shellState}>
            {t(shellLabel[shellState])}
          </PhaseBadge>
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

      {/*
        The terminal's state and a failed kill, each in live regions mounted with the card: losing the shell or failing
        to stop it interrupts, and anything else waits its turn. The state is read from the node after the card mounts,
        so on a card drawn again from history the state it first settles on (`restoring`) is shown without being said:
        it was already true before the card was drawn. A kill only fails after a press, so its failure is always said.
      */}
      <div className="cc-terminal-status">
        <LiveNote
          restored={restoring}
          phase={shownNotice === undefined ? undefined : TERMINAL_NOTICE_PHASE[shownNotice]}
          {...(shownNotice === undefined ? {} : { "data-terminal-notice": shownNotice })}
        >
          {shownNotice === undefined ? undefined : noticeText(shownNotice)}
        </LiveNote>
        {phase.kind === "disconnected" ? (
          <button type="button" className="cc-chip" data-terminal-reconnect="true" onClick={() => setAttempt((value) => value + 1)}>
            {t("blocks.terminal.reconnect")}
          </button>
        ) : null}
        <LiveNote phase={notice === undefined ? undefined : "error"} data-terminal-error="true">
          {notice}
        </LiveNote>
      </div>

      <div className="cc-card-actions cc-terminal-actions">
        {live && !driver && !exited && !inSession ? (
          <button type="button" className="cc-action" data-terminal-take="true" onClick={onTake}>
            {t("blocks.terminal.takeControl")}
          </button>
        ) : null}
        <button
          ref={shareButtonRef}
          type="button"
          className="cc-action"
          data-terminal-share={choice.kind}
          disabled={!live || choice.kind === "nothing"}
          onClick={onShare}
        >
          {shareLabel}
        </button>
        <button
          type="button"
          className="cc-action"
          data-terminal-expand="true"
          aria-pressed={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("blocks.terminal.collapse") : t("blocks.terminal.expand")}
        </button>
        <button
          ref={panelToggleRef}
          type="button"
          className="cc-action"
          data-terminal-processes="true"
          aria-expanded={panelOpen}
          aria-controls={`cc-terminal-panel-${terminalId}`}
          onClick={() => setPanelOpen((value) => !value)}
        >
          {t("blocks.terminal.processes")}
        </button>
        {live && !exited && !inSession ? (
          <button type="button" className="cc-action" data-terminal-kill="true" disabled={killing} onClick={onKill}>
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
 * keeps, and a "view" button beside them would be a control with nothing behind it. Each has a stop, though, because
 * that one is real: it reaches the same supervisor the agent's `stop_work` does.
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
  const [reloadKey, setReloadKey] = useState(0);
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
  }, [client, reloadKey]);
  const reload = (): void => setReloadKey((key) => key + 1);

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
                {command.workId === undefined ? null : (
                  <WorkStopButton client={client} workId={command.workId} t={t} onStopped={reload} />
                )}
              </li>
            ))}
          </PanelSection>
          <PanelSection title={t("blocks.terminal.panelBackground")} empty={overview.background.length === 0} t={t}>
            {overview.background.map((task) => (
              <li key={task.sessionId}>
                <span className="cc-terminal-panel-main">
                  <strong>{task.title}</strong>
                  <span className="cc-terminal-panel-meta" data-panel-background-status={task.status}>
                    {t(BACKGROUND_STATUS_KEY[task.status])} ·{" "}
                    {t("blocks.terminal.panelSince").replace("{at}", timeOf(task.startedAt))}
                  </span>
                </span>
                {task.status === "running" || task.status === "queued" ? (
                  <WorkStopButton client={client} workId={task.sessionId} t={t} onStopped={reload} />
                ) : null}
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

const BACKGROUND_STATUS_KEY: Record<TerminalOverview["background"][number]["status"], MessageKey> = {
  queued: "blocks.terminal.bgStatus.queued",
  running: "blocks.terminal.bgStatus.running",
  done: "blocks.terminal.bgStatus.done",
  failed: "blocks.terminal.bgStatus.failed",
  stopped: "blocks.terminal.bgStatus.stopped",
  interrupted: "blocks.terminal.bgStatus.interrupted",
};

/**
 * Stop one piece of work from the panel.
 *
 * Disabled while the stop is in flight so a double click is one stop, and a failure is said beside the button rather
 * than swallowed: a stop that silently did nothing is the worst kind of control.
 */
function WorkStopButton({
  client,
  workId,
  t,
  onStopped,
}: {
  client: GatewayClient;
  workId: string;
  t: (key: MessageKey) => string;
  onStopped: () => void;
}): ReactElement {
  const [state, setState] = useState<"idle" | "stopping" | "failed">("idle");
  const stop = (): void => {
    setState("stopping");
    client
      .cancelWork(workId)
      .then(() => {
        setState("idle");
        onStopped();
      })
      .catch(() => setState("failed"));
  };
  return (
    <div className="cc-terminal-panel-actions">
      <button
        type="button"
        className="cc-chip"
        data-panel-stop={workId}
        disabled={state === "stopping"}
        aria-busy={state === "stopping"}
        onClick={stop}
      >
        {state === "stopping" ? t("blocks.terminal.panelStopping") : t("blocks.terminal.panelStop")}
      </button>
      {/* Mounted with the button, so a stop that fails is heard as a failure the moment it happens. */}
      <LiveNote phase={state === "failed" ? "error" : undefined} data-panel-stop-failed={workId}>
        {t("blocks.terminal.panelStopFailed")}
      </LiveNote>
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
