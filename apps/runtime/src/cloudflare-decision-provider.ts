import { z } from "zod";

import { validateProviderEndpoint } from "./decision-transport.ts";
import type { DecisionProvider, DecisionProviderConnection } from "./decision-provider.ts";
import { systemOneResponseSchema } from "./system-one-wire.ts";

/**
 * Cloudflare Clef on Workers AI, used only when an operator selects it.
 *
 * Clef answers the same System One questions Jev does, so the request body is unchanged and Clark's policy reads the
 * same answer. Two things are Cloudflare's own and stay here:
 *
 * - **The URL is built, never configured.** It is the Workers AI REST path for one account and one model, and both are
 *   checked against a fixed shape first. There is deliberately no endpoint override: an account id and a model name
 *   are the only inputs, so no setting can point this node at an arbitrary URL.
 * - **The answer arrives in Cloudflare's REST envelope** (`{ success, result, errors, messages }`). Only a successful
 *   envelope is unwrapped, and the System One answer inside it is validated by the same schema as Jev's.
 */

export const CLOUDFLARE_DECISION_MODELS = Object.freeze(["clef", "clef-flash"] as const);
export type CloudflareDecisionModel = (typeof CLOUDFLARE_DECISION_MODELS)[number];

const WORKERS_AI_ORIGIN = "https://api.cloudflare.com";
/** The model namespace on Workers AI; a response may name the model with or without it. */
const MODEL_NAMESPACE = "@cf/cloudflare/";
/** A Cloudflare account id is 32 hexadecimal characters. Anything else is refused before it can reach a URL. */
const ACCOUNT_ID_SHAPE = /^[0-9a-f]{32}$/i;

/** Recorded as the model when none usable is configured, so a refusal line still names what was missing. */
const UNCONFIGURED_MODEL = "unconfigured";

function isCloudflareDecisionModel(value: string): value is CloudflareDecisionModel {
  return (CLOUDFLARE_DECISION_MODELS as readonly string[]).includes(value);
}

/** The Workers AI REST URL for one account and one Clef model. Both inputs must already be validated. */
export function workersAiEndpoint(accountId: string, model: CloudflareDecisionModel): string {
  return `${WORKERS_AI_ORIGIN}/client/v4/accounts/${accountId}/ai/run/${MODEL_NAMESPACE}${model}`;
}

function refused(model: string, reason: string): DecisionProviderConnection {
  return { apiKey: undefined, endpoint: WORKERS_AI_ORIGIN, endpointRefusal: reason, model };
}

const envelopeSchema = z.object({
  success: z.literal(true),
  result: z.unknown(),
});

export const cloudflareDecisionProvider: DecisionProvider = {
  id: "cloudflare",
  connection(env) {
    const requested = env.CLARKCANT_DECISION_MODEL?.trim() ?? "";
    if (!isCloudflareDecisionModel(requested)) {
      return refused(
        UNCONFIGURED_MODEL,
        `the Cloudflare decision provider needs CLARKCANT_DECISION_MODEL set to ${CLOUDFLARE_DECISION_MODELS.join(" or ")}`,
      );
    }
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
    if (accountId === "") {
      return refused(requested, "the Cloudflare decision provider needs CLOUDFLARE_ACCOUNT_ID");
    }
    if (!ACCOUNT_ID_SHAPE.test(accountId)) {
      // The value is not repeated back: it is operator configuration, but a reason line is not the place to echo it.
      return refused(requested, "CLOUDFLARE_ACCOUNT_ID is not a Cloudflare account id (32 hexadecimal characters)");
    }
    // Validated a second time by the same policy every endpoint passes, so a built URL gets no exemption from it.
    const endpointCheck = validateProviderEndpoint(workersAiEndpoint(accountId, requested));
    if (!endpointCheck.ok) return refused(requested, endpointCheck.reason);

    // The environment only. There is no settings card for this token, and a generically named stored secret was
    // stored for some other consumer: using it here would skip the vault's consumer check entirely.
    const apiKey = env.CLOUDFLARE_API_TOKEN?.trim() || undefined;
    return { apiKey, endpoint: endpointCheck.url, endpointRefusal: undefined, model: requested };
  },
  readResponse(body) {
    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success) return undefined;
    const parsed = systemOneResponseSchema.safeParse(envelope.data.result);
    if (!parsed.success) return undefined;
    // Normalised here so the drift check stays one comparison: `@cf/cloudflare/clef` and `clef` name the same model,
    // and anything else is still compared, and refused, as it is.
    const model = parsed.data.model.startsWith(MODEL_NAMESPACE)
      ? parsed.data.model.slice(MODEL_NAMESPACE.length)
      : parsed.data.model;
    return { ...parsed.data, model };
  },
};
