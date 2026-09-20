import type { Suggestion } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";

/**
 * What the node suggests doing next, or nothing at all.
 *
 * Asking is the easy part; the property here is that failing to ask cannot break the screen. A node that is
 * unreachable, too old to have the route, or answering with a shape this build does not know all end the same
 * way - no suggestions - and the caller draws the chips it has always drawn. A first screen that could not be
 * opened because a suggestion list was unavailable would be a worse app than one with no suggestions.
 */
export async function fetchSuggestions(client: GatewayClient): Promise<Suggestion[]> {
  try {
    return await client.suggestions();
  } catch {
    return [];
  }
}
