import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectContainerEngine } from "../src/container-engine.ts";
import { listenOnUnixSocket, prepareSocketPath } from "../src/unix-socket.ts";

/**
 * The transport that does not open a port (V02).
 *
 * A node that only talks to a client on the same machine has no reason to be reachable from the
 * network, so it can listen on a Unix socket instead. Three properties are load-bearing and each is
 * tested here: the file is owner-only, a file left by a crash does not stop the next start, and a file
 * belonging to a *live* node is never removed.
 *
 * These need a POSIX socket, so on Windows they are skipped with the reason named rather than passing
 * quietly. CI runs them on Linux, which is where a node is deployed.
 */

const POSIX = process.platform !== "win32";

let dir: string | undefined;

function socketPath(): string {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-socket-"));
  return join(dir, "node.sock");
}

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe.skipIf(!POSIX)("preparing a socket path (POSIX only: Windows has no Unix domain sockets in Node)", () => {
  it("is ready when nothing is there", async () => {
    const path = socketPath();
    expect(await prepareSocketPath(path)).toEqual({ ok: true, removedStaleFile: false });
  });

  it("clears the file a node left behind when it did not shut down", async () => {
    const path = socketPath();
    // A plain file at the path is what a killed process leaves: the socket file outlives the process.
    writeFileSync(path, "");

    expect(await prepareSocketPath(path)).toEqual({ ok: true, removedStaleFile: true });
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a path another node is listening on rather than taking it away", async () => {
    const path = socketPath();
    const live = createSocketServer();
    await new Promise<void>((resolve) => live.listen(path, resolve));
    try {
      const prepared = await prepareSocketPath(path);
      expect(prepared.ok).toBe(false);
      // The file is still there, because the node that owns it is still running: removing it would leave
      // that node unreachable while it believed it was serving.
      expect(existsSync(path)).toBe(true);
      expect(prepared.ok ? "" : prepared.reason).toMatch(/another node is already listening/);
    } finally {
      await new Promise<void>((resolve) => live.close(() => resolve()));
    }
  });
});

describe.skipIf(!POSIX)("listening on a Unix socket (POSIX only)", () => {
  it("serves a real request and keeps the file owner-only", async () => {
    const path = socketPath();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}\n');
    });

    let cleaned: (() => void) | undefined;
    await new Promise<void>((resolve, reject) => {
      listenOnUnixSocket(server, {
        path,
        onListening: resolve,
        onError: reject,
        // Captured rather than registered: a test must not install a process-wide exit handler.
        onExit: (remove) => {
          cleaned = remove;
        },
      });
    });

    try {
      // The mode is the boundary this transport exists for: a socket created with a permissive umask
      // would be connectable by every account on the host.
      expect(statSync(path).mode & 0o777).toBe(0o600);

      const body = await new Promise<string>((resolve, reject) => {
        const call = httpRequest({ socketPath: path, path: "/readiness", method: "GET" }, (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            text += chunk;
          });
          response.on("end", () => resolve(text));
        });
        call.on("error", reject);
        call.end();
      });
      expect(body).toContain('"ok":true');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleaned?.();
    }

    // And the file does not outlive the node, so the next start does not have to clean up after this one.
    expect(existsSync(path)).toBe(false);
  });

  it("reports a mode it could not narrow instead of keeping quiet about it", async () => {
    const path = socketPath();
    const server = createSocketServer();
    const failures: string[] = [];

    // Resolved on whichever comes first, because a listen that fails never reports itself as listening —
    // waiting only for `onListening` would hang this test rather than fail it.
    await new Promise<void>((resolve) => {
      const settle = (): void => resolve();
      listenOnUnixSocket(server, {
        // A path inside a file cannot be listened on, so the failure path is reachable without mocking the
        // filesystem: the point is that it is reported rather than swallowed.
        path: `${path}/not-a-socket`,
        onListening: settle,
        onError: (cause) => {
          failures.push(cause.message);
          settle();
        },
        onExit: () => undefined,
      });
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(failures.length).toBeGreaterThan(0);
  });
});

describe("the container engine probe", () => {
  it("names the engine and its version when one answers", () => {
    const engine = detectContainerEngine({
      run: (binary) => (binary === "docker" ? { status: 0, stdout: "27.3.1\n" } : { status: 1, stdout: "" }),
    });

    expect(engine.available).toBe(true);
    expect(engine.available ? engine.engine : "").toBe("docker");
    expect(engine.available ? engine.version : "").toBe("27.3.1");
  });

  it("falls through to the second engine when the first is not installed", () => {
    const engine = detectContainerEngine({
      run: (binary) => (binary === "podman" ? { status: 0, stdout: "5.0.0\n" } : { status: 127, stdout: "" }),
    });

    expect(engine.available ? engine.engine : "").toBe("podman");
  });

  it("says what is missing, and names both attempts, when there is no engine", () => {
    const engine = detectContainerEngine({ run: () => ({ status: 127, stdout: "" }) });

    expect(engine.available).toBe(false);
    expect(engine.available ? "" : engine.reason).toBe("requires-container-engine");
    // "No engine" and "an engine that is installed but not answering" need different things done about
    // them, so both attempts are named rather than collapsed into one sentence.
    expect(engine.available ? "" : engine.detail).toMatch(/docker/);
    expect(engine.available ? "" : engine.detail).toMatch(/podman/);
  });

  it("does not treat an engine that exits cleanly and says nothing as available", () => {
    const engine = detectContainerEngine({ run: () => ({ status: 0, stdout: "   \n" }) });
    expect(engine.available).toBe(false);
  });
});
