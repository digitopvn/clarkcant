import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type CommandCardAction,
  type FeedbackPublishIntent,
  type FeedbackRequestInput,
  type SurfaceStatus,
  type WidgetDevFolderForgetResult,
  type WidgetDevSessionView,
  settleSurfaceStatus,
} from "@clarkcant/contracts";

import { type GatewayClient, GatewayError, type Timeline, type WidgetDevSessionRead } from "./api.ts";
import { settleCommandAction } from "./command-card.tsx";
import { canPickFolder, pickFolderOnDesktop } from "./desktop-compact.ts";
import { fillMessage } from "./i18n/fill-message.ts";
import type { MessageKey } from "./i18n/messages.ts";
import { nodeDecidedRefusal, nodeViewRefusalText, refusalReason, refusalSentence, retryNext, retryableFailure } from "./node-view-refusal.ts";
import type { TerminalFirstState } from "./terminal-card.tsx";
import { signInStartRefused, signOutRefused, signOutSettled, useProviderSignIns } from "./use-provider-sign-ins.ts";
import { useModelPickerPort } from "./use-model-picker-port.ts";
import type {
  ArtifactOpenState,
  BlockActions,
  CommandActionState,
  ControlSessionActionState,
  CredentialSaveStatus,
  FeedbackCardState,
  FolderEntryReason,
  PackageInstallState,
  QuestionOutcome,
  TaskStopState,
} from "./blocks.tsx";

export interface BlockActionsDeps {
  client: GatewayClient;
  conversationId: string | undefined;
  timeline: Timeline | undefined;
  applyTimeline: (next: Timeline) => void;
  setError: (message: string | undefined) => void;
  /** The same path as a question: an answer becomes the user's own next message. */
  send: (text: string) => void;
  /**
   * The translator for the current UI language, passed rather than read via `useT()`: this hook is
   * called directly from `Conversation`'s own body, before `Conversation`'s `<LocaleProvider>` — a
   * child of its return, not an ancestor of it — is mounted.
   */
  t: (key: MessageKey) => string;
  /** Opens the inbox on one waiting item: where an install the execution policy asked about is decided. */
  openInbox?: (target: string) => void;
  /** Opens another conversation, as the inbox does: a command card's `Open`. */
  openConversation?: (conversationId: string) => void;
  /** Starts a new conversation and keeps this one, as `/new` does. */
  newConversation?: () => void;
}

/**
 * What a refused install press leaves on its row.
 *
 * A press that sent the listing's `contentDigest` and was answered `DIGEST_MISMATCH` came from a list made before the
 * files changed: pressing the same row again would send the same digest and be refused the same way, and sending none
 * would install files nobody was shown, so the row goes out of date (`stale`) and offers a new search instead. Any
 * other refusal says the node's own reason, where it gave one, in the reader's words: it is the only thing that can say
 * *why* the install stopped.
 */
export function installRefusalState(
  error: unknown,
  contentDigest: string | undefined,
  t: (key: MessageKey) => string,
): PackageInstallState {
  if (contentDigest !== undefined && error instanceof GatewayError && error.code === "DIGEST_MISMATCH") {
    return { status: "stale", message: t("shell.package.filesChangedSinceListing"), staleContentDigest: contentDigest };
  }
  return { status: "refused", message: refusalSentence(error, t, "shell.package.installRefused", "shell.package.installFailed") };
}

/**
 * What a Stop that did not reach the node leaves beside the task: the node's reason in the reader's words. Nothing
 * pretends the request landed, because a stop that did not reach the node has not stopped anything.
 */
export function taskStopRefused(error: unknown, t: (key: MessageKey) => string): TaskStopState {
  return { status: "failed", message: refusalSentence(error, t, "shell.task.stopRefused", "shell.task.stopFailed") };
}

/** What a refused reopen of an artifact says: the node's reason in the reader's words. */
export function artifactOpenRefused(error: unknown, t: (key: MessageKey) => string): ArtifactOpenState {
  return { status: "failed", message: refusalSentence(error, t, "shell.artifact.openRefused", "shell.artifact.openFailed") };
}

/**
 * What a refused take over or hand back says on a browser session: refused rather than reported as done, because a
 * takeover that silently did nothing would leave the person believing they have the wheel while the agent keeps driving.
 */
export function browserSessionRefused(error: unknown, t: (key: MessageKey) => string): ControlSessionActionState {
  return { status: "failed", message: refusalSentence(error, t, "shell.control.sessionChangeRefused", "shell.control.sessionChangeFailed") };
}

/**
 * The reason a feedback press did not go through, for the card's own sentence around it (`feedback.failed`): the node's
 * reason without its code.
 */
export function feedbackRefusalReason(error: unknown, t: (key: MessageKey) => string): string {
  return error instanceof Error ? refusalReason(error) : t("commandCard.failed");
}

/**
 * What a feedback press that did not come back as an answer this app could read settles on.
 *
 * - The node answered the publish, but this app cannot read the answer (`NodeViewUnreadable`): the report may have been
 *   filed or not, so the card says exactly that — never "failed" with the schema's text — and offers Check again, which
 *   only asks the node where the report stands.
 * - The publish was sent and anything but a refusal the node decided came back (`nodeDecidedRefusal`): a dropped
 *   connection, a timeout, a relay's 408/429/502/503/504 including its HTML error page, or the node's own 500, which
 *   can follow a GitHub write that went through. The node may have filed it, so the card says it is not known yet —
 *   never "not filed" — and offers Check again, plus Try again where the press may go through when sent again
 *   (`retryableFailure`). Pressing the publish again is safe: the node answers a report it already holds, or is still
 *   sending, with where it stands and never files it twice.
 * - A Check again that did not go through: a check never files anything, so the report stays not known, with the
 *   reason, and Check again stays offered. Only the node's own answer that it never sent the report (`NOTHING_SENT`)
 *   says it is not on GitHub, in the app's words, because that is the node's fact rather than a guess.
 * - The node answered the preparation and this app cannot read it: nothing was filed. Said in words, with nothing to
 *   repeat, since the same request would bring the same answer back.
 * - Anything else did not get through. A press that did not reach the node or timed out before the publish was sent
 *   offers Try again (`next: "retry"`); a refusal the node decided says its reason and offers nothing to repeat.
 */
