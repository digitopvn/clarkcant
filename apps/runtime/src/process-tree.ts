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
 *     negative pid reaches all of it. Windows has no groups and uses `taskkill /T`, which kills the tree as it is at
 *     that moment; once the child has exited, the processes it started that are still alive are found by their parent
 *     pid and a creation time between the child's recorded start and exit, and ended too (`sweepWindowsDescendants`).
 *     The window closes at the exit, never at the stop, so a process that later reuses the pid is never reached.
 *   - **Ask, then insist.** SIGTERM first so a process can flush and remove what it wrote, then SIGKILL after a short
 *     grace for one that did not listen. A stop is a person's decision and must work on something that is not
 *     listening, so the second step is not optional; the grace is only how long the first step gets.
 *   - **Only the process that was recorded.** A pid is reused by the kernel once its process is gone, so a pid read
 *     back from the database after a restart is not proof of anything. The start time the kernel records for it is:
 *     the sweep compares the two and leaves alone a pid that now belongs to somebody else.
 */

/** How long a process gets between SIGTERM and SIGKILL. Long enough to flush a file, short enough that a stop is a stop. */
export const STOP_GRACE_MS = 1_500;

/** When a child started and, once this process has heard, when it exited. */
interface Lifetime {
  readonly startedAt: number;
  exitedAt?: number;
}

const lifetimes = new WeakMap<ChildProcess, Lifetime>();

/**
 * Record that `child` has just been started, as soon as `spawn` has returned, and record its exit when it comes.
 *
 * On Windows this is what lets a stop reach a process the child started before the stop and left behind when it
 * exited (`start /b`, or a child the first `taskkill /T` did not see): a process whose parent pid is the child's pid
 * and that was created between the child's start and its exit can only be the child's own. Without it, a stop reaches
 * only what was created after the stop itself. Nothing reads it on POSIX, where the process group already covers both.
 */
export function noteStarted(child: ChildProcess, at: number = Date.now()): void {
  const lifetime: Lifetime = { startedAt: at };
  lifetimes.set(child, lifetime);
  // Heard before the handle this process holds on the child is released, and Windows does not give the pid to another
  // process while that handle is open: nothing created after this moment can be the child's.
  child.once("exit", () => {
    lifetime.exitedAt = Date.now();
  });
}

/**
 * The time a process whose parent pid is `child`'s pid must have been created in to be `child`'s own: from its
 * recorded start to its recorded exit. Undefined until both are known, and then nothing is swept, because a window that
 * ran on past the exit would take in a process that reused the pid, and whatever that process started.
 */
export function childLifetime(child: ChildProcess): { fromMs: number; toMs: number } | undefined {
  const lifetime = lifetimes.get(child);
  if (lifetime?.exitedAt === undefined) return undefined;
  return { fromMs: lifetime.startedAt, toMs: lifetime.exitedAt };
}

/** On Windows, once `child` has exited, end what it left running; nothing when its lifetime is not known. */
function sweepAfterExit(pid: number, child: ChildProcess): void {
  const lifetime = childLifetime(child);
  if (lifetime !== undefined) sweepWindowsDescendants(pid, lifetime.fromMs, lifetime.toMs);
}

/**
 * Send one signal to a process group, falling back to the process itself when the group cannot be reached.
 *
 * `groupOnly` is for a child that has already exited: its pid may now belong to an unrelated process, but its group
 * cannot be taken over while a member of it is alive, so after an exit only the group is signalled and there is no
 * fallback to the bare pid, and no `taskkill` on Windows, where there is no group to reach.
 */
