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

export const typesafeDecisionProvider: DecisionProvider = {
  id: "typesafe",
  connection(env, stored) {
    // The environment wins when both exist: an operator who set it deliberately should not be overridden by a value
    // typed later into a card.
    const apiKey = env.TYPESAFE_API_KEY?.trim() || stored?.("typesafe")?.trim() || undefined;
    // The provider-neutral name wins; the Jev-specific one keeps working for configurations written before it.
    const model = env.CLARKCANT_DECISION_MODEL?.trim() || env.CLARKCANT_JEV_MODEL?.trim() || JEV_EXACT_MODEL;
    const endpointCheck = validateProviderEndpoint(env.CLARKCANT_JEV_ENDPOINT?.trim() || JEV_DEFAULT_ENDPOINT);
    return {
      apiKey,
      endpoint: endpointCheck.ok ? endpointCheck.url : JEV_DEFAULT_ENDPOINT,
      endpointRefusal: endpointCheck.ok ? undefined : endpointCheck.reason,
      model,
    };
  },
  readResponse(body) {
    const parsed = systemOneResponseSchema.safeParse(body);
    return parsed.success ? parsed.data : undefined;
  },
};
