import { CLOUDFLARE_DECISION_MODELS } from "./cloudflare-decision-provider.ts";
import { validateProviderEndpoint } from "./decision-transport.ts";
import type { DecisionProvider } from "./decision-provider.ts";
import { CREDENTIAL_VARIABLES, resolveProviderCredential } from "./provider-credential.ts";
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

/** Whether a model id belongs to another provider: one of Cloudflare's, by name or namespace, or an OpenRouter slug. */
function otherProviderOf(model: string): "cloudflare" | "openrouter" | undefined {
  if ((CLOUDFLARE_DECISION_MODELS as readonly string[]).includes(model) || model.startsWith("@cf/")) return "cloudflare";
  return model.includes("/") ? "openrouter" : undefined;
}

export const typesafeDecisionProvider: DecisionProvider = {
  id: "typesafe",
  models: Object.freeze([JEV_EXACT_MODEL]),
  connection(env, stored) {
    // The key typed into the card wins when both exist, the rule every provider credential follows
    // (`provider-credential.ts`); the environment is the default for a node whose vault holds none.
    const apiKey = resolveProviderCredential({
      stored: stored?.("typesafe"),
      env,
      variables: CREDENTIAL_VARIABLES["typesafe"] ?? [],
    }).value;
    // The provider-neutral name wins; the Jev-specific one keeps working for configurations written before it.
    const model = env.CLARKCANT_DECISION_MODEL?.trim() || env.CLARKCANT_JEV_MODEL?.trim() || JEV_EXACT_MODEL;
    const endpointCheck = validateProviderEndpoint(env.CLARKCANT_JEV_ENDPOINT?.trim() || JEV_DEFAULT_ENDPOINT);
    const endpoint = endpointCheck.ok ? endpointCheck.url : JEV_DEFAULT_ENDPOINT;
    const owner = otherProviderOf(model);
    if (owner !== undefined) {
      // A model setting left over from selecting Cloudflare. Sending it would hand TypeSafe a request it can only
      // reject, so it is refused here, before anything leaves the node, naming the setting that caused it.
      return {
        apiKey,
        endpoint,
        endpointRefusal: `the decision model ${model.slice(0, 64)} is ${owner === "cloudflare" ? "a Cloudflare model" : "an OpenRouter model slug"}, which TypeSafe does not serve; set CLARKCANT_DECISION_PROVIDER=${owner} or unset CLARKCANT_DECISION_MODEL`,
        endpointRefusalCode: "model-other-provider",
        model,
      };
    }
    return {
      apiKey,
      endpoint,
      endpointRefusal: endpointCheck.ok ? undefined : endpointCheck.reason,
      ...(endpointCheck.ok ? {} : { endpointRefusalCode: "endpoint-invalid" as const }),
      model,
    };
  },
  readResponse(body) {
    const parsed = systemOneResponseSchema.safeParse(body);
    return parsed.success ? parsed.data : undefined;
  },
};
