import { CLOUDFLARE_DECISION_MODELS } from "./cloudflare-decision-provider.ts";
import { validateProviderEndpoint } from "./decision-transport.ts";
import type { DecisionProvider } from "./decision-provider.ts";
import { systemOneResponseSchema } from "./system-one-wire.ts";

/**
 * TypeSafe Jev, the decision provider a node uses unless an operator names another.
 *
 * The response is System One with no envelope, so reading it is the schema and nothing else. What makes this adapter
 * specific is the configuration: the TypeSafe credential, the endpoint an operator may override, and the pinned id.
 */

/** Pinned exact id. `jev-1.13.0` was verified live on 2026-09-17. */
export const JEV_EXACT_MODEL = "jev-1.13.0";
export const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Whether a model id is one of Cloudflare's, by name or by its Workers AI namespace. */
function namesCloudflareModel(model: string): boolean {
  return (CLOUDFLARE_DECISION_MODELS as readonly string[]).includes(model) || model.startsWith("@cf/");
}

export const typesafeDecisionProvider: DecisionProvider = {
  id: "typesafe",
  connection(env, stored) {
    // The environment wins when both exist: an operator who set it deliberately should not be overridden by a value
    // typed later into a card.
    const apiKey = env.TYPESAFE_API_KEY?.trim() || stored?.()?.trim() || undefined;
    // The provider-neutral name wins; the Jev-specific one keeps working for configurations written before it.
    const model = env.CLARKCANT_DECISION_MODEL?.trim() || env.CLARKCANT_JEV_MODEL?.trim() || JEV_EXACT_MODEL;
    const endpointCheck = validateProviderEndpoint(env.CLARKCANT_JEV_ENDPOINT?.trim() || JEV_DEFAULT_ENDPOINT);
    const endpoint = endpointCheck.ok ? endpointCheck.url : JEV_DEFAULT_ENDPOINT;
    if (namesCloudflareModel(model)) {
      // A model setting left over from selecting Cloudflare. Sending it would hand TypeSafe a request it can only
      // reject, so it is refused here, before anything leaves the node, naming the setting that caused it.
      return {
        apiKey,
        endpoint,
        endpointRefusal: `the decision model ${model.slice(0, 64)} is a Cloudflare model, which TypeSafe does not serve; set CLARKCANT_DECISION_PROVIDER=cloudflare or unset CLARKCANT_DECISION_MODEL`,
        model,
      };
    }
    return {
      apiKey,
      endpoint,
      endpointRefusal: endpointCheck.ok ? undefined : endpointCheck.reason,
      model,
    };
  },
  readResponse(body) {
    const parsed = systemOneResponseSchema.safeParse(body);
    return parsed.success ? parsed.data : undefined;
  },
};
