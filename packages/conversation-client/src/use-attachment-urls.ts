import type { GatewayClient } from "./api.ts";
import { useObjectUrls } from "./use-object-urls.ts";

/**
 * Object URLs for the bytes of a set of attachments.
 *
 * The three rules that make this safe to use live in `use-object-urls.ts`, shared with images, because they
 * are about blob URLs rather than about pictures. What differs is only where the bytes come from: this route
 * re-checks that the attachment belongs to the principal on every read, so a URL here is never a capability
 * that outlives the conversation it was issued for.
 */
export function useAttachmentUrls(
  client: GatewayClient | undefined,
  attachmentIds: readonly string[],
): (attachmentId: string) => string | undefined {
  // No client means no bytes. Saying that once, here, keeps every renderer from deciding for itself what to
  // do about a view that is not connected to a node.
  return useObjectUrls(
    (attachmentId) =>
      client === undefined
        ? Promise.reject(new Error("this view has no node connection"))
        : client.attachmentObjectUrl(attachmentId),
    client === undefined ? [] : attachmentIds,
  );
}