export function feedbackPressFailed(
  error: unknown,
  t: (key: MessageKey) => string,
  press: { press: "preview" | "create"; intent?: FeedbackPublishIntent; reportId?: string; requestKey?: string; published: boolean },
): FeedbackCardState {
  const kept = {
    ...(press.reportId === undefined ? {} : { reportId: press.reportId }),
    ...(press.requestKey === undefined ? {} : { requestKey: press.requestKey }),
  };
  if (press.published && press.reportId !== undefined) {
    const notKnown = { status: "unknown" as const, ...kept, reportId: press.reportId };
    const unread = nodeViewRefusalText(error, t, "feedback.unread");
    if (unread !== undefined) return { ...notKnown, message: unread };
    const reason = { reason: feedbackRefusalReason(error, t) };
    if (press.intent === "check") {
      // The node's own answer that it never sent this report is a fact, not a guess: nothing is on GitHub.
      if (error instanceof GatewayError && error.code === "NOTHING_SENT") return { status: "failed", message: t("feedback.check.nothingSent"), ...kept };
      return { ...notKnown, message: fillMessage(t("feedback.notKnown.check"), reason) };
    }
    // Only a refusal the node decided says the report was not filed; anything else may have come after GitHub kept it.
    if (!nodeDecidedRefusal(error)) {
      return {
        ...notKnown,
        message: fillMessage(t("feedback.notKnown.sent"), reason),
        ...(retryableFailure(error) ? { next: "retry" as const } : {}),
        press: "create",
        ...(press.intent === undefined ? {} : { intent: press.intent }),
      };
    }
  }
  const unreadPrepared = nodeViewRefusalText(error, t, "shell.nodeView.read");
  if (unreadPrepared !== undefined) return { status: "failed", message: unreadPrepared, ...kept };
  return {
    status: "failed",
    message: feedbackRefusalReason(error, t),
    ...kept,
    press: press.press,
    ...(press.intent === undefined ? {} : { intent: press.intent }),
    ...retryNext(error),
  };
}

/**
 * Approval refusals this client words itself, by the node's code. The node's own sentence for these is English, and
 * each has a fact the person can act on: the request changed under them (`APPROVAL_FORGED` is what `decideApproval`
 * answers when the digest the approver saw no longer matches), it expired, someone else decided it, or its task moved on.
 */
const APPROVAL_REFUSAL_KEYS: Readonly<Record<string, MessageKey>> = {
  APPROVAL_FORGED: "blocks.approval.changed",
  APPROVAL_DIGEST_MISMATCH: "blocks.approval.changed",
  APPROVAL_STALE: "blocks.approval.changed",
  APPROVAL_EXPIRED: "inbox.decideFailed.expired",
  APPROVAL_ALREADY_DECIDED: "inbox.decideFailed.alreadyDecided",
  TASK_NOT_WAITING: "inbox.decideFailed.taskNotWaiting",
  TASK_NOT_FOUND: "inbox.decideFailed.taskNotFound",
};

/** Question refusals this client words itself, by the node's code; the node's own sentence is in one language only. */
const QUESTION_REFUSAL_KEYS: Readonly<Record<string, MessageKey>> = {
  QUESTION_NOT_FOUND: "inbox.refused.questionGone",
  QUESTION_CLOSED: "inbox.refused.questionClosed",
  INVALID_ANSWER: "blocks.question.invalidAnswer",
};

function wordedRefusal(
  error: unknown,
  t: (key: MessageKey) => string,
  keys: Readonly<Record<string, MessageKey>>,
  withReason: MessageKey,
  fallback: MessageKey,
): string {
  const unreadable = nodeViewRefusalText(error, t, "shell.nodeView.answered");
  if (unreadable !== undefined) return unreadable;
  if (error instanceof GatewayError && Object.hasOwn(keys, error.code)) return t(keys[error.code] as MessageKey);
  return refusalSentence(error, t, withReason, fallback);
}

/** What a refused Allow or Deny on an approval card says, in the reader's language and never as `CODE: message`. */
export function approvalRefusalText(error: unknown, t: (key: MessageKey) => string): string {
  return wordedRefusal(error, t, APPROVAL_REFUSAL_KEYS, "blocks.approval.decideRefused", "blocks.approval.decideFailed");
}

/** What a refused answer to a question card says, in the reader's language and never as `CODE: message`. */
export function questionRefusalText(error: unknown, t: (key: MessageKey) => string): string {
  return wordedRefusal(error, t, QUESTION_REFUSAL_KEYS, "blocks.question.answerRefused", "blocks.question.answerFailed");
}

/**
 * The report a feedback press for these words should act on, when an earlier press already has one: the preview's, or
 * that of a press that did not get through — which the node may already have sent, so preparing a second report for
 * the same words could file it twice. Different words are a different report.
 */
export function feedbackReportToReuse(previous: FeedbackCardState | undefined, requestKey: string): string | undefined {
  if (previous?.status === "prepared" && previous.requestKey === requestKey) return previous.draft.reportId;
  if ((previous?.status === "failed" || previous?.status === "unknown") && previous.reportId !== undefined && previous.requestKey === requestKey) {
    return previous.reportId;
  }
  return undefined;
}

/**
 * What a started widget dev session is doing, said beside the `/develop` card's button: running and placed here,
 * waiting for the person's answer in the inbox, built but not run (with the node's reason), or a first build that
 * failed. Read from the session the node answered with, never assumed from the press.
 */
/**
 * What a press on a `/develop` card came to, and, when the person pressed it, whether the folder was kept as one Clark may
 * use: the node keeps a choice only for the folder itself (`pressed` was its own path, not a link to it) and never for a
 * whole drive or the home folder (`chosenByPerson`).
 */
