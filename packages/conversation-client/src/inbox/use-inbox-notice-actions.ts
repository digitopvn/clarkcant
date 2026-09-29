import { type RefObject, useCallback, useEffect, useRef } from "react";

import type { ComposerReference, EffectReconcileResponse, Notice } from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import type { MessageKey } from "../i18n/messages.ts";
import type { SendOptions } from "../use-turn-send.ts";
import { noticeReference } from "./inbox-model.ts";

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

  return { askClark, addToContext, askAboutLatestNotice, reconcile };
}
