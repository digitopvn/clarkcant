/**
 * The terminal card's logic that needs no DOM: the socket URL and protocol, what "send to the conversation" sends,
 * and how a Pi transcript is drawn into a terminal.
 *
 * Kept out of the component so the rules can be tested in Node: the card itself only wires these to xterm.js.
 */

/** One finished or running command, as the node reports it. */
export interface TerminalCommandView {
  id: string;
  command: string | null;
  startedAt: string;
  endedAt?: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

export interface TerminalInfoView {
  terminalId: string;
  title: string;
  cwd: string;
  shell: string;
  integration: "osc133" | "none";
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
  endedAt?: string;
  lastActivityAt: string;
  running: { command: string | null; startedAt: string } | null;
  cols: number;
  rows: number;
}

export interface PiSessionSummaryView {
  ref: string;
  title: string;
  cwd: string | null;
  source: "node" | "pi";
  updatedAt: string;
  active: boolean;
}

export interface PiSessionEntryView {
  at: string | null;
  kind: "session" | "user" | "assistant" | "thinking" | "tool-call" | "tool-result" | "note";
  text: string;
  toolName?: string;
  isError?: boolean;
}

/** Everything running on the node, as `GET /terminals` answers. */
export interface TerminalOverview {
  available: boolean;
  reason?: string;
  terminals: TerminalInfoView[];
  commands: { command: string; cwd: string; startedAt: string }[];
  background: { sessionId: string; title: string; status: "running" | "done" | "failed"; startedAt: string; endedAt?: string }[];
  piSessions: PiSessionSummaryView[];
}

export type TerminalServerFrame =
  | { type: "ready" }
  | { type: "attached"; info: TerminalInfoView; replay: string; driver: boolean; commands: TerminalCommandView[] }
  | { type: "output"; data: string }
  /** The screen as it is now, after this card fell too far behind to be sent every byte it missed. */
  | { type: "replay"; data: string }
  | { type: "command"; phase: "started" | "finished"; record: TerminalCommandView }
  | { type: "exit"; exitCode: number | null }
  | { type: "driver"; driver: boolean }
  | { type: "size"; cols: number; rows: number }
  | { type: "session-start"; summary: PiSessionSummaryView }
  | { type: "session-entries"; entries: PiSessionEntryView[]; initial: boolean }
  | { type: "error"; code: string; message: string };

export type TerminalClientFrame =
  | { type: "attach"; terminalId: string; cols: number; rows: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "take"; cols: number; rows: number }
  | { type: "watch-session"; ref: string }
  | { type: "detach" };

/**
 * `http://host:port` becomes `ws://host:port/terminal`, and https becomes wss.
 *
 * The same rule as the voice socket: the token travels in the first frame, so plain `ws` is allowed only to a
 * loopback node, where it never crosses a network.
 */
export function terminalSocketUrl(nodeBaseUrl: string): string {
  const url = new URL("/terminal", nodeBaseUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
    return url.toString();
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(`terminal tới ${host} cần https: token đi trên socket này và không được đi dạng không mã hoá`);
  }
  url.protocol = "ws:";
  return url.toString();
}

export function parseServerFrame(data: unknown): TerminalServerFrame | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const type = (parsed as { type?: unknown }).type;
    return typeof type === "string" ? (parsed as TerminalServerFrame) : undefined;
  } catch {
    return undefined;
  }
}

export interface TerminalConnection {
  send(frame: TerminalClientFrame): void;
  close(): void;
}

/**
 * Open the socket, authenticate, and hand every frame to `onFrame`.
 *
 * Frames sent before the node said `ready` are queued rather than dropped, so a card can attach in the same tick it
 * connects.
 */
export function connectTerminalSocket(options: {
  url: string;
  token: string;
  onFrame: (frame: TerminalServerFrame) => void;
  onClose: (reason: string) => void;
  createSocket?: (url: string) => WebSocket;
}): TerminalConnection {
  const socket = (options.createSocket ?? ((url: string) => new WebSocket(url)))(options.url);
  const queue: TerminalClientFrame[] = [];
  let ready = false;
  let closed = false;
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "auth", token: options.token }));
  });
  socket.addEventListener("message", (event: MessageEvent) => {
    const frame = parseServerFrame(event.data);
    if (frame === undefined) return;
    if (frame.type === "ready") {
      ready = true;
      for (const queued of queue.splice(0)) socket.send(JSON.stringify(queued));
    }
    options.onFrame(frame);
  });
  socket.addEventListener("close", (event: CloseEvent) => {
    if (closed) return;
    closed = true;
    options.onClose(event.reason === "" ? `mã ${String(event.code)}` : event.reason);
  });
  return {
    send(frame) {
      if (closed) return;
      if (!ready) {
        queue.push(frame);
        return;
      }
      socket.send(JSON.stringify(frame));
    },
    close() {
      closed = true;
      socket.close(1000, "card closed");
    },
  };
}

