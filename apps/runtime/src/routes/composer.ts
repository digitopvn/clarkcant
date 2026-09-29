import { composerTriggerSchema } from "@clarkcant/contracts";

import type { ReferenceServices } from "../composer-references.ts";
import { composerSuggestions } from "../composer-suggestions.ts";
import { type GatewayRequest, type GatewayResponse, fail, json } from "./http.ts";

/**
 * The composer's picker.
 *
 *   GET /composer/suggestions?trigger=/|@&q=&conversationId=
 *
 * `trigger` is the character that opened the picker, `q` what was typed after it, and `conversationId` the
 * conversation being written in, which is left out of its own `@` list. Read only: choosing a row changes the draft,
 * and what the reference means is decided again when the message is sent.
 *
 * Behind the gateway's bearer check like every route after it.
 */
export interface ComposerRouteDeps {
  services: ReferenceServices;
  request: GatewayRequest;
  segments: string[];
}

export async function handleComposerRoutes(deps: ComposerRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments } = deps;
  if (segments[0] !== "composer") return undefined;

  if (segments.length === 2 && segments[1] === "suggestions") {
    if (request.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "suggestions are read with GET");
    const trigger = composerTriggerSchema.safeParse(request.query.trigger);
    if (!trigger.success) return fail(400, "INVALID_SCHEMA", "trigger must be / or @");
    const query = request.query.q ?? "";
    if (query.length > 200) return fail(400, "INVALID_SCHEMA", "q must be at most 200 characters");
    const conversationId = request.query.conversationId;
    return json(
      200,
      await composerSuggestions(deps.services, {
        trigger: trigger.data,
        query,
        ...(conversationId === undefined || conversationId === "" ? {} : { conversationId }),
      }),
    );
  }

  return fail(404, "NOT_FOUND", `no composer handler for ${request.method} ${request.path}`);
}
