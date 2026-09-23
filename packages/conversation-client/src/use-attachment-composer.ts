import { useCallback, useReducer, useState } from "react";

import type { GatewayClient } from "./api.ts";
import {
  attachmentReducer,
  clientAccepts,
  nameForPastedFile,
  toBase64,
  type AttachmentChip,
} from "./attachments.ts";
import type { MessageKey } from "./i18n/messages.ts";
import { ATTACHMENT_LIMITS } from "@clarkcant/contracts";

export interface AttachmentComposerState {
  /**
   * Files on their way to the node, as chips above the input.
   *
   * Held here rather than inside the composer form because sending has to read them and clear
   * them, and a chip that outlives the message it belonged to is a file the person thinks they
   * sent twice.
   */
  chips: readonly AttachmentChip[];
  dispatchChips: React.Dispatch<Parameters<typeof attachmentReducer>[1]>;
  /** Whether a file is being dragged over the composer, which is what draws the drop target. */
  dragging: boolean;
  setDragging: (dragging: boolean) => void;
  /**
   * Take files into the composer, one chip at a time.
   *
   * Every route in — the picker, a drop, a paste — comes through here, so the rules are applied
   * once. A file the client already knows the node will refuse gets a failed chip and no request
   * at all: uploading 30 MB to be told the ceiling is 25 would spend the person's bandwidth to
   * tell them something known in advance.
   *
   * The conversation is created first when there is none. An attachment belongs to a conversation,
   * and one uploaded into nothing could never be sent.
   */
  addFiles: (files: readonly File[]) => Promise<void>;
}

export interface AttachmentComposerDeps {
  client: GatewayClient;
  conversationId: string | undefined;
  onConversationCreated: (conversationId: string) => void;
  onErrorCleared: () => void;
  /**
   * The translator for the current UI language, passed rather than read via `useT()`: this hook is
   * called directly from `Conversation`'s own body, before `Conversation`'s `<LocaleProvider>` — a
   * child of its return, not an ancestor of it — is mounted.
   */
  t: (key: MessageKey) => string;
}

export function useAttachmentComposer({
  client,
  conversationId,
  onConversationCreated,
  onErrorCleared,
  t,
}: AttachmentComposerDeps): AttachmentComposerState {
  const [chips, dispatchChips] = useReducer(attachmentReducer, [] as readonly AttachmentChip[]);
  const [dragging, setDragging] = useState(false);

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      onErrorCleared();

      const stamped = Date.now();
      const additions: AttachmentChip[] = files.map((file, index) => ({
        id: `chip_${stamped}_${index}`,
        // A pasted file often arrives with no name at all, and the node refuses an empty one —
        // rightly, since a nameless attachment is a row nobody can recognise later.
        filename: file.name === "" ? nameForPastedFile(file.type, new Date(stamped)) : file.name,
        mime: file.type,
        sizeBytes: file.size,
        state: "checking",
      }));
      dispatchChips({ type: "add", chips: additions });

      // Where a chip can still become ready. Past this, the message could not carry them anyway.
      const room = Math.max(0, ATTACHMENT_LIMITS.maxPerMessage - chips.length);
      for (const [index, chip] of additions.entries()) {
        if (index >= room) {
          dispatchChips({
            type: "failed",
            id: chip.id,
            reason: t("shell.attachment.tooMany").replace("{max}", String(ATTACHMENT_LIMITS.maxPerMessage)),
          });
        }
      }
      const considered = additions.slice(0, room);
      if (considered.length === 0) return;

      let target = conversationId;
      if (target === undefined) {
        try {
          target = (await client.createConversation("Conversation")).conversationId;
          onConversationCreated(target);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          for (const chip of considered) dispatchChips({ type: "failed", id: chip.id, reason });
          return;
        }
      }

      for (const chip of considered) {
        const refused = clientAccepts({ filename: chip.filename, mime: chip.mime, sizeBytes: chip.sizeBytes });
        if (!refused.ok) {
          dispatchChips({ type: "failed", id: chip.id, reason: refused.message });
          continue;
        }
        const file = files[additions.indexOf(chip)];
        if (file === undefined) continue;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const stored = await client.uploadAttachment({
            conversationId: target,
            filename: chip.filename,
            mime: chip.mime,
            contentBase64: toBase64(bytes),
          });
          dispatchChips({ type: "stored", id: chip.id, attachmentId: stored.attachmentId });
        } catch (cause) {
          dispatchChips({
            type: "failed",
            id: chip.id,
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    },
    [chips.length, client, conversationId, onConversationCreated, onErrorCleared, t],
  );

  return { chips, dispatchChips, dragging, setDragging, addFiles };
}
