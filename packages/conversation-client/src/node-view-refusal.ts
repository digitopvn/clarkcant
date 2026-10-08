import { GatewayError, NODE_NOT_ANSWERING, NodeViewUnreadable } from "./api.ts";
import { fillMessage } from "./i18n/fill-message.ts";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * The node's own sentence for a refusal, without the code in front of it: what a person reads, not a log. A surface
 * puts it after its own words for what did not happen, in the reader's language (`settings.providers.startFailed`,
 * `commandCard.thinking.failed`, ...), so a refusal never reads as `CODE: message`.
 */
export function refusalReason(error: unknown): string {
  if (error instanceof GatewayError) return error.reason;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A refusal as one sentence in the reader's language: `withReason` filled with the node's reason (`refusalReason`), or
 * `fallback` alone when the failure carried no sentence of its own (it was not an `Error`).
 */
export function refusalSentence(error: unknown, t: (key: MessageKey) => string, withReason: MessageKey, fallback: MessageKey): string {
  if (!(error instanceof Error)) return t(fallback);
  return fillMessage(t(withReason), { reason: refusalReason(error) });
}

/**
 * The words for an answer from the node this app does not read (`NodeViewUnreadable`), in the reader's language, or
 * undefined for any other failure.
 *
 * `lead` says what failed and what was preserved, which only the surface knows: a read changed nothing
 * (`shell.nodeView.read`); an action the node answered did something this app cannot read (`shell.nodeView.answered`),
 * which claims neither success nor failure, since a value newer than the app may mean it waits on something; a reconcile
 * the node answered was recorded (`shell.nodeView.recorded`); and a `/develop` start had already started the session. The version sentence after it says what happens next: the node
 * runs a newer Clark, so update the app; or it does not, so this is not a version difference; or a version is not
 * known, so the node is probably newer. Never the schema's own text, which is the contract's words and not the person's.
 */
export function nodeViewRefusalText(cause: unknown, t: (key: MessageKey) => string, lead: MessageKey): string | undefined {
  if (!(cause instanceof NodeViewUnreadable)) return undefined;
  const versions = { node: cause.nodeVersion ?? "", app: cause.appVersion ?? "" };
  const next =
    cause.nodeNewer === true
      ? fillMessage(t("shell.nodeView.newer"), versions)
      : cause.nodeNewer === false
        ? fillMessage(t("shell.nodeView.notNewer"), versions)
        : t("shell.nodeView.unknown");
  return `${t(lead)} ${next}`;
}

/** Statuses that say the request may go through if it is sent again: timed out, too many at once, or not there now. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);

/** Codes this app writes itself for an answer it could not read: the same request would bring the same answer back. */
const UNREADABLE_CODES: ReadonlySet<string> = new Set(["MALFORMED_RESPONSE", "MALFORMED_FRAME"]);

/**
 * Whether the same request, sent again unchanged, can come to something else: the shared status's `next: "retry"`.
 *
 * - Retryable: the request did not reach the node or got no answer in time — a network failure (`fetch` rejects with a
 *   `TypeError`), the node not answering (`NODE_NOT_ANSWERING`), a timeout, a
 *   relay hop or the node being briefly unavailable (408, 429, 502, 503, 504).
 * - Not retryable: anything the node decided — a policy refusal, a conflict, a request it does not accept (every other
 *   4xx) or its own failure (500) — and an answer this app cannot read (`NodeViewUnreadable`), which sending again would
 *   only bring back. Those say why and what to do instead; a Retry beside them would be a control that cannot help.
 *
 * Only the presses whose second sending is safe ask this: the node answers a repeated one with what the first did.
 */
export function retryableFailure(error: unknown): boolean {
  if (error instanceof NodeViewUnreadable) return false;
  if (error instanceof GatewayError) {
    if (error.code === NODE_NOT_ANSWERING) return true;
    return TRANSIENT_STATUSES.has(error.status) && !UNREADABLE_CODES.has(error.code);
  }
  return error instanceof TypeError;
}

/**
 * Whether the node itself answered a request with a refusal it decided: a 4xx it wrote, readable, and not one that
 * says the request timed out or came too soon (`retryableFailure`). A 5xx, an answer this app cannot read (a relay's
 * HTML error page among them), a transport failure and a timeout are not: the node may have done the work behind them.
 */
export function nodeDecidedRefusal(error: unknown): boolean {
  return error instanceof GatewayError && error.status < 500 && !UNREADABLE_CODES.has(error.code) && !retryableFailure(error);
}

/** A failed press's `next`: `retry` only when sending the same press again can go through (`retryableFailure`). */
export function retryNext(error: unknown): { next?: "retry" } {
  return retryableFailure(error) ? { next: "retry" } : {};
}

/**
 * What a pinned live widget says when the node refuses a press or a queued state event: the stale-view notice when the
 * node moved on (`REVISION_MISMATCH`, read from the code, never the sentence), otherwise the node's own reason.
 */
export function liveActionRefusal(cause: unknown, t: (key: MessageKey) => string): string {
  if (cause instanceof GatewayError && cause.code === "REVISION_MISMATCH") return t("shell.live.revisionMismatch");
  return refusalReason(cause);
}