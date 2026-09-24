import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import { createMarkScanner, keepTail, plainTerminalText, stripControlCharacters } from "./terminal-output.ts";

/**
 * Real shells, opened for a person inside the conversation.
 *
 * A terminal here is a pseudo-terminal running the user's own login shell, so everything a shell does works: colour,
 * line editing, `vim`, `htop`, another `pi`. That is also why it is host-owned: a shell has every permission the
 * user has, so it is never a widget, never isolated code and never something a package can draw.
 *
 * Three facts the rest of the node relies on:
 *
 *   - **Where a command starts and ends is read from the shell itself**, through the OSC 133 markers a small rc file
 *     adds to bash and zsh. A shell without them still works; the registry then says it cannot tell when a command
 *     finished rather than guessing an exit code.
 *   - **One driver at a time.** Any number of cards may watch a terminal; one of them types. The lease moves when a
 *     card takes it, so two cards never interleave keystrokes into one prompt.
 *   - **Nothing outlives the node.** Scrollback is memory; a restart forgets it, and a card whose terminal is gone
 *     says so instead of showing an old screen as if it were current.
 */

export const TERMINAL_LIMITS = {
  /** Shells running at once. A conversation is not a terminal multiplexer. */
  maxRunning: 12,
  /** Exited terminals kept so their card can still show how they ended. */
  maxExited: 20,
  exitedRetentionMs: 30 * 60_000,
  /** Raw bytes kept for a card that attaches late. */
  scrollbackChars: 256_000,
  /** Plain text kept per command, from the end, because the end is where the result is. */
  commandOutputChars: 64_000,
  /** Raw bytes collected per command before it is reduced to plain text. */
  commandRawChars: 256_000,
  commandsKept: 20,
  /** How long a shell with no markers must be quiet before a command is taken to have finished. */
  idleFinishMs: 1_500,
  /** How long a fresh shell has to draw its first prompt before a command is typed into it anyway. */
  promptWaitMs: 5_000,
} as const;

/** The subset of a node-pty process this module uses, so a test can hand in its own. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyProcess;

export type PtyLoader = () => Promise<{ ok: true; spawn: PtySpawn } | { ok: false; reason: string }>;

/**
 * node-pty, loaded when the first terminal is opened rather than when the node starts.
 *
 * It is a native module and an optional dependency: a machine where its binary cannot load still runs every other
 * part of the node, and the terminal says why it is unavailable instead of the node failing to boot.
 */
export const loadNodePty: PtyLoader = (() => {
  let loaded: Awaited<ReturnType<PtyLoader>> | undefined;
  return async () => {
    if (loaded !== undefined) return loaded;
    try {
      const name = "node-pty";
      const module = (await import(name)) as { spawn?: PtySpawn; default?: { spawn?: PtySpawn } };
      const spawn = module.spawn ?? module.default?.spawn;
      loaded =
        spawn === undefined
          ? { ok: false, reason: "thư viện pseudo-terminal không có hàm spawn" }
          : { ok: true, spawn };
    } catch (cause) {
      loaded = {
        ok: false,
        reason: `node này không nạp được thư viện pseudo-terminal (node-pty): ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`,
      };
    }
    return loaded;
  };
})();

/** One finished or running command, as the shell reported it. */
export interface TerminalCommandRecord {
  id: string;
  /** What was typed, when the shell said; `null` when it did not. */
  command: string | null;
  startedAt: string;
  endedAt?: string;
  /** `null` while running, and when the shell cannot report one. */
  exitCode: number | null;
  /** Plain text, the tail of it when it was long. */
  output: string;
  truncated: boolean;
}

export interface TerminalInfo {
  terminalId: string;
  title: string;
  cwd: string;
  shell: string;
  /** `osc133` when the shell reports where commands start and end; `none` when it does not. */
  integration: "osc133" | "none";
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
  endedAt?: string;
  lastActivityAt: string;
  /** The command running at the prompt right now, when there is one. */
  running: { command: string | null; startedAt: string } | null;
  conversationId?: string;
  cols: number;
  rows: number;
  /** The attachment typing into it, when one is. */
  driver: string | null;
}