export function developOutcomeMessage(view: WidgetDevSessionRead, t: (key: MessageKey) => string, pressed?: string): string {
  // A newer node sent more than this app reads: said, so the outcome is never taken for all the node answered.
  const outcome = view.unreadFields === undefined ? sessionOutcome(view, t) : `${sessionOutcome(view, t)} ${t("shell.dev.nodeNewer")}`;
  if (pressed === undefined || view.chosenByPerson === true) return outcome;
  const leadsElsewhere = pressed.trim().replace(/[\\/]+$/u, "").toLowerCase() !== view.root.replace(/[\\/]+$/u, "").toLowerCase();
  const kept = fillMessage(t(leadsElsewhere ? "commandCard.develop.notKeptLink" : "commandCard.develop.notKeptBroad"), { folder: view.root });
  return `${outcome} ${kept}`;
}

/**
 * What a `/develop` start that did not come back as a session the app could read settles on.
 *
 * An answer the app cannot read (`NodeViewUnreadable`) only arrives once the node said yes, so the session started and
 * runs on the node: the card says so, and that this app cannot read its state, with the version advice, rather than
 * "failed" with the schema's text. What the session is doing is not known, so the state is `unknown` (drawn partial),
 * never a success. Any other error is a start that did not happen, said as the node's reason.
 */
export function developStartRefused(error: unknown, t: (key: MessageKey) => string, root?: string): CommandActionState {
  const unread = nodeViewRefusalText(error, t, "commandCard.develop.startedUnread");
  if (unread !== undefined) return { status: "unknown", message: unread };
  // A start for a folder the node already watches picks that session up again, so starting the same folder again is safe.
  const retry = retryableFailure(error) ? { next: "retry" as const, ...(root === undefined ? {} : { root }) } : {};
  return { status: "failed", message: fillMessage(t("commandCard.develop.startFailed"), { reason: refusalReason(error) }), ...retry };
}

/**
 * What a Forget press that did not come back as an answer the app could read settles on.
 *
 * An answer the app cannot read (`NodeViewUnreadable`) means the node answered, but what it said cannot be read: it may
 * not have forgotten the folder, or Clark may still reach it through another. Neither is claimed, so the state is
 * `unknown` rather than done, and the row keeps the badge it was drawn with. Any other error is said as the node's reason.
 */
export function forgetRefused(error: unknown, t: (key: MessageKey) => string): CommandActionState {
  const unread = nodeViewRefusalText(error, t, "shell.nodeView.answered");
  if (unread !== undefined) return { status: "unknown", message: unread };
  return { status: "failed", message: fillMessage(t("commandCard.develop.forgetFailed"), { reason: refusalReason(error) }), ...retryNext(error) };
}

/** What a Forget press did, saying so when the folder stays reachable through a folder that holds it. */
export function forgetOutcomeMessage(result: WidgetDevFolderForgetResult, t: (key: MessageKey) => string): string {
  const folder = result.root;
  if (result.stillCoveredBy !== undefined) {
    return fillMessage(t(result.forgotten ? "commandCard.develop.forgottenCovered" : "commandCard.develop.notChosenCovered"), { folder, cover: result.stillCoveredBy });
  }
  return fillMessage(t(result.forgotten ? "commandCard.develop.forgotten" : "commandCard.develop.notChosen"), { folder });
}

/**
 * The credential card's status after `incoming` arrives, by the contract's rule for late answers: the answer for an
 * earlier submission never replaces a newer one, and a submission's first answer is final.
 */
export function settleCredentialSave(current: CredentialSaveStatus | undefined, incoming: CredentialSaveStatus): CredentialSaveStatus {
  if (current === undefined) return incoming;
  const read = (status: CredentialSaveStatus): SurfaceStatus => ({ phase: status.phase, attempt: status.attempt, freshness: { kind: "snapshot" } });
  const shown = read(current);
  return settleSurfaceStatus(shown, read(incoming)) === shown ? current : incoming;
}

/**
 * What this page held of the conversation when it opened it, so a card can tell a message it is drawing again (a reload,
 * a conversation opened from the list) from one that arrived while the person was here.
 *
 * - `loading`: an existing conversation was opened and its first page has not arrived yet.
 * - `held`: its first page arrived; `through` is the node's time of the newest message in it. Anything newer arrived in
 *   this page session, and anything at or before it (older pages included) is history.
 * - `new`: the conversation started here, or the page moved on from the one it opened (`/new`, one that no longer
 *   exists), so every message arrived in this page session.
 */
export type ConversationOpening =
  | { kind: "loading"; conversationId: string }
  | { kind: "held"; conversationId: string; through: number }
  | { kind: "new" };

export function nextConversationOpening(
  current: ConversationOpening,
  conversationId: string | undefined,
  timeline: Timeline | undefined,
): ConversationOpening {
  if (current.kind === "new") return current;
  if (conversationId !== current.conversationId) return { kind: "new" };
  if (current.kind === "held" || timeline === undefined || timeline.conversationId !== conversationId) return current;
  const through = timeline.messages.reduce((newest, message) => Math.max(newest, Date.parse(message.createdAt)), Number.NEGATIVE_INFINITY);
  return { kind: "held", conversationId, through };
}

/**
 * Terminals a message that arrived in this page session opened: the person just asked for them, so the state each card
 * first settles on (a failure included) is news and is announced. A terminal only in history is not.
 */
export function freshTerminalIds(timeline: Timeline | undefined, opening: ConversationOpening): string[] {
  if (timeline === undefined || opening.kind === "loading") return [];
  const fresh: string[] = [];
  for (const message of timeline.messages) {
    if (opening.kind === "held" && !(Date.parse(message.createdAt) > opening.through)) continue;
    for (const block of message.blocks) {
      if (block.type === "terminal-session-card" && typeof block.terminalId === "string") fresh.push(block.terminalId);
    }
  }
  return fresh;
}

/**
 * Which terminal cards announce their first state, over one page life of a conversation.
 *
 * A terminal the person asked for while here (`freshTerminalIds`) is news the first time its card settles. After that,
 * a card drawn again for it, as when its row scrolls out of the transcript and back, mounts quiet like any other history:
 * the person was already told. A card that left before it settled was never heard, so it is still news when it returns.
 */
