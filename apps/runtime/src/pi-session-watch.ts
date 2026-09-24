import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { redactSecrets } from "@clarkcant/contracts";

/**
 * Watching another Pi session as it is written.
 *
 * Pi writes a session as a JSONL transcript and appends one entry per message, so following the file *is* following
 * the session: nothing here talks to Pi, loads its SDK or needs the session to cooperate. That is also the limit this
 * module states rather than hides — an update arrives when Pi writes an entry, which is once per message, not once
 * per token.
 *
 * Everything leaving this module has been through `redactSecrets`: a transcript holds whatever a tool printed, and a
 * browser is a worse place for a leaked token than the file it came from.
 */

export interface PiSessionSummary {
  /** Opaque: a path is not something the browser needs, and not something it should be able to ask for. */
  ref: string;
  title: string;
  cwd: string | null;
  /** `node` for the sessions this node runs, `pi` for sessions from Pi used on its own. */
  source: "node" | "pi";
  updatedAt: string;
  /** Written to in the last minute. A guess about liveness, labelled as recent activity rather than "running". */
  active: boolean;
}

export interface PiSessionEntry {
  at: string | null;
  kind: "session" | "user" | "assistant" | "thinking" | "tool-call" | "tool-result" | "note";
  text: string;
  toolName?: string;
  isError?: boolean;
}

export interface PiSessionRoot {
  dir: string;
  source: "node" | "pi";
  /** 1 for a directory of transcripts, 2 for Pi's directory of per-project directories. */
  depth: 1 | 2;
}

const LIMITS = {
  listed: 40,
  activeWindowMs: 60_000,
  entryChars: 4_000,
  argumentChars: 600,
  initialBytes: 512_000,
  initialEntries: 200,
  titleScanBytes: 64_000,
  pollMs: 1_000,
} as const;

