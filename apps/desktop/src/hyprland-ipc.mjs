/**
 * Hyprland's request socket: one request per connection, the reply is everything written before the socket closes.
 *
 * This is the same protocol `hyprctl` speaks (`j/clients` for JSON queries, `dispatch <name> <args>` for dispatchers),
 * talked to directly so the shell does not depend on `hyprctl` being on the PATH or on spawning a process per request.
 * Unverified against a live compositor; see `hyprland-window-controller.mjs`.
 */

import { createConnection } from "node:net";
import { join } from "node:path";

/** The longest reply accepted. A client list for a busy desktop is tens of kilobytes; more than this is not Hyprland. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

/**
 * Where Hyprland listens, from the instance `detectWindowSession` already checked.
 *
 * @param {{ runtimeDir: string, signature: string }} instance
 */
export function hyprlandSocketPath({ runtimeDir, signature }) {
  return join(runtimeDir, "hypr", signature, ".socket.sock");
}

/**
 * A request function over the socket at `socketPath`.
 *
 * Bounded in time and size, so a compositor that hangs or floods costs one failed request (which degrades the backend)
 * rather than a stuck window channel.
 *
 * @param {string} socketPath
 * @param {{ timeoutMs?: number, connect?: typeof createConnection }} [options]
 * @returns {(text: string) => Promise<string>}
 */
export function createHyprlandSocketTransport(socketPath, { timeoutMs = 1000, connect = createConnection } = {}) {
  return (text) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const socket = connect(socketPath);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error === undefined) resolve(Buffer.concat(chunks).toString("utf8"));
        else reject(error);
      };
      const timer = setTimeout(() => finish(new Error(`Hyprland did not answer within ${timeoutMs} ms`)), timeoutMs);
      socket.on("connect", () => socket.write(text));
      socket.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_REPLY_BYTES) {
          finish(new Error("Hyprland's reply was larger than any reply this backend expects"));
          return;
        }
        chunks.push(chunk);
      });
      socket.on("end", () => finish());
      socket.on("close", () => finish());
      socket.on("error", (cause) => finish(new Error(`Hyprland's socket could not be used: ${cause.message}`)));
    });
}