export type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "command"; phase: "started" | "finished"; record: TerminalCommandRecord }
  | { type: "exit"; exitCode: number | null }
  | { type: "driver"; driver: string | null }
  | { type: "resize"; cols: number; rows: number };

export type TerminalRunResult =
  | { status: "finished"; record: TerminalCommandRecord }
  | { status: "running"; record: TerminalCommandRecord }
  | { status: "busy"; running: { command: string | null; startedAt: string } }
  /** A person has typed on the prompt line since it was drawn: typing more would run their half-line with it. */
  | { status: "typing" }
  | { status: "gone" };

export interface TerminalRegistry {
  /** Whether terminals can be opened on this node, and if not, why. */
  availability(): Promise<{ ok: true } | { ok: false; reason: string }>;
  open(input: {
    cwd: string;
    title?: string;
    conversationId?: string;
    cols?: number;
    rows?: number;
  }): Promise<{ ok: true; info: TerminalInfo } | { ok: false; reason: string }>;
  get(terminalId: string): TerminalInfo | undefined;
  list(): TerminalInfo[];
  /** The raw bytes a newly attached view replays to reach the current screen. */
  replay(terminalId: string): string;
  write(terminalId: string, data: string): boolean;
  resize(terminalId: string, cols: number, rows: number): boolean;
  /** Resolves once the shell has drawn its first prompt (or could not), so typed text lands on the prompt. */
  ready(terminalId: string): Promise<boolean>;
  /**
   * Put text on the prompt without pressing Enter. Refused while something is running, and while a person has typed
   * on the line; a line the agent prefilled earlier is replaced rather than appended to.
   */
  prefill(terminalId: string, text: string): { ok: true } | { ok: false; reason: string };
  /** Type a command and press Enter, then wait up to `waitMs` for it to finish. */
  run(terminalId: string, command: string, options?: { waitMs?: number }): Promise<TerminalRunResult>;
  commands(terminalId: string): TerminalCommandRecord[];
  subscribe(terminalId: string, listener: (event: TerminalEvent) => void): (() => void) | undefined;
  /** Take the keyboard. Any other attachment becomes an observer. */
  claimDriver(terminalId: string, attachmentId: string): boolean;
  releaseDriver(terminalId: string, attachmentId: string): void;
  kill(terminalId: string): boolean;
  /** The emergency stop's terminal half. Returns how many were running. */
  stopAll(): number;
}

