import {
  DECISION_CREDENTIAL_NAMES,
  type DecisionReasonCode,
  OPENROUTER_DECISION_MODEL_PATTERN,
  isOpenrouterRouterSlug,
} from "@clarkcant/contracts";

import { validateProviderEndpoint } from "./decision-transport.ts";
import type { DecisionProvider, DecisionProviderConnection } from "./decision-provider.ts";
import { CREDENTIAL_VARIABLES, resolveProviderCredential } from "./provider-credential.ts";
import { systemOneResponseSchema } from "./system-one-wire.ts";

/**
 * OpenRouter's decisions API, used only when an operator or the person selects it.
 *
 * OpenRouter documents `POST https://openrouter.ai/api/alpha/decisions` with the same body Clark already sends
 * (`model`, `state`, `questions` of type `noul`, `choice` or `score`) and an answer in the same System One shape
 * (`model`, `answers`, `usage`), with three extra fields this adapter ignores (`id`, `provider`, `usage.cost`). That is
 * the compatibility this adapter rests on, and the recorded fixtures in its tests are the documentation's own examples.
 *
 * Three rules are OpenRouter's own and stay here:
 *
 * - **The URL is fixed.** There is no endpoint setting: a model slug is the only input, so no configuration can point
 *   this node at another host.
 * - **The model is pinned.** A slug must be `vendor/model`; an alias such as `~typesafe/jev-latest` is refused, because
 *   it names whatever model is newest and the policy's floors were set against one model.
 * - **A dated snapshot is the pinned model.** OpenRouter answers an unversioned slug with the snapshot that served it
 *   (`typesafe/jev-1.13` as `typesafe/jev-1.13-20260917`). That and nothing looser is accepted; the dated id is what
 *   telemetry records as the resolved model.
 *
 * The API is labelled alpha by OpenRouter. Its shape may change; when it does, the answer stops parsing and every
 * decision falls back exactly as it would for an unavailable provider.
 */

export const OPENROUTER_DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

const UNCONFIGURED_MODEL = "unconfigured";
const DATED_SNAPSHOT = /^-\d{8}$/;

function refused(model: string, code: DecisionReasonCode, reason: string): DecisionProviderConnection {
  return { apiKey: undefined, endpoint: OPENROUTER_DECISIONS_ENDPOINT, endpointRefusal: reason, endpointRefusalCode: code, model };
}

export const openrouterDecisionProvider: DecisionProvider = {
  id: "openrouter",
  models: undefined,
  connection(env, stored) {
    const requested = env.CLARKCANT_DECISION_MODEL?.trim() ?? "";
    if (requested === "") {
      return refused(UNCONFIGURED_MODEL, "openrouter-model-missing", "the OpenRouter decision provider needs CLARKCANT_DECISION_MODEL set to a pinned model slug");
    }
    if (!OPENROUTER_DECISION_MODEL_PATTERN.test(requested)) {
      // Not repeated back beyond a bound: it is configuration, but a reason line is not the place to echo it at length.
      return refused(
        UNCONFIGURED_MODEL,
        "openrouter-model-invalid",
        "CLARKCANT_DECISION_MODEL is not a pinned OpenRouter model slug (vendor/model, lower case, no ~ alias)",
      );
    }
    if (isOpenrouterRouterSlug(requested)) {
      return refused(
        UNCONFIGURED_MODEL,
        "openrouter-model-router",
        "CLARKCANT_DECISION_MODEL names an OpenRouter router, which picks a different model per request and never answers as one pinned model",
      );
    }
    const endpointCheck = validateProviderEndpoint(OPENROUTER_DECISIONS_ENDPOINT);
    if (!endpointCheck.ok) return refused(requested, "endpoint-invalid", endpointCheck.reason);
    const credentialName = DECISION_CREDENTIAL_NAMES.openrouter;
    const apiKey = resolveProviderCredential({
      stored: stored?.("openrouter"),
      env,
      variables: CREDENTIAL_VARIABLES[credentialName] ?? [],
    }).value;
    return { apiKey, endpoint: endpointCheck.url, endpointRefusal: undefined, model: requested };
  },
  readResponse(body) {
    const parsed = systemOneResponseSchema.safeParse(body);
    return parsed.success ? parsed.data : undefined;
  },
  answersAs(pinned, answered) {
    if (answered === pinned) return true;
    return answered.startsWith(pinned) && DATED_SNAPSHOT.test(answered.slice(pinned.length));
  },
};
