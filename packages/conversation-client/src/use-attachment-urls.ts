import type { GatewayClient } from "./api.ts";
import { type ObjectUrls, useObjectUrlSet } from "./use-object-urls.ts";

/**
 * Object URLs for the bytes of a set of attachments.
 *
 * The three rules that make this safe to use live in `use-object-urls.ts`, shared with images and players, because they
 * are about blob URLs rather than about pictures. What differs is only where the bytes come from: this route re-checks
 * that the attachment belongs to the principal on every read, so a URL here is never a capability that outlives the
 * conversation it was issued for.
 *
 * `attachmentIds` are read as soon as they are listed (a picture the reader sees); `onRequest` are listed but read only
 * when `request` names one (a file the person downloads), so a conversation with several large files reads none of them
 * until one is asked for.
 */
export function useAttachmentUrls(
  client: GatewayClient | undefined,
  attachmentIds: readonly string[],
  onRequest: readonly string[] = [],
): ObjectUrls {
  // No client means no bytes. Saying that once, here, keeps every renderer from deciding for itself what to
  // do about a view that is not connected to a node.
  return useObjectUrlSet(
    (attachmentId, signal) =>
      client === undefined
        ? Promise.reject(new Error("this view has no node connection"))
        : client.attachmentObjectUrl(attachmentId, signal),
    client === undefined ? [] : attachmentIds,
    client === undefined ? [] : onRequest,
  );
}
