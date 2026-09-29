import type { SignalInput } from "@clarkcant/contracts";

/**
 * What every signal source provides, whoever wrote it.
 *
 * A provider's delivery is its own business: its headers, its signature scheme, its payload shapes. What leaves an
 * adapter is the one generic `SignalInput` the automation core matches, so the core never learns a provider's name and
 * a new source is a new adapter rather than a change to matching. The same contract serves a built-in source and one a
 * person writes for their own setup.
 */

/** A delivery as it arrived: the headers, and the body exactly as sent — a signature is over bytes, not over JSON. */
export interface SourceDelivery {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  rawBody: Uint8Array;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export type NormalizeResult =
  /** One fact worth recording. */
  | { kind: "signal"; signal: SignalInput }
  /** The source checking the connection works. Answered, never recorded. */
  | { kind: "ping" }
  /** A well-formed delivery this adapter does not turn into a signal, with why. Answered, never recorded. */
  | { kind: "ignored"; reason: string }
  /** A delivery that is not what the source sends. */
  | { kind: "invalid"; reason: string };

export interface NormalizeContext {
  /** Accounts that are this node itself: a signal one of them caused is marked `selfGenerated`. Compared case-insensitively. */
  selfLogins: readonly string[];
  /** The node's clock, for a delivery that does not say when it happened. */
  now: () => string;
}

export interface PollResult {
  /** Oldest first, so recording them in order keeps the order they happened in. */
  signals: SignalInput[];
  /** Where the next poll starts. Unchanged when nothing new arrived. */
  cursor: string | undefined;
}

export interface SignalSourceAdapter {
  /** The provider name signals carry in `source.provider`. */
  readonly provider: string;
  /** Whether the delivery came from who it claims, checked before anything in it is read. */
  verify(delivery: SourceDelivery, secret: string): VerifyResult;
  normalize(delivery: SourceDelivery, context: NormalizeContext): NormalizeResult;
}

/**
 * Asking a source for what happened since a cursor, for a node the source cannot reach — no public URL, a laptop behind
 * a router. Same signals as a delivery, with their own dedupe keys.
 */
export interface SignalPoller {
  readonly provider: string;
  poll(cursor: string | undefined): Promise<PollResult>;
}

/** One header, whatever case it arrived in and however many times. */
export function headerValue(headers: SourceDelivery["headers"], name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}