export class TerminalAnnouncements implements TerminalFirstState {
  #opening: ConversationOpening;
  #fresh: readonly string[] = [];
  readonly #told = new Set<string>();

  constructor(conversationId: string | undefined) {
    this.#opening = conversationId === undefined ? { kind: "new" } : { kind: "loading", conversationId };
  }

  /** Moves on with the present timeline; gives the terminals still to be announced. */
  advance(conversationId: string | undefined, timeline: Timeline | undefined): readonly string[] {
    this.#opening = nextConversationOpening(this.#opening, conversationId, timeline);
    this.#fresh = freshTerminalIds(timeline, this.#opening).filter((terminalId) => !this.#told.has(terminalId));
    return this.#fresh;
  }

  isNews(terminalId: string): boolean {
    return !this.#told.has(terminalId) && this.#fresh.includes(terminalId);
  }

  settled(terminalId: string): void {
    this.#told.add(terminalId);
  }
}

type RowStates<T> = Readonly<Record<string, T>>;

/**
 * Save the secrets typed on one credential card, saying "saving" first so the answer is a change the card says even
 * when it is the same answer as last time. Each card's status is settled on its own entry (keyed by request id), so a
 * save on one card never drops another card's answer as an earlier attempt.
 */
export function submitCredentialSave(
  deps: {
    client: Pick<GatewayClient, "putCredential">;
    t: (key: MessageKey) => string;
    nextAttempt: () => number;
    update: (update: (current: RowStates<CredentialSaveStatus>) => RowStates<CredentialSaveStatus>) => void;
  },
  input: { requestId: string; fields: { name: string; value: string; description?: string; consumer?: string }[] },
): void {
  const { t, update } = deps;
  const { requestId } = input;
  const attempt = deps.nextAttempt();
  const settle = (next: Omit<CredentialSaveStatus, "requestId" | "attempt">): void =>
    update((current) => ({
      ...current,
      [requestId]: settleCredentialSave(Object.hasOwn(current, requestId) ? current[requestId] : undefined, { ...next, requestId, attempt }),
    }));
  settle({ phase: "pending", message: t("shell.credential.saving") });
  deps.client
    .putCredential({ fields: input.fields })
    .then((result) =>
      settle({
        phase: "success",
        message: result.names.length === 0 ? t("shell.credential.sentNoName") : t("shell.credential.saved").replace("{names}", result.names.join(", ")),
      }),
    )
    .catch(() =>
      // The failure message says nothing about what was typed. An error that repeated the
      // value would be the leak this card exists to prevent.
      settle({ phase: "error", message: t("shell.credential.saveFailed") }),
    );
}

/** What a press on a command card needs, without React: `useBlockActions` wires it to its state. */
export interface CommandPressDeps {
  client: Pick<GatewayClient, "writePreference" | "startWidgetDevSession" | "forgetWidgetDevFolder" | "nodeOnThisMachine">;
  conversationId: string | undefined;
  t: (key: MessageKey) => string;
  /** The next attempt: one count for every press on every card, so a later press is always a later attempt. */
  nextAttempt: () => number;
  /** Applies a change to what each press came to, keyed `cardId/rowId/actionId`. */
  updateActions: (update: (current: RowStates<CommandActionState>) => RowStates<CommandActionState>) => void;
  /** Applies a change to the rows asking for a folder's path in words. */
  updateFolderEntries: (update: (current: RowStates<FolderEntryReason>) => RowStates<FolderEntryReason>) => void;
  startSignIn: (key: string, providerId: string, method: "oauth" | "api_key") => Promise<void>;
  signOut: (providerId: string) => Promise<{ signedOut: boolean }>;
  openConversation?: (conversationId: string) => void;
  newConversation?: () => void;
}

export interface CommandPresses {
  press: (input: { cardId: string; rowId: string; actionId: string; action: CommandCardAction }) => void;
  /** A folder path typed on a row: a press of its own, so a new attempt for the row. */
  developTyped: (input: { cardId: string; rowId: string; actionId: string; root: string }) => void;
}

/**
 * What the buttons on a command card do. Each press is an attempt of its own and every answer is settled against the
 * press it belongs to (`settleCommandAction`), so a late answer for an earlier press never replaces a newer one, and a
 * press that ends without an outcome of its own (a sign-in the panel takes over, a dialog closed) clears only itself.
 * A refusal is said in the reader's language with the node's reason, never as `CODE: message`.
 *
 * Plain functions rather than hooks, so these rules are testable without rendering.
 */
