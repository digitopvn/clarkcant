import { GatewayError } from "./api.ts";

export type ConnectionState = "connecting" | "ready" | "offline";

/** Why the last check did not reach a working node, in the terms the person is told. */
export type ConnectionFailure = { kind: "unreachable" } | { kind: "timeout" } | { kind: "refused"; status: number };

/**
 * What the page knows about the node right now. Every field describes something that happened or is scheduled:
 * `checking` is a request in flight, `nextCheckAt` is a timer that is set, `paused` and `gaveUp` say why no timer is.
 */
export interface ConnectionStatus {
  state: ConnectionState;
  checking: boolean;
  /** Checks that failed in a row; zero once the node answered. */
  attempts: number;
  failure?: ConnectionFailure;
  /** Epoch milliseconds of the next automatic check. Absent when none is scheduled. */
  nextCheckAt?: number;
  /** The page is hidden, so no automatic check runs until it is shown again. */
  paused?: true;
  /** The automatic checks ran out; only the person, or the page being shown again, starts another. */
  gaveUp?: true;
}

/** The waits between automatic checks: doubling at first, then capped, so a node that is down is not hammered. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** How long one check may take before it counts as unanswered. */
export const CHECK_TIMEOUT_MS = 10_000;
/** Checks in a row, the first included, before the page stops checking on its own — about seven and a half minutes. */
export const MAX_AUTOMATIC_CHECKS = 20;

export interface PageVisibility {
  isHidden(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface ConnectionWatchInput {
  check: (signal: AbortSignal) => Promise<unknown>;
  onChange: (status: ConnectionStatus) => void;
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Absent where there is no page to hide, which then counts as always shown. */
  visibility?: PageVisibility;
  timeoutMs?: number;
}

export interface ConnectionWatch {
  /** Checks now instead of waiting for the next automatic check. Does nothing while a check runs or once ready. */
  checkNow(): void;
  /** Cancels the timers and the check in flight; nothing is reported after this. */
  stop(): void;
}

/**
 * Checks whether the node answers, and keeps checking with a capped backoff until it does.
 *
 * The first check runs at once. A failed check schedules the next one after `RETRY_DELAYS_MS`, up to
 * `MAX_AUTOMATIC_CHECKS` in a row, after which the page stops checking on its own and says so. Nothing runs while the
 * page is hidden; showing it again checks at once and starts the backoff over. Once the node answers, the watch has
 * nothing left to do and holds no timer.
 */
export function watchConnection(input: ConnectionWatchInput): ConnectionWatch {
  const timeoutMs = input.timeoutMs ?? CHECK_TIMEOUT_MS;
  let status: ConnectionStatus = { state: "connecting", checking: false, attempts: 0 };
  let stopped = false;
  let inFlight: AbortController | undefined;
  let retry: { handle: unknown } | undefined;

  const emit = (next: ConnectionStatus): void => {
    status = next;
    if (!stopped) input.onChange(next);
  };
  const hidden = (): boolean => input.visibility?.isHidden() ?? false;
  const clearRetry = (): void => {
    if (retry !== undefined) input.clearTimer(retry.handle);
    retry = undefined;
  };
  /** The status without anything about a schedule, for a moment when the schedule changes. */
  const settled = (): ConnectionStatus => ({
    state: status.state,
    checking: false,
    attempts: status.attempts,
    ...(status.failure === undefined ? {} : { failure: status.failure }),
  });

  const failed = (failure: ConnectionFailure): void => {
    const attempts = status.attempts + 1;
    const base = { state: "offline" as const, checking: false, attempts, failure };
    if (hidden()) {
      emit({ ...base, paused: true });
      return;
    }
    if (attempts >= MAX_AUTOMATIC_CHECKS) {
      emit({ ...base, gaveUp: true });
      return;
    }
    const wait = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
    const scheduled = {
      handle: input.setTimer(() => {
        if (retry === scheduled) retry = undefined;
        run();
      }, wait),
    };
    retry = scheduled;
    emit({ ...base, nextCheckAt: input.now() + wait });
  };

  const run = (): void => {
    if (stopped || inFlight !== undefined || status.state === "ready") return;
    clearRetry();
    const controller = new AbortController();
    inFlight = controller;
    let timedOut = false;
    const timeout = input.setTimer(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    emit({ ...settled(), checking: true });
    const finish = (): void => {
      input.clearTimer(timeout);
      if (inFlight === controller) inFlight = undefined;
    };
    input.check(controller.signal).then(
      () => {
        finish();
        if (!stopped) emit({ state: "ready", checking: false, attempts: 0 });
      },
      (error: unknown) => {
        finish();
        if (!stopped) failed(classify(error, timedOut));
      },
    );
  };

  const onVisibility = (): void => {
    if (stopped || status.state === "ready") return;
    if (hidden()) {
      clearRetry();
      if (inFlight === undefined) emit({ ...settled(), paused: true });
      return;
    }
    // The person is looking again: check at once, and give the backoff a fresh start.
    status = { ...settled(), attempts: 0 };
    run();
  };
  const unsubscribe = input.visibility?.subscribe(onVisibility);

  if (hidden()) emit({ ...settled(), paused: true });
  else run();

  return {
    checkNow: run,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearRetry();
      unsubscribe?.();
      inFlight?.abort();
    },
  };
}

/** A document's visibility as the watch reads it. */
export function documentVisibility(doc: EventTarget & { readonly visibilityState: string }): PageVisibility {
  return {
    isHidden: () => doc.visibilityState === "hidden",
    subscribe: (listener) => {
      doc.addEventListener("visibilitychange", listener);
      return () => doc.removeEventListener("visibilitychange", listener);
    },
  };
}

function classify(error: unknown, timedOut: boolean): ConnectionFailure {
  if (timedOut) return { kind: "timeout" };
  if (error instanceof GatewayError) return { kind: "refused", status: error.status };
  return { kind: "unreachable" };
}
