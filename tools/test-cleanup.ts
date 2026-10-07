/**
 * Cleanup for suites whose tests drive real processes, such as git or Chromium, inside a temporary directory.
 *
 * Two things go wrong on Windows when many of these suites run at once, and each helper here answers one.
 */

import { rm } from "node:fs/promises";
import { it } from "vitest";

/**
 * Remove a test's temporary directory, retrying while Windows still holds a file in it.
 *
 * A process that just exited can keep a handle open for a moment: a closed Chromium's helper processes, or a git that
 * had the directory as its working directory. Removal then fails with `EPERM` until the handle is gone.
 *
 * This is the promise form on purpose. Under Node 24 on Windows, `rmSync` reports a locked file as `EPERM` at once and
 * ignores `maxRetries`, so a synchronous removal with retries is a removal without them. `fs.promises.rm` waits
 * `retryDelay` longer after each failed attempt, about five seconds over ten attempts.
 */
export async function removeTestDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * `it`, with a time budget for the whole file and a way for cleanup to wait for a test that is still running.
 *
 * When a test runs out of time, Vitest reports it and runs the cleanup hooks, but the test's body keeps running: a git
 * command or a browser it started is still working in the directory the hooks are about to remove. `settled()` waits
 * until every body this `it` started has finished, so a hook that awaits it first never removes a directory from under
 * a running test, or closes a database one is still writing to.
 */
export function trackedTests(budgetMs: number): {
  it: (name: string, body: () => unknown, timeoutMs?: number) => void;
  settled: () => Promise<void>;
} {
  const running = new Set<Promise<unknown>>();
  return {
    it(name, body, timeoutMs = budgetMs) {
      it(
        name,
        async () => {
          const run = Promise.resolve().then(body);
          running.add(run);
          try {
            await run;
          } finally {
            running.delete(run);
          }
        },
        timeoutMs,
      );
    },
    async settled() {
      await Promise.allSettled([...running]);
    },
  };
}
