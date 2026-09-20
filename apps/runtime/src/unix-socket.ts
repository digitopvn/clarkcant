import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { connect, type Server } from "node:net";

/**
 * Listening on a Unix socket instead of a TCP port.
 *
 * A node that only ever talks to a client on the same machine has no reason to open a port: a port is
 * reachable by every process on the host and by anything that can route to it, while a socket file is
 * reachable by whoever the file's mode allows. The gateway is token-authenticated either way, so this
 * is not the only boundary — it is the one that stops the question being asked at all.
 *
 * Three things make this more than a different argument to `listen`:
 *
 * - **The file's mode.** A socket created with the process umask is world-connectable on a host with a
 *   permissive one, which is the same mistake the blob store avoids with `mode: 0o600`. It is set
 *   explicitly rather than inherited.
 * - **A file left by a crash.** `listen` refuses an existing path, so a node that died without cleaning
 *   up cannot start again. The stale file is removed — but only after checking that nothing is actually
 *   listening, because removing a live node's socket would leave that node unreachable while it is
 *   still running.
 * - **Cleaning up on exit.** A socket file outlives its process, so the next start is the one that pays
 *   for it. It is removed on the way out, and `prepareSocketPath` covers the case where it is not.
 */

export type SocketPreparation =
  | { ok: true; removedStaleFile: boolean }
  | { ok: false; reason: string };

/** Is something accepting connections on this path right now? */
async function socketIsLive(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = connect(path);
    let settled = false;
    const settle = (live: boolean): void => {
      if (settled) return;
      settled = true;
      probe.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref();
    probe.once("connect", () => {
      clearTimeout(timer);
      settle(true);
    });
    probe.once("error", () => {
      clearTimeout(timer);
      settle(false);
    });
  });
}

/**
 * Make the path ready to listen on.
 *
 * A file that exists is either a live node or the remains of one that did not shut down cleanly, and
 * the two are told apart by asking it rather than by assuming. Refusing on a live socket is the honest
 * answer: two nodes on one socket would be one node answering for the other's identity.
 */
export async function prepareSocketPath(path: string, timeoutMs = 1000): Promise<SocketPreparation> {
  if (!existsSync(path)) return { ok: true, removedStaleFile: false };

  if (await socketIsLive(path, timeoutMs)) {
    return {
      ok: false,
      reason: `another node is already listening on ${path}`,
    };
  }

  try {
    unlinkSync(path);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: `the socket file at ${path} could not be removed: ${detail}` };
  }
  return { ok: true, removedStaleFile: true };
}

export interface UnixSocketOptions {
  path: string;
  /** Called once the socket is accepting, the same way the port path reports itself. */
  onListening: () => void;
  onError: (cause: Error) => void;
  /** Injected so a test can watch the cleanup without exiting a process. */
  onExit?: (remove: () => void) => void;
}

/**
 * Listen on the socket, owner-only, and arrange for the file to be gone afterwards.
 *
 * `chmod` runs after `listen` because the file does not exist before it; the window between the two is
 * the process's own startup, before it has answered anything.
 */
export function listenOnUnixSocket(server: Server, options: UnixSocketOptions): void {
  server.on("error", options.onError);
  server.listen(options.path, () => {
    try {
      chmodSync(options.path, 0o600);
    } catch (cause) {
      // A socket whose mode could not be narrowed is reported rather than kept quiet: the whole point
      // of the socket is that the file's mode is the boundary.
      options.onError(new Error(`the socket at ${options.path} could not be made owner-only`, { cause }));
    }
    options.onListening();
  });

  const remove = (): void => {
    try {
      if (existsSync(options.path)) unlinkSync(options.path);
    } catch {
      // Nothing useful can be done on the way out, and throwing here would replace the exit reason.
    }
  };
  (options.onExit ?? ((cleanup) => process.once("exit", cleanup)))(remove);
}
