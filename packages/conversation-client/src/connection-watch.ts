import { GatewayError } from "./api.ts";

export type ConnectionState = "connecting" | "ready" | "offline";

/**
 * Why the last check did not reach a working node, in the terms the person is told. `notNode` is something answering
 * at the address that is not a ClarkCant node — a body that is not the gateway's JSON, such as a web server's HTML page.
 * There is no "not allowed" kind: `/health` is the gateway's one unauthenticated route, so a node never refuses it for
 * a missing or stale token.
 */
export type ConnectionFailure = { kind: "unreachable" } | { kind: "timeout" } | { kind: "notNode" } | { kind: "refused"; status: number };

/**
 * What the page knows about the node right now. Every field describes something that happened or is scheduled:
 * `checking` is a request in flight, `nextCheckAt` is a timer that is set, `paused` and `gaveUp` say why no timer is.
 */
export interface ConnectionStatus {
  state: ConnectionState;
  checking: boolean;
  /** Automatic checks that failed in a row; zero once the node answered. A check the person asked for is not counted. */
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
  /**
   * Checks now instead of waiting for the next automatic check. Does nothing while a check runs or once ready. It does
   * not use up the automatic checks: if it fails, the next automatic check waits as long as the one it replaced.
   */
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

  const failed = (failure: ConnectionFailure, automatic: boolean): void => {
    const attempts = automatic ? status.attempts + 1 : status.attempts;
    const base = { state: "offline" as const, checking: false, attempts, failure };
    if (hidden()) {
      emit({ ...base, paused: true });
      return;
    }
    if (attempts >= MAX_AUTOMATIC_CHECKS) {
      emit({ ...base, gaveUp: true });
      return;
    }
    const wait = RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1) - 1, RETRY_DELAYS_MS.length - 1)]!;
    const scheduled = {
      handle: input.setTimer(() => {
        if (retry === scheduled) retry = undefined;
        run(true);
      }, wait),
    };
    retry = scheduled;
    emit({ ...base, nextCheckAt: input.now() + wait });
  };

  const run = (automatic: boolean): void => {
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
        if (!stopped) failed(classify(error, timedOut), automatic);
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
    run(true);
  };
  const unsubscribe = input.visibility?.subscribe(onVisibility);

  if (hidden()) emit({ ...settled(), paused: true });
  else run(true);

  return {
    checkNow: () => run(false),
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
  // A body that is not JSON comes from something other than the gateway: a web server, a captive portal, a proxy's
  // error page. Its status says nothing about the node, so it is not read as the node refusing.
  if (error instanceof GatewayError && error.code === "MALFORMED_RESPONSE") return { kind: "notNode" };
  if (error instanceof GatewayError) return { kind: "refused", status: error.status };
  return { kind: "unreachable" };
}
