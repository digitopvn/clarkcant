import { type RefObject, useCallback, useEffect, useRef } from "react";

import type {
  ComposerReference,
  EffectReconcileResponse,
  Notice,
  NoticeOperationId,
  NoticeOperationResponse,
  NoticeOperationSource,
} from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import type { MessageKey } from "../i18n/messages.ts";
import { nodeViewRefusalText } from "../node-view-refusal.ts";
import type { SendOptions } from "../use-turn-send.ts";
import { capabilitiesSay, noticeRefusalReason, noticeReference, snoozeUntil } from "./inbox-model.ts";

export interface InboxNoticeActionsDeps {
  client: GatewayClient;
  busy: boolean;
  inboxOpen: boolean;
  closeInbox: () => void;
  send: (text: string, options?: SendOptions) => Promise<void>;
  insertReference: (key: string, ref: ComposerReference) => "added" | "already" | "full";
  composerInput: RefObject<HTMLTextAreaElement | null>;
  t: (key: MessageKey) => string;
  /** Re-reads the conversation on screen, so the reply a recorded answer adds to it appears. */
  refreshTimeline: () => void;
  /** Tells the header's inbox count that something changed. */
  onInboxChanged: () => void;
  /** Tells an open inbox panel to read again, because something outside it changed a notice. */
  refreshInboxPanel: () => void;
  /** The UI language, for the time a snooze ends. */
  locale: "vi" | "en";
}

export interface InboxNoticeActions {
  askClark: (notice: Notice) => void;
  addToContext: (notice: Notice) => "added" | "already" | "full";
  /** The `inbox.ask` intent: "Ask Clark" about the newest notice, rejecting with the reason when there is none. */
  askAboutLatestNotice: () => Promise<void>;
  /**
   * Records whether an effect whose outcome was unknown took effect, through the one person-only route
   * (`POST /effects/:effectId/reconcile`). The inbox's two buttons and the typed or spoken "it took effect" both land
   * here, so the three cannot drift apart. Rejects with the node's error, `EFFECT_NOT_UNKNOWN` included.
   */
  reconcile: (effectId: string, outcome: "confirmed" | "failed", source: "click" | "chat" | "voice") => Promise<EffectReconcileResponse>;
  /**
   * The `notice.act` intent: one of a notice's own actions, carried out by the node's notice-action route — the one MCP,
   * `clarkcant api` and both agents reach — after the node named the notice. Resolves to the sentence saying what the node
   * did, and rejects with the reason, in the reader's language, when it did not. A snooze from a sentence lasts an hour,
   * the menu's first choice. `source` says how the person asked: a press, a typed sentence or a spoken one; the node
   * records it with the action.
   */
  actOnNotice: (noticeId: string, action: NoticeOperationId, source: NoticeOperationSource) => Promise<string>;
}

/**
 * What the inbox's "Ask Clark" and "Add to context" do to the conversation, in one place, so the buttons and the
 * spoken or typed "ask Clark about the latest notice" reach the same code.
 *
 * Both carry the notice as a `notice` composer reference, never as pasted text: like a reference chosen after `@`, the
 * node checks it again when the message arrives and briefs the turn from what it has stored, quoting the notice's
 * words as data.
 */