export function commandPresses(deps: CommandPressDeps): CommandPresses {
  const { client, t } = deps;
  const settle = (key: string, attempt: number, state: CommandActionState): void =>
    deps.updateActions((current) => ({ ...current, [key]: settleCommandAction(current[key], { ...state, attempt }) }));
  /** Clears `key` when it still holds `attempt`: a newer press keeps what it says. */
  const clear = (key: string, attempt: number): void =>
    deps.updateActions((current) => {
      if (current[key]?.attempt !== attempt) return current;
      const { [key]: _cleared, ...rest } = current;
      return rest;
    });

  /**
   * Start a widget dev session for a folder the person named on a card: on the person-only route, as them, placing the
   * widget in this conversation. What the node answered is said beside the button; the node's own reason when it refused.
   */
  const develop = (key: string, root: string, attempt: number): void => {
    deps.updateFolderEntries((current) => {
      const { [key]: _answered, ...rest } = current;
      return rest;
    });
    const { conversationId } = deps;
    if (conversationId === undefined) {
      settle(key, attempt, { status: "failed", message: t("commandCard.failed") });
      return;
    }
    settle(key, attempt, { status: "pending" });
    void client.startWidgetDevSession({ root, conversationId }).then(
      (view) => settle(key, attempt, { status: "done", message: developOutcomeMessage(view, t, root) }),
      (error: unknown) => settle(key, attempt, developStartRefused(error, t, root)),
    );
  };

  const press: CommandPresses["press"] = ({ cardId, rowId, actionId, action }) => {
    const key = `${cardId}/${rowId}/${actionId}`;
    const attempt = deps.nextAttempt();
    const settleThis = (state: CommandActionState): void => settle(key, attempt, state);
    switch (action.kind) {
      case "open-conversation":
        deps.openConversation?.(action.conversationId);
        return;
      case "new-conversation":
        deps.newConversation?.();
        return;
      case "set-thinking":
        settleThis({ status: "pending" });
        void client.writePreference("ai.thinkingLevel", action.level).then(
          () => settleThis({ status: "done", message: t("commandCard.thinking.set") }),
          (error: unknown) =>
            settleThis({
              status: "failed",
              message: fillMessage(t("commandCard.thinking.failed"), { reason: refusalReason(error) }),
              ...retryNext(error),
            }),
        );
        return;
      case "provider-sign-in":
        settleThis({ status: "pending" });
        // Once started, the sign-in panel says where it stands; a start that failed says why, in the person's words.
        void deps.startSignIn(`${cardId}/${rowId}`, action.providerId, action.method).then(
          () => clear(key, attempt),
          (error: unknown) => settleThis(signInStartRefused(error, t)),
        );
        return;
      case "provider-sign-out":
        settleThis({ status: "pending" });
        // The same words Settings says for the same answer: what changed, or that the credential is still there and why.
        void deps.signOut(action.providerId).then(
          (result) => settleThis(signOutSettled(result, t)),
          (error: unknown) => settleThis(signOutRefused(error, t)),
        );
        return;
      case "develop-folder": {
        if (action.root !== undefined) {
          develop(key, action.root, attempt);
          return;
        }
        // The OS dialog when it names a folder on the node; the path in words otherwise, and said why.
        const reason: FolderEntryReason | undefined = !canPickFolder() ? "browser" : !client.nodeOnThisMachine() ? "remote-node" : undefined;
        if (reason !== undefined) {
          deps.updateFolderEntries((current) => ({ ...current, [key]: reason }));
          return;
        }
        settleThis({ status: "pending" });
        void pickFolderOnDesktop(t("commandCard.develop.dialogTitle")).then((picked) => {
          if (picked.kind === "picked") {
            develop(key, picked.path, attempt);
            return;
          }
          clear(key, attempt);
          if (picked.kind === "failed") deps.updateFolderEntries((current) => ({ ...current, [key]: "dialog-failed" }));
        });
        return;
      }
      case "develop-folder-forget":
        settleThis({ status: "pending" });
        void client.forgetWidgetDevFolder(action.root).then(
          (result) => settleThis({ status: "done", message: forgetOutcomeMessage(result, t) }),
          (error: unknown) => settleThis(forgetRefused(error, t)),
        );
        return;
    }
  };

  return {
    press,
    developTyped: ({ cardId, rowId, actionId, root }) => develop(`${cardId}/${rowId}/${actionId}`, root, deps.nextAttempt()),
  };
}

function sessionOutcome(view: WidgetDevSessionView, t: (key: MessageKey) => string): string {
  const folder = view.root;
  const { activation } = view;
  if (activation.state === "active") return fillMessage(t("commandCard.develop.running"), { folder });
  if (activation.state === "awaiting-approval") return fillMessage(t("commandCard.develop.awaitingApproval"), { folder });
  if (activation.state === "refused") return fillMessage(t("commandCard.develop.refused"), { folder, reason: activation.message });
  if (view.lastBuild?.ok === false) {
    const reason = view.lastBuild.diagnostics.map((entry) => entry.message).join("; ");
    return fillMessage(t("commandCard.develop.buildFailed"), { folder, reason });
  }
  return fillMessage(t("commandCard.develop.watching"), { folder });
}

/**
 * Every action a card in the transcript can take, as one object.
 *
 * A card is a pure function of the props it is given — asserted directly by its own test file —
 * so every stateful thing a card needs (which approval is deciding, what an install attempt came
 * to, what the node said about a stop request) lives here instead, one state per kind of card,
 * with one handler each. `blocks.tsx` renders the transcript; this hook is what the buttons in it
 * actually do.
 */
