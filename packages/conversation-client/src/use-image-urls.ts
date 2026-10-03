import { parseHostFileRef } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";
import { type ObjectUrls, useObjectUrlSet } from "./use-object-urls.ts";

/**
 * An object URL for anything a surface names by a host reference: an imported image or video by its id, or a file the
 * node holds as `artifact:<id>` or `attachment:<id>` (an audio player's source).
 *
 * Every one is read through the authenticated client from the node, so a page never asks anywhere else for the bytes a
 * widget shows.
 */
export async function hostObjectUrl(client: GatewayClient, ref: string): Promise<string> {
  const file = parseHostFileRef(ref);
  if (file === undefined) return client.imageObjectUrl(ref);
  if (file.kind === "attachment") return client.attachmentObjectUrl(file.id);
  return URL.createObjectURL(await client.artifactContent(file.id));
}

/**
 * Object URLs for a set of host references.
 *
 * The three rules that make this safe to use live in `use-object-urls.ts`, shared with attachments, because
 * they are about blob URLs rather than about images.
 */
export function useImageUrls(
  client: GatewayClient,
  refs: readonly string[],
): (imageRef: string) => string | undefined {
  return useHostObjectUrls(client, refs, []).get;
}

/**
 * Object URLs for host references read now (pictures) and host references read on request (a player's source).
 *
 * One set rather than two, so a reference that is both a picture somewhere and a player's source elsewhere is read
 * once and owned once.
 */
export function useHostObjectUrls(
  client: GatewayClient,
  refs: readonly string[],
  onRequest: readonly string[],
): ObjectUrls {
  return useObjectUrlSet((ref) => hostObjectUrl(client, ref), refs, onRequest);
}
