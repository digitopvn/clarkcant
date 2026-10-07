import { spawn } from "node:child_process";

export interface DirectoryHold {
  /** Whether the holder runs in the directory yet; until it does, nothing is held. */
  readonly holding: () => boolean;
  /** Resolves once the holder runs in the directory. */
  readonly ready: Promise<void>;
  /** Let go of the directory; resolves once the holder has exited. */
  readonly release: () => Promise<void>;
}

/**
 * Hold a directory the way Windows holds one for a moment after a process exits, or while an antivirus or indexer
 * looks at it.
 *
 * A child process runs with the directory as its working directory. On Windows, removing the directory then fails with
 * `EBUSY` or `EPERM` until the child exits; elsewhere the hold changes nothing. The hold starts once the child is
 * running, not when it is spawned, so a test waits for `ready` (or checks `holding`) before it relies on it.
 */
export function holdDirectory(path: string): DirectoryHold {
  const holder = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
    { cwd: path, stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  let running = false;
  const ready = new Promise<void>((resolve, reject) => {
    holder.stdout?.once("data", () => {
      running = true;
      resolve();
    });
    holder.once("error", reject);
  });
  // A caller that only checks `holding` never awaits `ready`; a holder that failed to start is then simply not holding.
  ready.catch(() => undefined);
  const exited = new Promise<void>((resolve) => {
    holder.once("exit", () => resolve());
    holder.once("error", () => resolve());
  });
  return {
    holding: () => running,
    ready,
    release: async () => {
      holder.stdin?.end();
      await exited;
    },
  };
}
