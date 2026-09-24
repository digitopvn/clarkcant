import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import { type RawData, WebSocketServer, type WebSocket } from "ws";

import type { PiSessionWatcher } from "./pi-session-watch.ts";
import { tokenMatches } from "./routes/http.ts";
import type { TerminalRegistry } from "./terminal-sessions.ts";

/**
 * The live channel a terminal card reads and types through.
 *
 * A WebSocket on the node's own server and origin, like the voice socket: a browser cannot put a bearer header on a
 * WebSocket, so the first frame is `{ type: "auth", token }` and nothing else is read until it verifies.
 *
 * One socket follows one thing at a time — a terminal, or a Pi session's transcript. Following a terminal makes the
 * socket its driver when nobody is driving; otherwise it observes until it sends `take`. Only the driver's keystrokes
 * and size reach the shell, which is what keeps two cards from typing into one prompt.
 *
 * Client → node: `auth`, `attach { terminalId, cols, rows }`, `input { data }`, `resize { cols, rows }`, `take`,
 * `watch-session { ref }`, `detach`.
 *
 * Node → client: `ready`, `attached { info, replay, driver }`, `output`, `replay { data }`, `command`, `exit`,
 * `driver { driver }`, `size { cols, rows }`, `session-start { summary }`, `session-entries { entries, initial }`,
 * `error { code, message }`.
 *
 * Output is batched per tick and never queued without bound: a program that prints faster than the browser reads
 * would otherwise grow the node's send buffer until it ran out of memory. Past a high-water mark the socket stops
 * sending output, and once the browser has caught up it gets the scrollback again (`replay`), which is the screen as
 * it is now rather than every frame it missed.
 */

const MAX_FRAME_BYTES = 64 * 1024;
/** A socket still holding this much unsent is behind; output stops until it drains below the low mark. */
const SEND_HIGH_WATER = 1_000_000;
const SEND_LOW_WATER = 128_000;
/** How long an opened socket has to authenticate before it is closed. */
const AUTH_TIMEOUT_MS = 10_000;

export interface TerminalGateway {
  close(): Promise<void>;
}