/** What the share button will send, decided the same way its label is. */
export type ShareChoice =
  | { kind: "selection"; text: string }
  | { kind: "command"; record: TerminalCommandView }
  | { kind: "screen"; text: string }
  | { kind: "nothing" };

/**
 * The most specific thing there is: what the person selected, else the last finished command, else the screen.
 *
 * A running command is not shared as a result: its output is not a result yet, and sending half of it as if it
 * were would be the same claim as a spinner that says "done".
 */
export function chooseShare(input: {
  selection: string;
  commands: readonly TerminalCommandView[];
  screen: string;
}): ShareChoice {
  if (input.selection.trim() !== "") return { kind: "selection", text: input.selection };
  const finished = [...input.commands].reverse().find((record) => record.endedAt !== undefined);
  if (finished !== undefined) return { kind: "command", record: finished };
  if (input.screen.trim() !== "") return { kind: "screen", text: input.screen };
  return { kind: "nothing" };
}

const MAX_SHARE_CHARS = 12_000;

function fence(text: string): string {
  // A fence longer than any run of backticks inside, so output that contains a fence cannot close it early.
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}\n${text}\n${marks}`;
}

function clipTail(text: string): { text: string; cut: boolean } {
  return text.length <= MAX_SHARE_CHARS ? { text, cut: false } : { text: text.slice(-MAX_SHARE_CHARS), cut: true };
}

/**
 * The message a share becomes: plain words a person could have typed, with the output fenced.
 *
 * It names where it came from and, for a command, the exit code, because "this failed" means nothing without it.
 */
export function formatShare(choice: ShareChoice, context: { title: string; cwd: string }): string {
  if (choice.kind === "nothing") return "";
  if (choice.kind === "command") {
    const record = choice.record;
    const body = clipTail(record.output === "" ? "(không in gì)" : record.output);
    const status = record.exitCode === null ? "shell không báo exit code" : `exit ${String(record.exitCode)}`;
    return (
      `Kết quả lệnh trong terminal ${context.title} (${context.cwd}):\n` +
      `$ ${record.command ?? "(không rõ lệnh)"} — ${status}${record.truncated || body.cut ? " — chỉ phần cuối" : ""}\n` +
      fence(body.text)
    );
  }
  const body = clipTail(choice.text.replace(/\s+$/u, ""));
  const what = choice.kind === "selection" ? "Đoạn tôi chọn trong terminal" : "Màn hình terminal";
  return `${what} ${context.title} (${context.cwd})${body.cut ? " — chỉ phần cuối" : ""}:\n${fence(body.text)}`;
}

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
} as const;

/** C0 controls and DEL removed, tab and newline kept: a code-point loop, since the intent is a range check. */
function withoutControls(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 0x20 || code === 0x7f) && character !== "\t" && character !== "\n") continue;
    out += character;
  }
  return out;
}

/**
 * A Pi transcript entry as terminal text: a coloured label, then the text, with `\r\n` line ends xterm needs.
 *
 * Control characters in the text are removed first: a transcript is data, and an escape sequence inside a tool's
 * output must not be able to move the cursor or retitle the window of the view that shows it.
 */
export function renderPiEntry(entry: PiSessionEntryView): string {
  const clean = withoutControls(entry.text).replace(/\n/gu, "\r\n  ");
  const time = entry.at === null ? "" : `${ANSI.dim}${entry.at.slice(11, 19)}${ANSI.reset} `;
  const label = (() => {
    switch (entry.kind) {
      case "user":
        return `${ANSI.bold}${ANSI.cyan}user${ANSI.reset}`;
      case "assistant":
        return `${ANSI.bold}${ANSI.green}pi${ANSI.reset}`;
      case "thinking":
        return `${ANSI.dim}thinking${ANSI.reset}`;
      case "tool-call":
        return `${ANSI.yellow}→ tool${ANSI.reset}`;
      case "tool-result":
        return entry.isError === true ? `${ANSI.red}← lỗi${ANSI.reset}` : `${ANSI.magenta}← kết quả${ANSI.reset}`;
      case "session":
        return `${ANSI.dim}phiên${ANSI.reset}`;
      default:
        return entry.isError === true ? `${ANSI.red}lỗi${ANSI.reset}` : `${ANSI.dim}ghi chú${ANSI.reset}`;
    }
  })();
  const body = entry.kind === "thinking" ? `${ANSI.dim}${clean}${ANSI.reset}` : clean;
  return `${time}${label} ${body}\r\n`;
}
