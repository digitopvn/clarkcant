import type { GatewayClient } from "./api.ts";
import { useObjectUrls } from "./use-object-urls.ts";

/**
 * Object URLs for a set of imported images.
 *
 * The three rules that make this safe to use live in `use-object-urls.ts`, shared with attachments, because
 * they are about blob URLs rather than about images.
 */
export function useImageUrls(
  client: GatewayClient,
  refs: readonly string[],
): (imageRef: string) => string | undefined {
  return useObjectUrls((imageRef) => client.imageObjectUrl(imageRef), refs);
}