interface Terminal {
  info: TerminalInfo;
  pty: PtyProcess;
  scrollback: string[];
  scrollbackChars: number;
  listeners: Set<(event: TerminalEvent) => void>;
  commands: TerminalCommandRecord[];
  current: { record: TerminalCommandRecord; raw: string; rawTruncated: boolean } | null;
  /** A prompt has been drawn at least once: the shell is ready for input. */
  prompted: boolean;
  /**
   * Who has typed on the prompt line since the shell drew it: nobody, a person, or the agent's prefill.
   *
   * The agent's keystrokes go into the same line editor a person types into. Appended to a half-typed line they would
   * run something neither of them wrote, so a person's line is never typed over, and only the agent's own is cleared.
   */
  line: "empty" | "person" | "agent";
  /**
   * The secret the shell's markers carry. Output can print `\e]133;D;0\a` as easily as the shell can, so a marker
   * without this is text, not the shell saying a command ended. It lives in a shell variable, not the environment, so
   * the commands the shell runs cannot read it.
   */
  mark: string;
  waiters: Set<() => void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The shell a terminal runs: the user's own, and the one integration file it needs.
 *
 * `SHELL` on POSIX because that is the shell the user chose; bash when it is unset. Windows gets PowerShell with no
 * integration, which the registry reports rather than hides.
 */
export function chooseShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { file: string; kind: "bash" | "zsh" | "other" } {
  if (platform === "win32") return { file: env.COMSPEC?.toLowerCase().includes("pwsh") ? env.COMSPEC : "powershell.exe", kind: "other" };
  const file = env.SHELL !== undefined && env.SHELL !== "" ? env.SHELL : "/bin/bash";
  const name = basename(file);
  return { file, kind: name === "bash" ? "bash" : name === "zsh" ? "zsh" : "other" };
}

const BASH_RC = `# ClarkCant terminal: your own ~/.bashrc first, then markers for where each command starts and ends (OSC 133).
# Generated by the node; edits here are overwritten.
# The marker secret moves out of the environment first, before anything this shell starts could inherit it.
__cc_mark="\${CC_TERMINAL_MARK:-}"
unset CC_TERMINAL_MARK
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
__cc_hist_last=
__cc_command() {
  local line number
  line=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)
  number=$(printf '%s' "$line" | sed -n 's/^ *\\([0-9][0-9]*\\).*/\\1/p')
  if [ -n "$number" ] && [ "$number" != "$__cc_hist_last" ]; then
    printf '%s' "$line" | sed 's/^ *[0-9][0-9]*[* ] *//' | tr '\\n' ' ' | tr -d '\\000-\\037\\177'
  fi
}
__cc_prompt() {
  local status=$?
  printf '\\033]133;D;%s;%s\\007\\033]133;A;%s;%s\\007' "$__cc_mark" "$status" "$__cc_mark" "\${PWD//[[:cntrl:]]/}"
  __cc_hist_last=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null | sed -n 's/^ *\\([0-9][0-9]*\\).*/\\1/p')
  return $status
}
if [ "\${BASH_VERSINFO[0]}" -gt 4 ] || { [ "\${BASH_VERSINFO[0]}" -eq 4 ] && [ "\${BASH_VERSINFO[1]}" -ge 4 ]; }; then
  PS0='\\033]133;C;\${__cc_mark};$(__cc_command)\\007'"\${PS0:-}"
  PROMPT_COMMAND="__cc_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
else
  # Bash before 4.4 (macOS ships 3.2) has no PS0: the DEBUG trap marks the first command run after a prompt instead.
  __cc_armed=
  __cc_preexec() {
    [ -n "$__cc_armed" ] || return 0
    [ -z "\${COMP_LINE:-}" ] || return 0
    __cc_armed=
    printf '\\033]133;C;%s;%s\\007' "$__cc_mark" "$(__cc_command)"
  }
  trap '__cc_preexec' DEBUG
  PROMPT_COMMAND="__cc_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND};__cc_armed=1"
fi
`;

const ZSH_ENV = `# ClarkCant terminal: loads your own .zshenv. Generated by the node.
# The marker secret moves out of the environment first, before anything this shell starts could inherit it.
__cc_mark="\${CC_TERMINAL_MARK:-}"
unset CC_TERMINAL_MARK
if [ -f "\${CC_USER_ZDOTDIR:-$HOME}/.zshenv" ]; then . "\${CC_USER_ZDOTDIR:-$HOME}/.zshenv"; fi
`;

const ZSH_RC = `# ClarkCant terminal: your own .zshrc first, then markers for where each command starts and ends (OSC 133).
# Generated by the node; edits here are overwritten.
ZDOTDIR="\${CC_USER_ZDOTDIR:-$HOME}"
if [ -f "$ZDOTDIR/.zshrc" ]; then . "$ZDOTDIR/.zshrc"; fi
autoload -Uz add-zsh-hook
__cc_preexec() { local c="\${1//[[:cntrl:]]/ }"; printf '\\033]133;C;%s;%s\\007' "$__cc_mark" "$c"; }
__cc_precmd() { local s=$?; printf '\\033]133;D;%s;%s\\007\\033]133;A;%s;%s\\007' "$__cc_mark" "$s" "$__cc_mark" "\${PWD//[[:cntrl:]]/}"; return $s; }
add-zsh-hook preexec __cc_preexec
precmd_functions=(__cc_precmd $precmd_functions)
`;

/** Write the integration files under the node's data directory and say how to start the shell with them. */
export function shellLaunch(
  shell: { file: string; kind: "bash" | "zsh" | "other" },
  integrationDir: string,
  env: Record<string, string>,
): { args: string[]; env: Record<string, string>; integration: "osc133" | "none" } {
  try {
    if (shell.kind === "bash") {
      mkdirSync(integrationDir, { recursive: true });
      const rc = join(integrationDir, "bashrc");
      writeFileSync(rc, BASH_RC, { mode: 0o600 });
      return { args: ["--rcfile", rc, "-i"], env, integration: "osc133" };
    }
    if (shell.kind === "zsh") {
      const dir = join(integrationDir, "zsh");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".zshenv"), ZSH_ENV, { mode: 0o600 });
      writeFileSync(join(dir, ".zshrc"), ZSH_RC, { mode: 0o600 });
      const userDir = env.ZDOTDIR ?? env.HOME ?? "";
      return { args: ["-i"], env: { ...env, ZDOTDIR: dir, CC_USER_ZDOTDIR: userDir }, integration: "osc133" };
    }
  } catch {
    // An integration file that cannot be written leaves a working shell without markers, which is reported below.
  }
  return { args: [], env, integration: "none" };
}

