import { GatewayError, NodeViewUnreadable } from "./api.ts";
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
