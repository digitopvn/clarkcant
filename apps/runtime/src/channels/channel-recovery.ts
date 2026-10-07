import type { Instant } from "@clarkcant/contracts";
import {
  channelDeliveryReceiptsInState,
  channelDeliveryReceiptsSince,
  channelInputsInState,
  getChannelBinding,
  getExternalConnection,
  updateChannelDeliveryReceipt,
  updateChannelInput,
} from "@clarkcant/storage";

import { ownerHostText } from "../host-text.ts";
import { appendHostReply } from "../routes/conversations.ts";
import type { NodeServices } from "../services.ts";

/**
 * What a previous process left. A message whose turn had started is interrupted, said once in its conversation — with
 * whether part of its reply had already gone out — and never answered again; a reply that was handed off without an answer is unknown (the effect ledger's own recovery
 * turns its effect unknown and asks the person), and one never handed off did not happen.
 */
export function recoverChannelWork(services: Pick<NodeServices, "runtime" | "conductor" | "search">, now: () => Instant): void {
  const db = services.runtime.db;
  try {
    for (const input of channelInputsInState(db, ["started"], 500)) {
      updateChannelInput(db, input.signalId, { state: "interrupted", at: now(), reason: "the node stopped while its turn ran" });
      const binding = input.bindingId === undefined ? undefined : getChannelBinding(db, input.bindingId);
      if (binding === undefined) continue;
      const provider = getExternalConnection(db, binding.connectionRef)?.provider ?? binding.provider;
      // Whether part of the reply had already reached the channel: a receipt the binding wrote as sent since the turn
      // started. Read before the pending receipts below are settled, which only ever turns them unknown or failed.
      const partlySent = channelDeliveryReceiptsSince(db, binding.conversationId, input.updatedAt).some(
        (receipt) => receipt.bindingId === binding.bindingId && receipt.state === "sent",
      );
      appendHostReply(services, {
        conversationId: binding.conversationId,
        text: ownerHostText(services.runtime).channels.interrupted(provider, partlySent),
        at: now(),
      });
    }
    for (const receipt of channelDeliveryReceiptsInState(db, "pending")) {
      updateChannelDeliveryReceipt(db, {
        ...receipt,
        state: receipt.effectId === undefined ? "failed" : "unknown",
        reason: receipt.effectId === undefined ? "the node stopped before it was sent" : "the node stopped while it was being sent",
        updatedAt: now(),
      });
    }
  } catch (cause) {
    process.stderr.write(`channels: recovery failed (${cause instanceof Error ? cause.message : String(cause)})\n`);
  }
}
