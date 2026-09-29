import { type RefObject, useCallback, useEffect, useRef } from "react";

import type { ComposerReference, Notice } from "@clarkcant/contracts";

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
}

export interface InboxNoticeActions {
  askClark: (notice: Notice) => void;
  addToContext: (notice: Notice) => "added" | "already" | "full";
  /** The `inbox.ask` intent: "Ask Clark" about the newest notice, rejecting with the reason when there is none. */
  askAboutLatestNotice: () => Promise<void>;
}

/**
 * What the inbox's "Ask Clark" and "Add to context" do to the conversation, in one place, so the buttons and the
 * spoken or typed "ask Clark about the latest notice" reach the same code.
 *
 * Both carry the notice as the `notice` reference a person could have picked after `@`, never as pasted text: the
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

  return { askClark, addToContext, askAboutLatestNotice };
}
