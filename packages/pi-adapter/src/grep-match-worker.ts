/**
 * The matching half of `clarkcant_grep`, in a thread the caller can terminate.
 *
 * A JavaScript regular expression has no match-time bound: `/^(a+)+$/` against a long line of `a`s followed
 * by a `b` backtracks for longer than any deadline, and a synchronous `RegExp.test` cannot be interrupted by
 * a timer. Project sessions run the adapter in process, so a match in the gateway's own thread would hold the
 * whole event loop rather than one tool call. The match runs here instead; the caller's clock decides when to
 * stop waiting, and `worker.terminate()` stops the thread rather than leaving a runaway match burning a core.
 *
 * The protocol carries the pattern with every batch so this thread keeps no state between them:
 * `{ id, pattern, lines }` in, and `{ id, matches }` or `{ id, invalidPattern }` out.
 */

import { parentPort } from "node:worker_threads";

/** One batch of lines to match, as the caller sends it. */
export interface GrepMatchRequest {
  readonly id: number;
  readonly pattern: string;
  readonly lines: readonly string[];
}

/** What this thread answers: the indices of the lines that matched, or why the pattern could not be used. */
export type GrepMatchResponse =
  | { readonly id: number; readonly matches: number[] }
  | { readonly id: number; readonly invalidPattern: string };

parentPort?.on("message", (request: GrepMatchRequest) => {
  let expression: RegExp;
  try {
    expression = new RegExp(request.pattern);
  } catch (cause) {
    parentPort?.postMessage({
      id: request.id,
      invalidPattern: cause instanceof Error ? cause.message : String(cause),
    } satisfies GrepMatchResponse);
    return;
  }

  const matches: number[] = [];
  for (let index = 0; index < request.lines.length; index += 1) {
    if (expression.test(request.lines[index] ?? "")) matches.push(index);
  }
  parentPort?.postMessage({ id: request.id, matches } satisfies GrepMatchResponse);
});