export function useInboxNoticeActions({
  client,
  busy,
  inboxOpen,
  closeInbox,
  send,
  insertReference,
  composerInput,
  t,
  refreshTimeline,
  onInboxChanged,
  refreshInboxPanel,
  locale,
}: InboxNoticeActionsDeps): InboxNoticeActions {
  // Closing the inbox hands focus back to whatever opened it. After "Add to context" the person is about to write,
  // so focus goes to the composer instead — once the dialog has put it back, which is why this is an effect here:
  // the dialog's own clean-up runs before its parent's effects.
  const focusComposerOnClose = useRef(false);
  useEffect(() => {
    if (inboxOpen || !focusComposerOnClose.current) return;
    focusComposerOnClose.current = false;
    composerInput.current?.focus();
  }, [inboxOpen, composerInput]);

  const askClark = useCallback(
    (notice: Notice) => {
      closeInbox();
      // A message of its own: whatever is being written, and the chips on it, stay as they are.
      void send(t("inbox.ask.prompt"), { references: [noticeReference(notice).ref] });
    },
    [closeInbox, send, t],
  );

  const addToContext = useCallback(
    (notice: Notice) => {
      const { key, ref } = noticeReference(notice);
      const result = insertReference(key, ref);
      if (result !== "full") {
        focusComposerOnClose.current = true;
        closeInbox();
      }
      return result;
    },
    [closeInbox, insertReference],
  );

  const askAboutLatestNotice = useCallback(async () => {
    if (busy) throw new Error(t("inbox.ask.busy"));
    const latest = (await client.inbox()).notices[0];
    if (latest === undefined) throw new Error(t("inbox.ask.none"));
    askClark(latest);
  }, [busy, client, askClark, t]);

  const reconcile = useCallback(
    async (effectId: string, outcome: "confirmed" | "failed", source: "click" | "chat" | "voice") => {
      const answer = await client.reconcileEffect(effectId, outcome, source);
      // The node said so in the task's conversation and dismissed the notice; both are read back from it.
      refreshTimeline();
      onInboxChanged();
      return answer;
    },
    [client, refreshTimeline, onInboxChanged],
  );

  const actOnNotice = useCallback(
    async (noticeId: string, action: NoticeOperationId, source: NoticeOperationSource): Promise<string> => {
      let until: string | undefined;
      if (action === "snooze") {
        // "In 1 hour" always has a time; the check is the preset's own contract.
        const end = snoozeUntil("hour", new Date());
        if (end === undefined) throw new Error(t("inbox.snooze.gone"));
        until = end.toISOString();
      }
      let answer: NoticeOperationResponse;
      try {
        answer = await client.actOnNotice(noticeId, action, { ...(until === undefined ? {} : { until }), source });
      } catch (cause) {
        // Carried out by the node, which answered; only its answer is one this app does not read, and said so.
        const unread = nodeViewRefusalText(cause, t, "shell.nodeView.acted");
        if (unread !== undefined) return unread;
        // Worded from the node's code in the reader's language; a restore that fails leaves the notice dismissed.
        const reason = noticeRefusalReason(cause, t);
        throw new Error(t(action === "restore" ? "inbox.act.undoFailed" : "inbox.act.failed").replace("{reason}", reason), { cause });
      } finally {
        // Whatever happened, the list and the count are read again: a refusal can mean the notice changed elsewhere.
        onInboxChanged();
        refreshInboxPanel();
      }
      // Retrying and asking again add to a conversation; the one on screen shows it without waiting for its next read.
      if (action === "retry" || action === "ask-again") refreshTimeline();
      return noticeOperationSay(answer, t, locale);
    },
    [client, t, locale, onInboxChanged, refreshInboxPanel, refreshTimeline],
  );

  return { askClark, addToContext, askAboutLatestNotice, reconcile, actOnNotice };
}

/** What the node did, in the panel's own words for the same action, so a sentence and a press are answered alike. */
export function noticeOperationSay(answer: NoticeOperationResponse, t: (key: MessageKey) => string, locale: "vi" | "en"): string {
  switch (answer.action) {
    case "mark-read":
      return t("inbox.markedRead");
    case "mark-unread":
      return t("inbox.markedUnread");
    case "dismiss":
      return t("inbox.dismissed");
    case "restore":
      return t("inbox.restored");
    case "snooze": {
      const time =
        answer.snoozedUntil === undefined
          ? ""
          : new Date(answer.snoozedUntil).toLocaleString(locale === "vi" ? "vi-VN" : "en-US", { weekday: "long", hour: "2-digit", minute: "2-digit" });
      return t("inbox.snoozed").replace("{time}", time);
    }
    case "unsnooze":
      return t("inbox.unsnoozed");
    case "suppress":
      return t("inbox.suppressed");
    case "unsuppress":
      return t("inbox.unsuppressed");
    case "retry":
      return answer.state === "queued" && answer.position !== undefined
        ? t("inbox.retryQueued").replace("{position}", String(answer.position))
        : t("inbox.retried");
    case "update":
      return answer.outcome === "approval-required"
        ? t("inbox.updateNeedsApproval")
        : `${t("inbox.act.updated").replace("{version}", answer.version ?? "")}${capabilitiesSay(answer, t)}`;
    case "skip-version":
      return t("inbox.skipped").replace("{version}", answer.version ?? "");
    case "ask-again":
      return t("inbox.askedAgain");
    default: {
      const unhandled: never = answer.action;
      return unhandled;
    }
  }
}