export function attachTerminalGateway(options: {
  server: Server;
  localToken: string;
  terminals: TerminalRegistry;
  piSessions: PiSessionWatcher;
  path?: string;
}): TerminalGateway {
  const path = options.path ?? "/terminal";
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  options.server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== path) return;
    wss.handleUpgrade(request, socket, head, (ws) => serve(ws));
  });

  function serve(ws: WebSocket): void {
    const attachmentId = `att_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let authenticated = false;
    let terminalId: string | undefined;
    let stop: (() => void) | undefined;
    const authTimer = setTimeout(() => ws.close(4401, "unauthenticated"), AUTH_TIMEOUT_MS);
    authTimer.unref();

    const send = (frame: Record<string, unknown>): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };

    let pendingOutput = "";
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let behind = false;
    const flushOutput = (): void => {
      flushTimer = undefined;
      if (behind) {
        if (ws.bufferedAmount > SEND_LOW_WATER) {
          flushTimer = setTimeout(flushOutput, 100);
          return;
        }
        behind = false;
        pendingOutput = "";
        if (terminalId !== undefined) send({ type: "replay", data: options.terminals.replay(terminalId) });
        return;
      }
      const data = pendingOutput;
      pendingOutput = "";
      if (data !== "") send({ type: "output", data });
    };
    const queueOutput = (data: string): void => {
      if (!behind && ws.bufferedAmount > SEND_HIGH_WATER) {
        behind = true;
        pendingOutput = "";
      }
      if (!behind) pendingOutput += data;
      flushTimer ??= setTimeout(flushOutput, behind ? 100 : 0);
    };
    const resetOutput = (): void => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      pendingOutput = "";
      behind = false;
    };
    const error = (code: string, message: string): void => send({ type: "error", code, message });

    const detach = (): void => {
      stop?.();
      stop = undefined;
      resetOutput();
      if (terminalId !== undefined) options.terminals.releaseDriver(terminalId, attachmentId);
      terminalId = undefined;
    };

    ws.on("message", (data: RawData) => {
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
        frame = parsed as Record<string, unknown>;
      } catch {
        error("INVALID_FRAME", "mỗi frame phải là một object JSON");
        return;
      }

      if (!authenticated) {
        const token = frame.type === "auth" ? frame.token : undefined;
        if (typeof token !== "string" || !tokenMatches(options.localToken, token)) {
          // Identical for a missing and a wrong token, as the HTTP gate is.
          error("UNAUTHENTICATED", "frame đầu tiên phải là auth với token hợp lệ");
          ws.close(4401, "unauthenticated");
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        send({ type: "ready" });
        return;
      }

      switch (frame.type) {
        case "attach": {
          detach();
          const id = typeof frame.terminalId === "string" ? frame.terminalId : "";
          const info = options.terminals.get(id);
          if (info === undefined) {
            error("TERMINAL_GONE", "Terminal này không còn trên node (node đã khởi động lại hoặc terminal đã bị dọn).");
            return;
          }
          terminalId = id;
          const unsubscribe = options.terminals.subscribe(id, (event) => {
            if (event.type === "output") {
              queueOutput(event.data);
              return;
            }
            // Anything else follows the output before it, so what is batched goes first.
            if (pendingOutput !== "" && !behind) {
              clearTimeout(flushTimer);
              flushOutput();
            }
            if (event.type === "driver") send({ type: "driver", driver: event.driver === attachmentId });
            else if (event.type === "resize") send({ type: "size", cols: event.cols, rows: event.rows });
            else send(event);
          });
          stop = unsubscribe;
          let driver = false;
          if (info.status === "running" && (info.driver === null || info.driver === undefined)) {
            driver = options.terminals.claimDriver(id, attachmentId);
            if (typeof frame.cols === "number" && typeof frame.rows === "number") {
              options.terminals.resize(id, frame.cols, frame.rows);
            }
          }
          const current = options.terminals.get(id) ?? info;
          send({
            type: "attached",
            info: { ...current, driver: undefined },
            replay: options.terminals.replay(id),
            driver,
            commands: options.terminals.commands(id).slice(-5),
          });
          return;
        }
        case "input": {
          if (terminalId === undefined || typeof frame.data !== "string") return;
          if (options.terminals.get(terminalId)?.driver !== attachmentId) {
            error("NOT_DRIVER", "Thẻ khác đang điều khiển terminal này. Bấm “Điều khiển ở đây” để gõ.");
            return;
          }
          options.terminals.write(terminalId, frame.data);
          return;
        }
        case "resize": {
          if (terminalId === undefined || typeof frame.cols !== "number" || typeof frame.rows !== "number") return;
          if (options.terminals.get(terminalId)?.driver !== attachmentId) return;
          options.terminals.resize(terminalId, frame.cols, frame.rows);
          return;
        }
        case "take": {
          if (terminalId === undefined) return;
          const info = options.terminals.get(terminalId);
          if (info?.status !== "running") {
            error("TERMINAL_EXITED", "Terminal đã kết thúc nên không điều khiển được nữa.");
            return;
          }
          options.terminals.claimDriver(terminalId, attachmentId);
          if (typeof frame.cols === "number" && typeof frame.rows === "number") {
            options.terminals.resize(terminalId, frame.cols, frame.rows);
          }
          return;
        }
        case "watch-session": {
          detach();
          const ref = typeof frame.ref === "string" ? frame.ref : "";
          const watched = options.piSessions.watch(ref, (entries, initial) => {
            send({ type: "session-entries", entries, initial });
          });
          if (!watched.ok) {
            error("SESSION_UNAVAILABLE", watched.reason);
            return;
          }
          stop = watched.stop;
          send({ type: "session-start", summary: watched.summary });
          return;
        }
        case "detach":
          detach();
          return;
        default:
          error("UNKNOWN_FRAME", "frame không được hỗ trợ");
      }
    });

    const closed = (): void => {
      clearTimeout(authTimer);
      detach();
    };
    ws.on("close", closed);
    ws.on("error", closed);
  }

  return {
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await Promise.race([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    },
  };
}
