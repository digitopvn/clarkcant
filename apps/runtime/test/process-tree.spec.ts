import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isSameProcess,
  machineBootId,
  noteStarted,
  readProcStartTime,
  signalTree,
  stopTree,
} from "../src/process-tree.ts";

// Fields 3.. of /proc/<pid>/stat; the 20th of them (field 22) is the start time.
const TAIL = "S 1 100 100 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10";

describe("reading a process's identity", () => {
  it("reads the start time after the last parenthesis, whatever the command name contains", () => {
    const read = (): string => `4242 (weird ) name (x)) ${TAIL}`;
    expect(readProcStartTime(4242, read)).toBe("987654");
  });

  it("answers undefined for a pid that is not there or a file it cannot parse", () => {
    const missing = (): string => {
      throw new Error("ENOENT");
    };
    expect(readProcStartTime(4242, missing)).toBeUndefined();
    expect(readProcStartTime(4242, () => "garbage")).toBeUndefined();
    expect(readProcStartTime(-1, () => `1 (x) ${TAIL}`)).toBeUndefined();
  });

  it("treats a pid as the recorded process only when the start time matches", () => {
    const read = (): string => `4242 (sh) ${TAIL}`;
    expect(isSameProcess(4242, "987654", read)).toBe(true);
    // The kernel reused the pid for a process that started later.
    expect(isSameProcess(4242, "123", read)).toBe(false);
  });

  it("reads the machine boot id, and none where the file cannot be read", () => {
    expect(machineBootId(() => "abc-123\n")).toBe("abc-123");
    expect(
      machineBootId(() => {
        throw new Error("not linux");
      }),
    ).toBeUndefined();
  });
});

/**
 * Whether a pid is a live process. A killed process whose parent has gone is reparented to init, and an init that
 * does not reap (a container's often does not) leaves it as a zombie: dead, but still listed.
 */
function isRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

describe.runIf(process.platform === "linux")("stopping a process group", () => {
  it("ends a shell and the child it started, even one that ignores SIGTERM", async () => {
    // The shell starts a grandchild that ignores SIGTERM and reports its pid, then waits on it.
    const child = spawn("sh", ["-c", "sh -c 'trap \"\" TERM; echo $$; exec sleep 60' & wait"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const grandchild = await new Promise<number>((resolve) => {
      child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    expect(isRunning(grandchild)).toBe(true);

    await stopTree(child, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(isRunning(grandchild)).toBe(false);
  });

  it("ends a background grandchild still holding the pipes after the shell itself has exited", async () => {
    // `sleep &` outlives the shell and keeps stdout open, so a caller waiting on 'close' is still waiting.
    const child = spawn("sh", ["-c", "sh -c 'trap \"\" TERM; echo $$; exec sleep 60' & sleep 0.2"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const grandchild = await new Promise<number>((resolve) => {
      child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    await new Promise((resolve) => child.once("exit", resolve));
    expect(isRunning(grandchild)).toBe(true);

    await stopTree(child, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(isRunning(grandchild)).toBe(false);
  });

  it("never signals pid 0 or 1, which would reach this process's group or every process", () => {
    expect(signalTree(0, "SIGTERM")).toBe(false);
    expect(signalTree(1, "SIGTERM")).toBe(false);
    expect(signalTree(-5, "SIGTERM")).toBe(false);
  });

  it("resolves at once for a child that has already exited", async () => {
    const child = spawn("true", [], { detached: true, stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    await expect(stopTree(child, 5_000)).resolves.toBeUndefined();
  });
});

/**
 * Windows has no process groups: a stop is `taskkill /T`, which ends the tree as it stands when it runs. A `.cmd` shim
 * (the `gh` and `pnpm` wrappers are shims) that starts its command just after that leaves the command running with no
 * parent, holding the shim's pipes, so the caller waiting on the command never hears it end.
 *
 * The moment is too narrow to hit on purpose, but the state it leaves is not: ending the shim's own process, which is
 * what `kill` is on Windows, leaves the command exactly as a `taskkill /T` that ran too early would. Each test checks
 * that the stop still ends the command, observed as the shim's pipes closing: `ping -n 30` holds them for about 29
 * seconds, and nothing else does.
 */
describe.runIf(process.platform === "win32")("stopping a command a .cmd shim started, on Windows", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-stop-shim-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Run a shim the way `run_command` runs a command, and resolve once its command is running. */
  async function startShim(): Promise<ChildProcessByStdio<null, Readable, null>> {
    const shim = join(dir, "long.cmd");
    writeFileSync(shim, "@echo off\r\nping -n 30 127.0.0.1\r\n");
    const child = spawn(`"${shim}"`, { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    noteStarted(child);
    // The shim prints nothing itself, so the first output is `ping`'s: from here the command is running.
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    return child;
  }

  function closeOf(child: ChildProcessByStdio<null, Readable, null>): Promise<void> {
    return new Promise<void>((resolve) => child.once("close", () => resolve()));
  }

  it("ends the command a shim left running when the stop comes after the shim has gone", async () => {
    const child = await startShim();
    const closed = closeOf(child);
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));

    const stopped = Date.now();
    await stopTree(child, 200);
    await closed;

    expect(Date.now() - stopped).toBeLessThan(10_000);
  }, 30_000);

  it("ends the command a shim left running when the shim goes while the stop is under way", async () => {
    const child = await startShim();
    const closed = closeOf(child);
    // Gone as far as Windows is concerned, not yet as far as this process has heard: the stop takes its first step on a
    // shim that is still, to it, running.
    child.kill();

    const stopped = Date.now();
    await stopTree(child, 200);
    await closed;

    expect(Date.now() - stopped).toBeLessThan(10_000);
  }, 30_000);

  it("leaves alone a process the shim did not start", async () => {
    const other = spawn("ping", ["-n", "30", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
    try {
      const child = await startShim();
      const closed = closeOf(child);
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      await stopTree(child, 200);
      await closed;

      expect(other.exitCode).toBeNull();
      expect(() => process.kill(other.pid ?? -1, 0)).not.toThrow();
    } finally {
      other.kill();
    }
  }, 30_000);
});