/** Where Pi keeps its own sessions: `PI_CODING_AGENT_DIR` when set, `~/.pi/agent` otherwise. */
export function defaultPiSessionRoots(dataDir: string, env: NodeJS.ProcessEnv = process.env): PiSessionRoot[] {
  const agentDir = env.PI_CODING_AGENT_DIR !== undefined && env.PI_CODING_AGENT_DIR !== "" ? env.PI_CODING_AGENT_DIR : join(homedir(), ".pi", "agent");
  return [
    { dir: join(dataDir, "sessions"), source: "node", depth: 1 },
    { dir: join(agentDir, "sessions"), source: "pi", depth: 2 },
  ];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (đã cắt bớt)`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (typeof part !== "object" || part === null) return "";
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "image") return "[ảnh]";
      return "";
    })
    .filter((piece) => piece !== "")
    .join("\n");
}

/**
 * One transcript line, as the entries a reader sees.
 *
 * A line can hold several: an assistant message with thinking, text and two tool calls is four things that happened,
 * in that order. A line this module does not recognise yields nothing rather than a guess.
 */
export function parsePiSessionLine(line: string): PiSessionEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const entry = parsed as Record<string, unknown>;
  const at = typeof entry.timestamp === "string" ? entry.timestamp : null;
  const out: PiSessionEntry[] = [];
  const push = (value: PiSessionEntry): void => {
    const text = redactSecrets(clip(value.text, LIMITS.entryChars));
    if (text.trim() === "") return;
    out.push({ ...value, text });
  };

  if (entry.type === "session") {
    push({ at, kind: "session", text: typeof entry.cwd === "string" ? `Phiên bắt đầu trong ${entry.cwd}` : "Phiên bắt đầu" });
    return out;
  }
  if (entry.type === "compaction") {
    push({ at, kind: "note", text: "Pi đã tóm gọn ngữ cảnh của phiên." });
    return out;
  }
  if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return out;
  const message = entry.message as Record<string, unknown>;

  if (message.role === "user") {
    push({ at, kind: "user", text: textOf(message.content) });
  } else if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content as unknown[]) {
      if (typeof part !== "object" || part === null) continue;
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") push({ at, kind: "assistant", text: record.text });
      else if (record.type === "thinking" && typeof record.thinking === "string") push({ at, kind: "thinking", text: record.thinking });
      else if (record.type === "toolCall" && typeof record.name === "string") {
        let args: string;
        try {
          args = JSON.stringify(record.arguments ?? {});
        } catch {
          args = "";
        }
        push({ at, kind: "tool-call", toolName: record.name, text: `${record.name} ${clip(args, LIMITS.argumentChars)}` });
      }
    }
    if (typeof message.errorMessage === "string" && message.errorMessage !== "") {
      push({ at, kind: "note", text: `Lỗi: ${message.errorMessage}`, isError: true });
    }
  } else if (message.role === "toolResult") {
    push({
      at,
      kind: "tool-result",
      text: textOf(message.content),
      ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
      ...(message.isError === true ? { isError: true } : {}),
    });
  } else if (message.role === "bashExecution" && typeof message.command === "string") {
    push({ at, kind: "tool-call", toolName: "bash", text: `$ ${message.command}\n${typeof message.output === "string" ? message.output : ""}` });
  }
  return out;
}

function readRange(path: string, start: number, end: number): string {
  if (end <= start) return "";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function describeFile(path: string, source: "node" | "pi", now: number): PiSessionSummary | undefined {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return undefined;
  }
  let cwd: string | null = null;
  let title = "";
  try {
    const head = readRange(path, 0, Math.min(stat.size, LIMITS.titleScanBytes));
    for (const line of head.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.type === "session" && typeof parsed.cwd === "string") cwd = parsed.cwd;
      if (parsed.type === "session_info" && typeof parsed.name === "string" && parsed.name !== "") title = parsed.name;
      if (title === "" && parsed.type === "message") {
        const message = parsed.message as Record<string, unknown> | undefined;
        if (message?.role === "user") title = textOf(message.content).split("\n")[0] ?? "";
      }
      if (title !== "" && cwd !== null) break;
    }
  } catch {
    // An unreadable head still lists the session, by its time rather than its first question.
  }
  return {
    ref: createHash("sha256").update(path).digest("hex").slice(0, 16),
    title: redactSecrets(clip(title === "" ? "Phiên chưa có tin nhắn" : title, 120)),
    cwd,
    source,
    updatedAt: stat.mtime.toISOString(),
    active: now - stat.mtimeMs < LIMITS.activeWindowMs,
  };
}

export interface PiSessionWatcher {
  list(): PiSessionSummary[];
  /**
   * Follow one session. `onEntries` is called first with the recent history (`initial: true`), then with each batch
   * Pi appends.
   */
  watch(
    ref: string,
    onEntries: (entries: PiSessionEntry[], initial: boolean) => void,
  ): { ok: true; summary: PiSessionSummary; stop: () => void } | { ok: false; reason: string };
}

export function createPiSessionWatcher(options: { roots: () => readonly PiSessionRoot[]; now?: () => number }): PiSessionWatcher {
  const now = options.now ?? Date.now;
  const paths = new Map<string, { path: string; source: "node" | "pi" }>();

  const list = (): PiSessionSummary[] => {
    const found: { path: string; source: "node" | "pi"; mtime: number }[] = [];
    const scan = (dir: string, source: "node" | "pi", depth: number): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const path = join(dir, name);
        if (name.endsWith(".jsonl")) {
          try {
            found.push({ path, source, mtime: statSync(path).mtimeMs });
          } catch {
            // Gone between the listing and the stat.
          }
        } else if (depth > 1) {
          scan(path, source, depth - 1);
        }
      }
    };
    for (const root of options.roots()) scan(root.dir, root.source, root.depth);
    found.sort((a, b) => b.mtime - a.mtime);
    const at = now();
    const summaries: PiSessionSummary[] = [];
    for (const file of found.slice(0, LIMITS.listed)) {
      const summary = describeFile(file.path, file.source, at);
      if (summary === undefined) continue;
      paths.set(summary.ref, { path: file.path, source: file.source });
      summaries.push(summary);
    }
    return summaries;
  };

  return {
    list,
    watch(ref, onEntries) {
      if (!paths.has(ref)) list();
      const known = paths.get(ref);
      if (known === undefined) return { ok: false, reason: "Không tìm thấy phiên Pi này nữa." };
      const summary = describeFile(known.path, known.source, now());
      if (summary === undefined) return { ok: false, reason: "Không đọc được transcript của phiên Pi này." };

      let offset = 0;
      let carry = "";
      let stopped = false;
      const parseLines = (text: string): PiSessionEntry[] => {
        const lines = (carry + text).split("\n");
        carry = lines.pop() ?? "";
        return lines.flatMap((line) => (line.trim() === "" ? [] : parsePiSessionLine(line)));
      };

      try {
        const size = statSync(known.path).size;
        const start = Math.max(0, size - LIMITS.initialBytes);
        let text = readRange(known.path, start, size);
        // Starting mid-file lands inside a line; the first line is dropped rather than parsed as half a document.
        if (start > 0) text = text.slice(text.indexOf("\n") + 1);
        offset = size;
        const entries = parseLines(text);
        onEntries(entries.slice(-LIMITS.initialEntries), true);
      } catch {
        return { ok: false, reason: "Không đọc được transcript của phiên Pi này." };
      }

      const poll = (): void => {
        if (stopped) return;
        let size: number;
        try {
          size = statSync(known.path).size;
        } catch {
          return;
        }
        if (size < offset) {
          // Rewritten in place (Pi's redaction pass does this): continue from the new end rather than replaying.
          offset = size;
          carry = "";
          return;
        }
        if (size === offset) return;
        const text = readRange(known.path, offset, size);
        offset = size;
        const entries = parseLines(text);
        if (entries.length > 0) onEntries(entries, false);
      };

      let watcher: FSWatcher | undefined;
      try {
        watcher = watch(known.path, { persistent: false }, () => poll());
      } catch {
        // Some filesystems cannot be watched; the poll below still follows the file.
      }
      const timer = setInterval(poll, LIMITS.pollMs);
      timer.unref();
      return {
        ok: true,
        summary,
        stop: () => {
          stopped = true;
          clearInterval(timer);
          watcher?.close();
        },
      };
    },
  };
}