export function signalTree(
  pid: number,
  signal: NodeJS.Signals,
  fallback?: ChildProcess,
  groupOnly: boolean = false,
): boolean {
  // pid 0 is this process's own group and -1 is every process the user can signal: never a child's.
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (process.platform === "win32") {
    if (groupOnly) return false;
    // Windows has no process groups and no gentle signal: `taskkill /T /F` is the whole tree, forcefully, which is
    // what both steps of a stop come to there.
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      // A missing taskkill is reported on the handle, not thrown; unheard, it would crash the node.
      killer.on("error", () => undefined);
      return true;
    } catch {
      return signalOne(pid, signal, fallback);
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return groupOnly ? false : signalOne(pid, signal, fallback);
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
  if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) {
    if (process.platform === "win32") {
      // No group to signal, and the pid may not be the child's any more. What it left running is found by its parent
      // pid, within the child's recorded start and exit; a child whose exit was not recorded gets no sweep.
      sweepAfterExit(pid, child);
      return Promise.resolve();
    }
    // The shell has gone but `sleep 60 &` it started may still hold the output pipes, which is why the caller is still
    // waiting. The group outlives the shell; it gets the same two steps, without ever touching the bare pid.
    return new Promise<void>((resolve) => {
      if (!signalTree(pid, "SIGTERM", undefined, true)) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signalTree(pid, "SIGKILL", undefined, true);
        resolve();
      }, graceMs);
      timer.unref?.();
    });
  }
  if (process.platform === "win32") {
    // `taskkill /T` below ends the tree as it stands when it runs; a child the shell starts after that outlives it.
    // Once the shell has exited, whenever that is (after the grace too, so this listener is never removed), what it
    // left alive is swept. Without a recorded start, the window opens at this stop, which still covers every process
    // created after the kill's snapshot. Recording it here adds its exit listener ahead of the one below.
    if (!lifetimes.has(child)) noteStarted(child);
    child.once("exit", () => sweepAfterExit(pid, child));
  }
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve();
    };
    const onExit = (): void => {
      // The shell has gone, but a grandchild in its group may not have; the group is killed regardless, which costs
      // nothing when the group is already empty.
      signalTree(pid, "SIGKILL", undefined, true);
      finish();
    };
    const timer = setTimeout(() => {
      signalTree(pid, "SIGKILL", child);
      finish();
    }, graceMs);
    // Unref'd so a stop that is still waiting out its grace does not by itself keep a finished process alive.
    timer.unref?.();
    child.once("exit", onExit);
    if (!signalTree(pid, "SIGTERM", child)) finish();
  });
}

/**
 * On Windows, end what a child that has exited left running: the processes it started, and theirs.
 *
 * `taskkill /T` walks the tree as it is when it runs. A shell that starts its command just after that (a `.cmd` shim
 * between being started and starting `node`, `git` or `gh`) leaves the command alive and holding the shell's pipes,
 * and nothing sent to the shell's pid reaches it once the shell has gone. Windows keeps the parent's pid on such a
 * process, so it can still be found. A live process whose parent pid is the child's pid and that was created while the
 * child was alive (`fromMs` to `toMs`, its recorded start and exit) is the child's own: no other process could hold that
 * pid in that time. A process that reused the pid after the exit, and anything it started, is outside the window, and a
 * process created before the start is too. What those processes started is found
 * the same way, from each one's creation, and everything found is ended. The search runs again until a pass finds
 * nothing (five passes at most), so a process started while its parent was being ended is ended as well.
 *
 * Bounded, not airtight: a process whose own parent exited before the search, such as the grandchild of a shell whose
 * child exited first, has no living link back to the child and is not found. A Job Object would reach it, but Node
 * cannot create one without a native addon.
 */
function sweepWindowsDescendants(rootPid: number, fromMs: number, toMs: number): void {
  // 0 is the idle process and 4 is System: never a child's.
  if (!Number.isInteger(rootPid) || rootPid <= 4) return;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
$windows = @{ ${String(rootPid)} = @($epoch.AddMilliseconds(${String(Math.floor(fromMs))}), $epoch.AddMilliseconds(${String(Math.ceil(toMs))})) }
for ($pass = 0; $pass -lt 5; $pass++) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
  $found = @()
  do {
    $grew = $false
    foreach ($p in $all) {
      $id = [int]$p.ProcessId
      if ($windows.ContainsKey($id) -or $null -eq $p.CreationDate) { continue }
      $window = $windows[[int]$p.ParentProcessId]
      if ($null -eq $window) { continue }
      $created = $p.CreationDate.ToUniversalTime()
      if ($created -lt $window[0] -or $created -gt $window[1]) { continue }
      $windows[$id] = @($created, [DateTime]::MaxValue)
      $found += $id
      $grew = $true
    }
  } while ($grew)
  if ($found.Count -eq 0) { break }
  foreach ($id in $found) { Stop-Process -Id $id -Force }
  $ended = [DateTime]::UtcNow
  foreach ($id in $found) { $windows[$id] = @($windows[$id][0], $ended) }
  Start-Sleep -Milliseconds 250
}
`;
  try {
    const sweeper = spawn(
      "powershell.exe",
      // Execution policy governs script files, not `-EncodedCommand`, so there is nothing to bypass.
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, stdio: "ignore" },
    );
    // A missing PowerShell is reported on the handle, not thrown; unheard, it would crash the node.
    sweeper.on("error", () => undefined);
  } catch {
    // Nothing more can be done from here; the first `taskkill` has already run.
  }
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
