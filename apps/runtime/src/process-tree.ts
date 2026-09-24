import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Stopping a child process and everything it started.
 *
 * One module for the three places that start processes this node must be able to end — `run_command`, the task
 * worker, and the boot sweep that finds a process a crashed node left behind — because the rules are the same for all
 * of them and a copy that drifted would be the one that leaks:
 *
 *   - **The group, not the child.** A shell's command is the shell's child; a worker's tools are the worker's
 *     children. Every such child is started in its own process group (`detached` on POSIX), so one signal to the
 *     negative pid reaches all of it. Windows has no groups and uses `taskkill /T`.
 *   - **Ask, then insist.** SIGTERM first so a process can flush and remove what it wrote, then SIGKILL after a short
 *     grace for one that did not listen. A stop is a person's decision and must work on something that is not
 *     listening, so the second step is not optional; the grace is only how long the first step gets.
 *   - **Only the process that was recorded.** A pid is reused by the kernel once its process is gone, so a pid read
 *     back from the database after a restart is not proof of anything. The start time the kernel records for it is:
 *     the sweep compares the two and leaves alone a pid that now belongs to somebody else.
 */

/** How long a process gets between SIGTERM and SIGKILL. Long enough to flush a file, short enough that a stop is a stop. */
export const STOP_GRACE_MS = 1_500;

/** Send one signal to a process group, falling back to the process itself when the group cannot be reached. */
export function signalTree(pid: number, signal: NodeJS.Signals, fallback?: ChildProcess): boolean {
  if (process.platform === "win32") {
    // Windows has no process groups and no gentle signal: `taskkill /T /F` is the whole tree, forcefully, which is
    // what both steps of a stop come to there.
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      return true;
    } catch {
      return signalOne(pid, signal, fallback);
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return signalOne(pid, signal, fallback);
  }
}

function signalOne(pid: number, signal: NodeJS.Signals, fallback?: ChildProcess): boolean {
  try {
    if (fallback !== undefined) return fallback.kill(signal);
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a child and its group: SIGTERM now, SIGKILL after the grace if it has not exited.
 *
 * Resolves when the child has exited or the kill has been sent, whichever comes first — never later than the grace
 * plus a moment, because a caller shutting the node down cannot wait on a process that ignores both signals.
 */
export function stopTree(child: ChildProcess, graceMs: number = STOP_GRACE_MS): Promise<void> {
  const pid = child.pid;
  if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) return Promise.resolve();
  if (pid === undefined) {
    // No pid means no group to reach; the handle's own kill is all there is, and it is harmless on a child that never
    // started.
    try {
      child.kill("SIGKILL");
    } catch {
      // Nothing to stop.
    }
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      signalTree(pid, "SIGKILL", child);
      finish();
    }, graceMs);
    // Unref'd so a stop that is still waiting out its grace does not by itself keep a finished process alive.
    timer.unref?.();
    child.once("exit", () => {
      // The shell has gone, but a grandchild in its group may not have; the group is killed regardless, which costs
      // nothing when the group is already empty.
      signalTree(pid, "SIGKILL");
      finish();
    });
    if (!signalTree(pid, "SIGTERM", child)) finish();
  });
}

/**
 * The start time the kernel records for a pid, in clock ticks since boot, or undefined where it cannot be read.
 *
 * Field 22 of `/proc/<pid>/stat`. The command name in field 2 is parenthesised and may itself contain spaces and
 * parentheses, so the fields are counted from the *last* closing parenthesis rather than split from the start.
 * Linux only; elsewhere the answer is undefined, and a caller that cannot prove identity does not kill.
 */
export function readProcStartTime(pid: number, readFile: (path: string) => string = defaultRead): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  let stat: string;
  try {
    stat = readFile(`/proc/${String(pid)}/stat`);
  } catch {
    return undefined;
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  // After ") " come fields 3.. — state is field 3, so starttime (field 22) is index 19 of the remainder.
  const rest = stat.slice(close + 2).trim().split(/\s+/);
  const start = rest[19];
  return start !== undefined && /^\d+$/.test(start) ? start : undefined;
}

/** Whether a pid still names the process that was recorded under it. */
export function isSameProcess(
  pid: number,
  recordedStartTime: string,
  readFile?: (path: string) => string,
): boolean {
  const now = readProcStartTime(pid, readFile);
  return now !== undefined && now === recordedStartTime;
}

/**
 * This boot of the machine, so a pid recorded before a reboot is never compared with one after it.
 *
 * Start times are ticks since boot: after a reboot a small number is likely to match some unrelated process. The boot
 * id changes on every boot, which makes "same boot" a precondition of "same process". Undefined off Linux.
 */
export function machineBootId(readFile: (path: string) => string = defaultRead): string | undefined {
  try {
    const id = readFile("/proc/sys/kernel/random/boot_id").trim();
    return id === "" ? undefined : id;
  } catch {
    return undefined;
  }
}

function defaultRead(path: string): string {
  return readFileSync(path, "utf8");
}
