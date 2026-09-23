import { Worker } from "node:worker_threads";

import type { MatchKind, MatchRequest, MatchResponse } from "./pattern-match-worker.ts";

/**
 * The caller's half of every model-supplied pattern this package matches, with a clock on it.
 *
 * `pattern-match-worker.ts` explains why a match is not run in this process. What is here is the part that
 * makes the boundary real: one worker thread per pattern, a wall-clock budget for the whole matching phase,
 * and `terminate()` when the budget runs out. The thread is killed rather than left to finish, because a
 * pattern whose match time grows faster than its input does not finish.
 *
 * Both tools that carry a pattern a model wrote use this, each with the budget its own work deserves: the
 * grep matcher tests every line of every file it searches, the find matcher tests the names one traversal
 * collected. Neither is matched in the gateway's own thread, where a runaway match would hold the whole event
 * loop rather than one tool call.
 *
 * Batches are matched one at a time and in order: an answer is only useful for the input it was asked about,
 * so the requests are serialised rather than interleaved, and the budget is shared by all of them.
 */

/** Why a batch of values could not be matched. Each one is a different sentence to the caller. */
export type MatchFailure =
  | "invalid-pattern"
  | "budget-exceeded"
  | "matcher-failed";

/** The indices of the values in one batch that matched, or why there is no answer. */
export type MatchOutcome =
  | { readonly ok: true; readonly matches: readonly number[] }
  | { readonly ok: false; readonly kind: MatchFailure; readonly reason: string };

/** A matcher bound to one pattern, for the length of one tool call. */
export interface PatternMatcher {
  /** Match one batch of values. Called again after a failure, it fails the same way. */
  match: (values: readonly string[]) => Promise<MatchOutcome>;
  /** Terminate the thread. Idempotent, so a `finally` can always call it. */
  dispose: () => Promise<void>;
}

/** The worker is created inside `startPatternMatcher`, so a module that cannot be loaded is reported there. */
export function startPatternMatcher(input: {
  kind: MatchKind;
  pattern: string;
  budgetMs: number;
}): PatternMatcher {
  /*
   * The thread is created here rather than lazily, and the deadline runs from here, so the cost of starting
   * it is inside the budget rather than in front of it. `parentPort` in the worker keeps it alive until
   * `terminate()`, which is what lets several batches be matched by one thread.
   */
  const worker = new Worker(new URL("./pattern-match-worker.ts", import.meta.url), {
    // Named so a thread left in a stack dump says what it is rather than looking like a leak.
    name: "clarkcant-pattern-matcher",
  });
  const deadline = Date.now() + input.budgetMs;
  const waiting = new Map<number, (answer: MatchResponse | undefined, failure?: string) => void>();
  let nextId = 0;
  let stopped: string | undefined;

  const stop = (reason: string): void => {
    stopped = reason;
    const pending = [...waiting.entries()];
    waiting.clear();
    for (const [, resolve] of pending) resolve(undefined, reason);
  };

  worker.on("message", (answer: MatchResponse) => {
    const resolve = waiting.get(answer.id);
    if (resolve === undefined) return;
    waiting.delete(answer.id);
    resolve(answer);
  });
  /*
   * A thread that fails to start, throws, or exits early leaves a caller waiting for an answer that is never
   * coming. Both events are reported as the failure of every request in flight rather than as silence.
   */
  worker.on("error", (cause) => stop(cause instanceof Error ? cause.message : String(cause)));
  worker.on("exit", (code) => {
    if (stopped === undefined && waiting.size > 0) stop(`the matching thread exited with code ${code}`);
  });

  const fail = (kind: MatchFailure, reason: string): MatchOutcome => ({ ok: false, kind, reason });

  return {
    async match(values: readonly string[]): Promise<MatchOutcome> {
      if (stopped !== undefined) return fail("matcher-failed", stopped);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        stopped = `the ${input.budgetMs} ms matching budget was already spent`;
        return fail("budget-exceeded", stopped);
      }

      nextId += 1;
      const id = nextId;
      const request: MatchRequest = { id, kind: input.kind, pattern: input.pattern, values };
      const answer = await new Promise<MatchOutcome>((resolve) => {
        const timer = setTimeout(() => {
          /*
           * The budget is the whole matching phase, so an expiry ends the call rather than this batch: a
           * thread that did not answer inside its clock is not asked again, and the thread is killed here
           * because a runaway match does not stop on its own.
           */
          const expired = `the pattern did not finish matching within the ${input.budgetMs} ms matching budget`;
          waiting.delete(id);
          /*
           * The rejection is consumed rather than left to escape: this is the call that is killing the
           * thread, so a `terminate()` that rejects has no answer to give that the expiry has not already
           * given. An unattached rejection would surface as an unhandled one in the gateway's process.
           */
          worker.terminate().catch(() => undefined);
          stop(expired);
          resolve(fail("budget-exceeded", expired));
        }, remaining);

        waiting.set(id, (message, failure) => {
          clearTimeout(timer);
          if (message === undefined) {
            resolve(fail("matcher-failed", failure ?? "the matching thread stopped without an answer"));
            return;
          }
          if ("invalidPattern" in message) {
            resolve(fail("invalid-pattern", message.invalidPattern));
            return;
          }
          resolve({ ok: true, matches: message.matches });
        });

        worker.postMessage(request);
      });

      return answer;
    },

    async dispose(): Promise<void> {
      waiting.clear();
      // A `dispose` runs in a `finally`, where a rejection would replace the answer the caller already has.
      await worker.terminate().catch(() => undefined);
    },
  };
}