/**
 * Every process in the shell's session, the shell included, on Linux.
 *
 * A job the person put in the background (`&`, `nohup`, `disown`) is in its own process group, so a signal to the
 * shell's group misses it; they all stay in the session the pseudo-terminal opened. Elsewhere the list is empty and
 * the hangup the shell passes on to its jobs is what reaches them.
 */
function sessionMembers(sessionId: number): number[] {
  if (process.platform !== "linux") return [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  const members: number[] = [];
  for (const name of names) {
    const pid = Number.parseInt(name, 10);
    if (!Number.isInteger(pid) || String(pid) !== name) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // After the command name in parentheses: state, ppid, pgrp, session.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number.parseInt(fields[3] ?? "", 10) === sessionId) members.push(pid);
    } catch {
      // Exited between the listing and the read.
    }
  }
  return members;
}

/** Keys a person sends that leave nothing on the prompt line: Enter, interrupt, clear screen, end of input. */
const LINE_NEUTRAL_KEYS = new Set(["\r", "\u0003", "\u000c", "\u0004"]);

/**
 * Clear the prompt line the agent prefilled: end of line, then kill back to the start. Both are the default bindings
 * of readline and zle alike, so this works in either shell without knowing which one it is.
 */
const CLEAR_LINE = "\u0005\u0015";

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function createTerminalRegistry(options: {
  /** Where the shell integration files are written. */
  dataDir: string;
  loadPty?: PtyLoader;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  newId?: () => string;
}): TerminalRegistry {
  const terminals = new Map<string, Terminal>();
  const loadPty = options.loadPty ?? loadNodePty;
  const now = options.now ?? Date.now;
  const iso = (): string => new Date(now()).toISOString();
  const newId = options.newId ?? (() => `term_${randomUUID().replaceAll("-", "").slice(0, 16)}`);
  const platform = options.platform ?? process.platform;
  /** Shells being opened right now, counted before the first await so two opens cannot both take the last slot. */
  let opening = 0;

  const emit = (terminal: Terminal, event: TerminalEvent): void => {
    for (const listener of [...terminal.listeners]) {
      try {
        listener(event);
      } catch {
        // One broken view must not stop the others from seeing the stream.
      }
    }
  };

  const snapshot = (terminal: Terminal): TerminalInfo => ({
    ...terminal.info,
    running: terminal.info.running === null ? null : { ...terminal.info.running },
  });

  const prune = (): void => {
    const cutoff = now() - TERMINAL_LIMITS.exitedRetentionMs;
    const exited = [...terminals.values()].filter((terminal) => terminal.info.status === "exited");
    for (const terminal of exited) {
      if (terminal.info.endedAt !== undefined && Date.parse(terminal.info.endedAt) < cutoff) {
        terminals.delete(terminal.info.terminalId);
      }
    }
    const remaining = [...terminals.values()]
      .filter((terminal) => terminal.info.status === "exited")
      .sort((a, b) => (a.info.endedAt ?? "").localeCompare(b.info.endedAt ?? ""));
    while (remaining.length > TERMINAL_LIMITS.maxExited) {
      const oldest = remaining.shift();
      if (oldest !== undefined) terminals.delete(oldest.info.terminalId);
    }
  };

  const wake = (terminal: Terminal): void => {
    for (const waiter of [...terminal.waiters]) waiter();
  };

  const finishCommand = (terminal: Terminal, exitCode: number | null): void => {
    const current = terminal.current;
    if (current === null) return;
    const plain = keepTail(plainTerminalText(current.raw), TERMINAL_LIMITS.commandOutputChars);
    current.record.output = plain.text.replace(/^\n+/u, "").replace(/\n+$/u, "");
    current.record.truncated = plain.truncated || current.rawTruncated;
    current.record.exitCode = exitCode;
    current.record.endedAt = iso();
    terminal.current = null;
    terminal.info.running = null;
    emit(terminal, { type: "command", phase: "finished", record: { ...current.record } });
    wake(terminal);
  };

  const startCommand = (terminal: Terminal, command: string | null): void => {
    if (terminal.current !== null) finishCommand(terminal, null);
    const record: TerminalCommandRecord = {
      id: `cmd_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      command: command === null || command.trim() === "" ? null : command.trim().slice(0, 2_000),
      startedAt: iso(),
      exitCode: null,
      output: "",
      truncated: false,
    };
    terminal.commands.push(record);
    if (terminal.commands.length > TERMINAL_LIMITS.commandsKept) terminal.commands.shift();
    terminal.current = { record, raw: "", rawTruncated: false };
    terminal.info.running = { command: record.command, startedAt: record.startedAt };
    emit(terminal, { type: "command", phase: "started", record: { ...record } });
    wake(terminal);
  };

  const collect = (terminal: Terminal, text: string): void => {
    const current = terminal.current;
    if (current === null) return;
    current.raw += text;
    // Trimmed once it is twice the budget rather than on every read, so a chatty command is not a copy per chunk.
    if (current.raw.length > TERMINAL_LIMITS.commandRawChars * 2) {
      current.raw = current.raw.slice(current.raw.length - TERMINAL_LIMITS.commandRawChars);
      current.rawTruncated = true;
    }
    if (terminal.info.integration === "none") {
      // No marker will say when it ends, so quiet is the only signal there is — and the exit code stays unknown.
      clearTimeout(terminal.idleTimer);
      terminal.idleTimer = setTimeout(() => finishCommand(terminal, null), TERMINAL_LIMITS.idleFinishMs);
    }
  };

  const snapshotRecord = (terminal: Terminal, record: TerminalCommandRecord): TerminalCommandRecord => {
    if (terminal.current?.record !== record) return { ...record };
    const plain = keepTail(plainTerminalText(terminal.current.raw), TERMINAL_LIMITS.commandOutputChars);
    return { ...record, output: plain.text.replace(/^\n+/u, ""), truncated: plain.truncated || terminal.current.rawTruncated };
  };

  const waitFor = (terminal: Terminal, done: () => boolean, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (done()) {
        resolve(true);
        return;
      }
      const check = (): void => {
        if (!done()) return;
        clearTimeout(timer);
        terminal.waiters.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        terminal.waiters.delete(check);
        resolve(done());
      }, timeoutMs);
      terminal.waiters.add(check);
    });

  /** Send a signal to the shell and, where the platform lets it be found, everything else in its session. */
  const signalSession = (terminal: Terminal, signal: "SIGHUP" | "SIGKILL"): void => {
    if (platform === "win32") {
      try {
        terminal.pty.kill();
      } catch {
        // Already gone.
      }
      return;
    }
    for (const pid of sessionMembers(terminal.pty.pid)) {
      try {
        process.kill(pid, signal);
      } catch {
        // Exited already.
      }
    }
    if (terminal.info.status === "running") {
      try {
        terminal.pty.kill(signal);
      } catch {
        // Already gone; the exit handler has or will record it.
      }
    }
  };

  /**
   * Close a shell the way closing a terminal window does: a hangup, which the shell passes on to its jobs, then, for
   * whatever ignored it — a `nohup` job, a shell that traps the hangup — a kill of the whole session.
   */
  const close = (terminal: Terminal): void => {
    signalSession(terminal, "SIGHUP");
    clearTimeout(terminal.killTimer);
    const timer = setTimeout(() => signalSession(terminal, "SIGKILL"), 1_500);
    timer.unref();
    terminal.killTimer = timer;
  };

  return {
    async availability() {
      const loaded = await loadPty();
      return loaded.ok ? { ok: true } : { ok: false, reason: loaded.reason };
    },

    async open(input) {
      prune();
      const running = [...terminals.values()].filter((terminal) => terminal.info.status === "running").length + opening;
      if (running >= TERMINAL_LIMITS.maxRunning) {
        return {
          ok: false,
          reason: `Đã có ${String(running)} terminal đang chạy, là mức tối đa. Đóng bớt một terminal rồi mở lại.`,
        };
      }
      // Absolute, because the shell starts in `cwd`: a relative rc path would be looked up from there and missed.
      const cwd = resolve(input.cwd);
      try {
        if (!statSync(cwd).isDirectory()) return { ok: false, reason: `${cwd} không phải là thư mục.` };
      } catch {
        return { ok: false, reason: `Không có thư mục ${cwd} trên máy này.` };
      }
      opening += 1;
      let loaded: Awaited<ReturnType<PtyLoader>>;
      try {
        loaded = await loadPty();
      } finally {
        opening -= 1;
      }
      if (!loaded.ok) return { ok: false, reason: loaded.reason };

      const baseEnv = options.env ?? process.env;
      const shell = chooseShell(baseEnv, platform);
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(baseEnv)) if (value !== undefined) env[key] = value;
      env.TERM = "xterm-256color";
      env.COLORTERM = "truecolor";
      env.TERM_PROGRAM = "ClarkCant";
      env.CLARKCANT_TERMINAL = "1";
      if (env.LANG === undefined || env.LANG === "") env.LANG = "C.UTF-8";
      const mark = randomBytes(12).toString("hex");
      env.CC_TERMINAL_MARK = mark;
      const launch = shellLaunch(shell, resolve(options.dataDir, "terminal-shell"), env);

      const cols = clamp(input.cols ?? 100, 20, 500, 100);
      const rows = clamp(input.rows ?? 24, 5, 200, 24);
      let pty: PtyProcess;
      try {
        pty = loaded.spawn(shell.file, launch.args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: launch.env,
        });
      } catch (cause) {
        return {
          ok: false,
          reason: `Không mở được shell ${shell.file}: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }

      const at = iso();
      const terminalId = newId();
      const terminal: Terminal = {
        info: {
          terminalId,
          title: (input.title ?? basename(cwd)) || cwd,
          cwd,
          shell: basename(shell.file),
          integration: launch.integration,
          status: "running",
          exitCode: null,
          startedAt: at,
          lastActivityAt: at,
          running: null,
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          cols,
          rows,
          driver: null,
        },
        pty,
        scrollback: [],
        scrollbackChars: 0,
        listeners: new Set(),
        commands: [],
        current: null,
        prompted: launch.integration === "none",
        line: "empty",
        mark,
        waiters: new Set(),
      };
      terminals.set(terminalId, terminal);

      const scanner = createMarkScanner();
      /** The payload after this terminal's secret, or `undefined` for a marker something other than its shell printed. */
      const own = (payload: string): string | undefined =>
        payload === mark ? "" : payload.startsWith(`${mark};`) ? payload.slice(mark.length + 1) : undefined;
      pty.onData((data) => {
        terminal.info.lastActivityAt = iso();
        terminal.scrollback.push(data);
        terminal.scrollbackChars += data.length;
        while (terminal.scrollbackChars > TERMINAL_LIMITS.scrollbackChars && terminal.scrollback.length > 1) {
          terminal.scrollbackChars -= terminal.scrollback.shift()?.length ?? 0;
        }
        emit(terminal, { type: "output", data });
        for (const event of scanner.push(data)) {
          if (event.kind === "text") {
            collect(terminal, event.text);
            continue;
          }
          const payload = launch.integration === "osc133" ? own(event.payload) : undefined;
          if (payload === undefined) continue;
          if (event.code === "C") {
            startCommand(terminal, payload);
          } else if (event.code === "D") {
            // A `D` with no `C` before it is the first prompt, or an empty line: nothing ran.
            if (terminal.current !== null) {
              const code = Number.parseInt(payload, 10);
              finishCommand(terminal, Number.isFinite(code) ? code : null);
            }
          } else if (event.code === "A") {
            // The prompt reports the directory it is in, so what the agent's command is judged against is where it runs.
            if (payload !== "" && isAbsolute(payload)) terminal.info.cwd = payload;
            terminal.prompted = true;
            terminal.line = "empty";
            wake(terminal);
          }
        }
      });
      pty.onExit(({ exitCode }) => {
        // The kill timer stays: what it kills is the rest of the session, which can outlive the shell.
        clearTimeout(terminal.idleTimer);
        if (terminal.current !== null) finishCommand(terminal, null);
        terminal.info.status = "exited";
        terminal.info.exitCode = exitCode;
        terminal.info.endedAt = iso();
        terminal.info.running = null;
        emit(terminal, { type: "exit", exitCode });
        wake(terminal);
      });
      return { ok: true, info: snapshot(terminal) };
    },

    get(terminalId) {
      const terminal = terminals.get(terminalId);
      return terminal === undefined ? undefined : snapshot(terminal);
    },

    list() {
      prune();
      return [...terminals.values()]
        .map(snapshot)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },

    replay(terminalId) {
      return terminals.get(terminalId)?.scrollback.join("") ?? "";
    },

    write(terminalId, data) {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined || terminal.info.status !== "running") return false;
      terminal.pty.write(data);
      if (terminal.current === null) {
        if (!LINE_NEUTRAL_KEYS.has(data)) terminal.line = "person";
        // Without markers there is no prompt to say the line is empty again; sending it is the only sign.
        if (terminal.info.integration === "none" && (data.includes("\r") || data.includes("\u0003"))) terminal.line = "empty";
      }
      // Without markers, a line the user sends is the only sign a command started.
      if (terminal.info.integration === "none" && terminal.current === null && data.includes("\r")) {
        startCommand(terminal, null);
      }
      return true;
    },

    resize(terminalId, cols, rows) {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined || terminal.info.status !== "running") return false;
      const nextCols = clamp(cols, 2, 500, terminal.info.cols);
      const nextRows = clamp(rows, 1, 200, terminal.info.rows);
      if (nextCols === terminal.info.cols && nextRows === terminal.info.rows) return true;
      terminal.info.cols = nextCols;
      terminal.info.rows = nextRows;
      try {
        terminal.pty.resize(nextCols, nextRows);
      } catch {
        return false;
      }
      emit(terminal, { type: "resize", cols: nextCols, rows: nextRows });
      return true;
    },

    async ready(terminalId) {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined) return false;
      await waitFor(terminal, () => terminal.prompted || terminal.info.status !== "running", TERMINAL_LIMITS.promptWaitMs);
      return terminal.info.status === "running";
    },

    prefill(terminalId, text) {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined || terminal.info.status !== "running") {
        return { ok: false, reason: "Terminal này không còn chạy." };
      }
      if (terminal.current !== null) {
        return { ok: false, reason: "Terminal đang chạy một lệnh khác, nên không điền sẵn vào dòng lệnh được." };
      }
      if (terminal.line === "person") {
        return { ok: false, reason: "Người dùng đang gõ dở một dòng lệnh trong terminal này, nên không điền đè lên." };
      }
      // One line, no Enter: pressing Enter is the person's decision, and a newline in the text would make it for them.
      const line = stripControlCharacters(text.replace(/[\r\n]+/gu, " "));
      terminal.pty.write(terminal.line === "agent" ? `${CLEAR_LINE}${line}` : line);
      terminal.line = "agent";
      return { ok: true };
    },

    async run(terminalId, command, runOptions = {}) {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined || terminal.info.status !== "running") return { status: "gone" };
      if (terminal.info.running !== null) return { status: "busy", running: { ...terminal.info.running } };
      // A shell that has not drawn its first prompt would take the keystrokes as input to its rc file's commands.
      await waitFor(terminal, () => terminal.prompted || terminal.info.status !== "running", TERMINAL_LIMITS.promptWaitMs);
      const afterWait = terminal.info;
      if (afterWait.status !== "running") return { status: "gone" };
      if (afterWait.running !== null) return { status: "busy", running: { ...afterWait.running } };
      if (terminal.line === "person") return { status: "typing" };

      const before = terminal.commands.at(-1);
      // Control characters are keystrokes, not text: a tab completes, a ^U erases. What runs is exactly what was judged.
      const line = stripControlCharacters(command.replace(/[\r\n]+/gu, " ")).trim();
      terminal.pty.write(`${terminal.line === "agent" ? CLEAR_LINE : ""}${line}\r`);
      terminal.line = "empty";
      if (terminal.info.integration === "none") startCommand(terminal, line);
      else {
        // The shell reports its own `C`; wait briefly for it so the record below is this command's, not the last one.
        await waitFor(terminal, () => terminal.commands.at(-1) !== before, 2_000);
      }
      const record = terminal.commands.at(-1);
      if (record === undefined || record === before) {
        return {
          status: "running",
          record: {
            id: "pending",
            command: line,
            startedAt: iso(),
            exitCode: null,
            output: "",
            truncated: false,
          },
        };
      }
      const waitMs = Math.max(0, Math.min(runOptions.waitMs ?? 30_000, 300_000));
      const finished = await waitFor(terminal, () => record.endedAt !== undefined, waitMs);
      return finished ? { status: "finished", record: { ...record } } : { status: "running", record: snapshotRecord(terminal, record) };
    },

    commands(terminalId) {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined) return [];
      return terminal.commands.map((record) => snapshotRecord(terminal, record));
    },

    subscribe(terminalId, listener) {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined) return undefined;
      terminal.listeners.add(listener);
      return () => {
        terminal.listeners.delete(listener);
      };
    },

    claimDriver(terminalId, attachmentId) {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined) return false;
      if (terminal.info.driver === attachmentId) return true;
      terminal.info.driver = attachmentId;
      emit(terminal, { type: "driver", driver: attachmentId });
      return true;
    },

    releaseDriver(terminalId, attachmentId) {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined || terminal.info.driver !== attachmentId) return;
      terminal.info.driver = null;
      emit(terminal, { type: "driver", driver: null });
    },

    kill(terminalId) {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined || terminal.info.status !== "running") return false;
      close(terminal);
      return true;
    },

    stopAll() {
      let count = 0;
      for (const terminal of terminals.values()) {
        if (terminal.info.status !== "running") continue;
        count += 1;
        close(terminal);
      }
      return count;
    },
  };
}