export function useBlockActions({
  client,
  conversationId,
  timeline,
  applyTimeline,
  setError,
  send,
  t,
  openInbox,
  openConversation,
  newConversation,
}: BlockActionsDeps): BlockActions {
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | undefined>(undefined);

  /**
   * Which terminals the person asked for while here, and which of those were already told (`TerminalAnnouncements`).
   * Kept for the page life of this conversation and advanced during render: the opening it holds is a pure function of
   * the last one and the present timeline, and gives itself back once settled, so a repeated render changes nothing.
   */
  const [terminalAnnouncements] = useState(() => new TerminalAnnouncements(conversationId));
  useMemo(() => terminalAnnouncements.advance(conversationId, timeline), [terminalAnnouncements, conversationId, timeline]);

  const decideApproval = useCallback(
    (input: { approvalId: string; digest: string; decision: "granted" | "denied" }) => {
      if (conversationId === undefined) return;
      setDecidingApprovalId(input.approvalId);
      setError(undefined);
      void client
        .decideApproval(conversationId, input.approvalId, { decision: input.decision, digest: input.digest })
        .then((result) => applyTimeline(result.timeline))
        .catch((cause: unknown) => setError(approvalRefusalText(cause, t)))
        .finally(() => setDecidingApprovalId(undefined));
    },
    [applyTimeline, client, conversationId, setError, t],
  );

  /**
   * The answer being composed, and the question whose answer is on its way.
   *
   * Both live here rather than in the card because the card is a pure function of what it is
   * given: state inside it would be a second copy of a fact this conversation already tracks, and
   * the two would disagree after a reload. The draft is cleared the moment an answer leaves, so a
   * card never re-offers what was just sent.
   */
  const [questionDraft, setQuestionDraft] = useState<
    { questionId: string; chosen: string[]; text: string } | undefined
  >(undefined);
  const [questionPendingId, setQuestionPendingId] = useState<string | undefined>(undefined);

  const answerQuestion = useCallback(
    (input: { questionId: string; text?: string; optionIds?: string[]; confirmed?: boolean }) => {
      if (conversationId === undefined) return;
      setError(undefined);
      setQuestionPendingId(input.questionId);
      setQuestionDraft(undefined);
      void client
        .answerQuestion(conversationId, input.questionId, input)
        .then((result) => applyTimeline(result.timeline))
        .catch((cause: unknown) => {
          // The answer never reached the node, so the card may be tried again rather than staying disabled.
          setQuestionPendingId(undefined);
          setError(questionRefusalText(cause, t));
        });
    },
    [applyTimeline, client, conversationId, setError, t],
  );

  /**
   * Approvals that already have a receipt in this transcript, and which of them were refused.
   *
   * The card in storage stays `pending` because messages are never rewritten, so the decision is
   * read from the receipt instead: the operation the user approved carries its approval id, and so
   * does the record a refusal leaves.
   */
  const { decidedApprovals, deniedApprovals } = useMemo(() => {
    const decided = new Set<string>();
    const denied = new Set<string>();
    for (const message of timeline?.messages ?? []) {
      for (const block of message.blocks) {
        if (block.type !== "tool-activity") continue;
        const args = (block.args ?? {}) as Record<string, unknown>;
        if (typeof args.approvalId !== "string") continue;
        decided.add(args.approvalId);
        if (args.decision === "denied") denied.add(args.approvalId);
      }
    }
    return { decidedApprovals: [...decided], deniedApprovals: [...denied] };
  }, [timeline]);

  /**
   * Questions this transcript already has an answer for.
   *
   * The same derivation as `decidedApprovals`, for the same reason: a card in storage keeps saying
   * `waiting` because messages are never rewritten, and the record the node wrote when the answer
   * arrived is what says otherwise. Without it a reload would offer the question again.
   */
  const { answeredQuestions, questionOutcomes } = useMemo(() => {
    // The latest record wins: a question that expired and was then asked again reads as asked again.
    const outcomes: Record<string, QuestionOutcome> = {};
    for (const message of timeline?.messages ?? []) {
      for (const block of message.blocks) {
        if (block.type !== "tool-activity" || block.name !== "ask_user_question") continue;
        const args = (block.args ?? {}) as Record<string, unknown>;
        if (typeof args.questionId !== "string") continue;
        const decision = args.decision;
        outcomes[args.questionId] =
          decision === "cancelled" || decision === "expired" || decision === "asked-again" ? decision : "answered";
      }
    }
    return { answeredQuestions: Object.keys(outcomes), questionOutcomes: outcomes };
  }, [timeline]);

  /*
   * Once the transcript carries the record of the answer, nothing is in flight any more. The card
   * reads that record rather than a flag of its own, which is what keeps a reload from leaving a
   * card disabled forever.
   */
  useEffect(() => {
    if (questionPendingId === undefined) return;
    if (answeredQuestions.includes(questionPendingId)) setQuestionPendingId(undefined);
  }, [answeredQuestions, questionPendingId]);

  /**
   * What the node said about the last secret submitted through each card, keyed by the card's request id.
   *
   * Held here rather than in the card because the card is a message in a transcript: it is
   * re-rendered from stored blocks on every load, and a status that lived inside it would change
   * what history says. This is a fact about now, so it lives with the other facts about now. One
   * entry per card, so two cards saving at once each say what became of their own save.
   */
  const [credentialStatus, setCredentialStatus] = useState<Readonly<Record<string, CredentialSaveStatus>>>({});
  const credentialAttempts = useRef(0);

  const submitCredential = useCallback(
    (input: {
      requestId: string;
      fields: { name: string; value: string; description?: string; consumer?: string }[];
    }): void =>
      submitCredentialSave({ client, t, nextAttempt: () => ++credentialAttempts.current, update: setCredentialStatus }, input),
    [client, t],
  );
  /**
   * Cards that may still be answered: a question's or a form's id, while nothing has come after
   * the message that asked. Derived from the transcript rather than tracked as state, because the
   * messages are history and are never rewritten: a card that stayed live would invite a second
   * answer the node would take as a second message.
   */
  const openCardIds = useMemo(() => {
    const messages = timeline?.messages ?? [];
    let lastUserIndex = -1;
    messages.forEach((message, index) => {
      if (message.role === "user") lastUserIndex = index;
    });
    const questions: string[] = [];
    const forms: string[] = [];
    messages.forEach((message, index) => {
      if (index <= lastUserIndex) return;
      for (const block of message.blocks) {
        const record = block as Record<string, unknown>;
        if (record.type === "question-card" && typeof record.questionId === "string") questions.push(record.questionId);
        if (record.type === "form-card" && typeof record.formId === "string") forms.push(record.formId);
      }
    });
    return { questions, forms };
  }, [timeline]);

  /**
   * What the node said about each stop request.
   *
   * Held here rather than in the card because the card is asserted directly by its own test file
   * and has to stay a pure function of its props, and because one place should own the call.
   */
  const [taskStop, setTaskStop] = useState<Record<string, TaskStopState>>({});

  const stopTask = useCallback(
    (taskId: string) => {
      setTaskStop((current) => ({ ...current, [taskId]: { status: "pending" } }));
      void client.cancelTask(taskId).then(
        (result) =>
          setTaskStop((current) => ({
            ...current,
            [taskId]: { status: "requested", state: result.state, confirmed: result.confirmed },
          })),
        // Reported beside the control that caused it, and the task is left alone.
        (error: unknown) => setTaskStop((current) => ({ ...current, [taskId]: taskStopRefused(error, t) })),
      );
    },
    [client, t],
  );

  /**
   * What the node still holds for each artifact somebody reopened.
   *
   * `opened` carries facts rather than a status, because the interesting answer is not "it worked"
   * but what the node has: an artifact can expire between the message that mentioned it and
   * somebody reading it, and the snapshot in the transcript cannot know that.
   */
  const [artifactOpen, setArtifactOpen] = useState<Record<string, ArtifactOpenState>>({});

  const openArtifact = useCallback(
    (artifactId: string) => {
      setArtifactOpen((current) => ({ ...current, [artifactId]: { status: "pending" } }));
      void client.artifact(artifactId).then(
        (result) => {
          const { artifact } = result;
          setArtifactOpen((current) => ({
            ...current,
            [artifactId]: {
              status: "opened",
              digest: artifact.digest,
              sizeBytes: artifact.sizeBytes,
              mimeType: artifact.mimeType,
              originNodeId: artifact.originNodeId,
              createdAt: artifact.createdAt,
              expiresAt: artifact.expiresAt,
              expired: artifact.expired,
            },
          }));
        },
        (error: unknown) => setArtifactOpen((current) => ({ ...current, [artifactId]: artifactOpenRefused(error, t) })),
      );
    },
    [client, t],
  );

  /**
   * What became of each install attempt, keyed by package id.
   *
   * Four outcomes rather than a boolean, because they are four different things to tell someone: it
   * is happening, it happened, a decision is needed before it can happen, or it was refused with a
   * reason. "Not installed" would collapse the middle two, and one of those is waiting on the
   * reader while the other is not.
   */
  const [packageInstall, setPackageInstall] = useState<Record<string, PackageInstallState>>({});

  const installPackage = useCallback(
    ({
      packageId,
      version,
      contentDigest,
      sourceId,
    }: {
      packageId: string;
      version: string;
      contentDigest?: string;
      sourceId?: string;
    }) => {
      setPackageInstall((current) => ({ ...current, [packageId]: { status: "installing" } }));
      void client.installPackage(packageId, version, contentDigest, sourceId).then(
        (answer) => {
          setPackageInstall((current) => ({
            ...current,
            [packageId]:
              answer.code === "APPROVAL_REQUIRED"
                ? {
                    status: "approval-required",
                    // Where to decide it, in the person's language, rather than the policy's own reason in the node's.
                    message: t("shell.package.approvalRequired"),
                    ...(answer.approvalId === undefined ? {} : { approvalId: answer.approvalId }),
                  }
                : {
                    status: "installed",
                    message: t("shell.package.installed"),
                    ...(answer.generationId === undefined ? {} : { generationId: answer.generationId }),
                    ...(answer.verified === undefined ? {} : { verified: answer.verified }),
                  },
          }));
        },
        (error: unknown) => {
          setPackageInstall((current) => ({ ...current, [packageId]: installRefusalState(error, contentDigest, t) }));
        },
      );
    },
    [client, t],
  );

  /**
   * What the node said after a verb was applied to a browser session.
   *
   * `taken-over` carries the epoch, because the epoch is the evidence that the takeover took
   * effect: the agent's already-planned action is refused for having a stale lease. A boolean here
   * would show that a button worked without showing that the browser changed hands.
   */
  const [controlSession, setControlSession] = useState<Record<string, ControlSessionActionState>>({});

  const changeBrowserSession = useCallback(
    (sessionId: string, verb: "takeover" | "stop") => {
      setControlSession((current) => ({ ...current, [sessionId]: { status: "pending" } }));
      const call = verb === "takeover" ? client.controlTakeover(sessionId) : client.controlStop(sessionId);
      void call.then(
        (result) =>
          setControlSession((current) => ({
            ...current,
            [sessionId]:
              verb === "takeover"
                ? { status: "taken-over", leaseEpoch: result.session.leaseEpoch }
                : { status: "stopped" },
          })),
        (error: unknown) => setControlSession((current) => ({ ...current, [sessionId]: browserSessionRefused(error, t) })),
      );
    },
    [client, t],
  );

  /**
   * What a press on a command card came to, keyed `cardId/rowId/actionId`, and the sign-ins a card started, keyed
   * `cardId/rowId`. A sign-in is followed by reading it again while it runs: the provider decides when it moves on — a
   * browser page finishing, a code arriving — so the card asks rather than guesses.
   */
  const [commandAction, setCommandAction] = useState<Record<string, CommandActionState>>({});
  /**
   * Counts presses, so each one is an attempt of its own and an answer is settled against the press it belongs to. Kept
   * here rather than in `commandPresses`, so a runner made again (a new language, a new conversation) keeps counting
   * above the attempts already shown instead of starting below them.
   */
  const commandAttempts = useRef(0);
  const {
    signIns,
    start: startSignIn,
    reattach: reattachSignIns,
    answer: answerSignIn,
    cancel: cancelSignIn,
    signOut: signOutProvider,
  } = useProviderSignIns(client, setError);
  /** A `/login` row opened again shows the sign-in the node still runs for its provider, rather than nothing. */
  const reattachSignIn = useCallback(
    ({ key, providerId }: { key: string; providerId: string }) =>
      reattachSignIns((view) => (view.providerId === providerId ? key : undefined)),
    [reattachSignIns],
  );

  /** The model picker a `/model` card draws and a sign-in offers next. */
  const modelPicker = useModelPickerPort(client, t);

  /** Rows of a `/develop` card asking for a folder's path in words, and why (`FolderEntryReason`). */
  const [folderEntries, setFolderEntries] = useState<Record<string, FolderEntryReason>>({});

  const presses = useMemo(
    () =>
      commandPresses({
        client,
        conversationId,
        t,
        nextAttempt: () => ++commandAttempts.current,
        updateActions: setCommandAction,
        updateFolderEntries: setFolderEntries,
        startSignIn,
        signOut: signOutProvider,
        ...(openConversation === undefined ? {} : { openConversation }),
        ...(newConversation === undefined ? {} : { newConversation }),
      }),
    [client, conversationId, newConversation, openConversation, signOutProvider, startSignIn, t],
  );

  /**
   * The Feedback Composer and its results, keyed by card id. Preview prepares the report and keeps the draft beside the
   * words it was made from; Create issue publishes that draft when the words are unchanged, and prepares again when they
   * are not. The outcome is the node's: a result card in the timeline, never a state this hook invents.
   */
  const [feedback, setFeedback] = useState<Record<string, FeedbackCardState>>({});
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const settleFeedback = useCallback(
    (cardId: string, state: FeedbackCardState) => setFeedback((current) => ({ ...current, [cardId]: state })),
    [],
  );
  const previewFeedback = useCallback(
    ({ cardId, request }: { cardId: string; request: FeedbackRequestInput }) => {
      const requestKey = JSON.stringify(request);
      settleFeedback(cardId, { status: "preparing" });
      void client.prepareFeedback(request, conversationId).then(
        (prepared) => settleFeedback(cardId, { status: "prepared", requestKey, ...prepared }),
        (error: unknown) => settleFeedback(cardId, feedbackPressFailed(error, t, { press: "preview", requestKey, published: false })),
      );
    },
    [client, conversationId, settleFeedback, t],
  );

  const createFeedback = useCallback(
    ({ cardId, request, reportId, intent = "send" }: { cardId: string; request?: FeedbackRequestInput; reportId?: string; intent?: FeedbackPublishIntent }) => {
      if (conversationId === undefined) return;
      const previous = feedbackRef.current[cardId];
      const requestKey = request === undefined ? undefined : JSON.stringify(request);
      settleFeedback(cardId, { status: "publishing", intent });
      // The report this press is about. A press that did not get through keeps its report, so pressing again for the
      // same words acts on that one — which the node may already have sent — and never prepares a second.
      let acting: string | undefined = reportId;
      // Whether the publish itself was asked: only its answer can leave a report filed or not without this app knowing.
      let published = false;
      const reportOf = async (): Promise<string> => {
        if (reportId !== undefined) return reportId;
        if (request === undefined || requestKey === undefined) throw new Error(t("commandCard.failed"));
        return feedbackReportToReuse(previous, requestKey) ?? (await client.prepareFeedback(request, conversationId)).draft.reportId;
      };
      void reportOf()
        .then((id) => {
          acting = id;
          published = true;
          return client.publishFeedback(id, conversationId, { intent, answers: cardId });
        })
        .then(
          (result) => {
            applyTimeline(result.timeline);
            settleFeedback(cardId, { status: "done", publication: result.publication });
          },
          (error: unknown) =>
            settleFeedback(
              cardId,
              feedbackPressFailed(error, t, {
                press: "create",
                intent,
                published,
                ...(acting === undefined ? {} : { reportId: acting }),
                ...(requestKey === undefined ? {} : { requestKey }),
              }),
            ),
        );
    },
    [applyTimeline, client, conversationId, settleFeedback, t],
  );

  /** Feedback cards a later result card answers: read from the transcript, which is never rewritten. */
  const answeredFeedbackCards = useMemo(() => {
    const answered = new Set<string>();
    for (const message of timeline?.messages ?? []) {
      for (const block of message.blocks) {
        if (block.type !== "feedback-card") continue;
        const answers = (block as { answers?: unknown }).answers;
        if (typeof answers === "string") answered.add(answers);
      }
    }
    return [...answered];
  }, [timeline]);

  return useMemo<BlockActions>(
    () => ({
      onApprovalDecide: decideApproval,
      decidedApprovals,
      deniedApprovals,
      onQuestionAnswer: answerQuestion,
      answeredQuestions,
      questionOutcomes,
      ...(questionDraft === undefined ? {} : { questionDraft }),
      onQuestionDraft: (input) =>
        setQuestionDraft((current) => {
          const sameQuestion = current?.questionId === input.questionId;
          return {
            questionId: input.questionId,
            chosen: input.chosen === undefined ? (sameQuestion ? current.chosen : []) : [...input.chosen],
            text: input.text === undefined ? (sameQuestion ? current.text : "") : input.text,
          };
        }),
      ...(questionPendingId === undefined ? {} : { questionPendingId }),
      ...(decidingApprovalId === undefined ? {} : { decidingApprovalId }),
      onCredentialSubmit: submitCredential,
      credentialStatus,
      /*
       * A chosen answer is sent as the user's own message — the same call the composer makes — so a
       * click and a typed reply are one act. Nothing here invents a second route into the agent for
       * a click to take.
       */
      onFormSubmit: ({ summary }) => void send(summary),
      openFormIds: openCardIds.forms,
      onTaskStop: ({ taskId }) => stopTask(taskId),
      taskStop,
      onArtifactOpen: ({ artifactId }) => openArtifact(artifactId),
      artifactOpen,
      onInstallPackage: installPackage,
      packageInstall,
      ...(openInbox === undefined ? {} : { onOpenInbox: openInbox }),
      // The card's own search again, sent the way a typed request is, so the agent lists the files as they are now.
      onSearchAgain: ({ query }) => void send(t("blocks.marketplace.searchAgainMessage").replace("{query}", query)),
      onControlTakeover: ({ sessionId }) => changeBrowserSession(sessionId, "takeover"),
      onControlStop: ({ sessionId }) => changeBrowserSession(sessionId, "stop"),
      controlSession,
      // A terminal's result goes back the way a typed reply does, for the reason forms do.
      onTerminalShare: ({ text }) => void send(text),
      terminalFirstState: terminalAnnouncements,
      onCommandAction: presses.press,
      commandAction,
      signIns,
      onSignInAnswer: answerSignIn,
      onSignInCancel: cancelSignIn,
      onSignInReattach: reattachSignIn,
      ...(conversationId === undefined ? {} : { onFeedbackPreview: previewFeedback, onFeedbackCreate: createFeedback }),
      feedback,
      answeredFeedbackCards,
      folderEntries,
      onFolderEntrySubmit: presses.developTyped,
      onFolderEntryCancel: ({ key }) =>
        setFolderEntries((current) => {
          const { [key]: _closed, ...rest } = current;
          return rest;
        }),
      ...modelPicker,
    }),
    [
      modelPicker,
      answeredFeedbackCards,
      conversationId,
      createFeedback,
      feedback,
      previewFeedback,
      answerSignIn,
      cancelSignIn,
      reattachSignIn,
      folderEntries,
      terminalAnnouncements,
      commandAction,
      presses,
      signIns,
      artifactOpen,
      controlSession,
      changeBrowserSession,
      credentialStatus,
      decideApproval,
      decidedApprovals,
      deniedApprovals,
      decidingApprovalId,
      installPackage,
      openArtifact,
      openCardIds,
      openInbox,
      packageInstall,
      questionDraft,
      questionPendingId,
      send,
      stopTask,
      submitCredential,
      t,
      taskStop,
    ],
  );
}
