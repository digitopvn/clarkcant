/**
 * The matching half of both model-supplied patterns a scoped tool matches, in a thread the caller can kill.
 *
 * A JavaScript regular expression has no match-time bound: `/^(a+)+$/` against a long line of `a`s followed
 * by a `b` backtracks for longer than any deadline, and a synchronous `RegExp.test` cannot be interrupted by
 * a timer. A glob is not safe for being a glob: `*?` repeated eleven times translates to eleven `.*.` in a
 * row, and a name that does not end in the letter the pattern ends with makes the expression try every way of
 * splitting the name between them. Project sessions run the adapter in process, so a match in the gateway's
 * own thread holds the whole event loop rather than one tool call. The match runs here instead; the caller's
 * clock decides when to stop waiting, and `worker.terminate()` stops the thread rather than leaving a runaway
 * match burning a core.
 *
 * The protocol carries the pattern and its kind with every batch so this thread keeps no state between them:
 * `{ id, kind, pattern, values }` in, and `{ id, matches }` or `{ id, invalidPattern }` out.
 */

import { parentPort } from "node:worker_threads";

/** Which of the two pattern languages a request is written in. */
export type MatchKind = "regex" | "glob";

/** One batch of values to match, as the caller sends it. */
export interface MatchRequest {
  readonly id: number;
  readonly kind: MatchKind;
  readonly pattern: string;
  readonly values: readonly string[];
}

/** What this thread answers: the indices of the values that matched, or why the pattern could not be used. */
export type MatchResponse =
  | { readonly id: number; readonly matches: number[] }
  | { readonly id: number; readonly invalidPattern: string };

/**
 * The anchored regular expression that matches the same names a glob does.
 *
 * A glob is not a regular expression, so nothing a caller wrote may reach `RegExp` as syntax: every character
 * the engine would read is escaped first, and only then are `*` and `?` given their glob meaning. Escaping the
 * whole pattern is what keeps a model's `[` or `(` matching a bracket or a parenthesis in a file name instead
 * of opening a character class or a group. `*` and `?` are deliberately absent from the escape set: in this
 * glob they are the wildcards.
 */
export function globSource(pattern: string): string {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return `^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`;
}

/** The expression one request asks for, or the reason the pattern cannot be one. */
function compile(request: MatchRequest): RegExp | string {
  try {
    return new RegExp(request.kind === "glob" ? globSource(request.pattern) : request.pattern);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

parentPort?.on("message", (request: MatchRequest) => {
  const expression = compile(request);
  if (typeof expression === "string") {
    parentPort?.postMessage({ id: request.id, invalidPattern: expression } satisfies MatchResponse);
    return;
  }

  const matches: number[] = [];
  for (let index = 0; index < request.values.length; index += 1) {
    if (expression.test(request.values[index] ?? "")) matches.push(index);
  }
  parentPort?.postMessage({ id: request.id, matches } satisfies MatchResponse);
});
