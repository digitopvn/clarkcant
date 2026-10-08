import {
  DECISION_PROVIDER_PREFERENCE,
  type Instant,
  decisionProviderIdSchema,
} from "@clarkcant/contracts";
import { writeRegisteredPreference } from "@clarkcant/core";
import { credentialNames } from "@clarkcant/storage";

import { decisionProviderView } from "../application/decision-provider-settings.ts";
import { removeDecisionCredential, storeDecisionCredential } from "../application/credential-vault.ts";
import { readDecisionSelection } from "../decision-config.ts";
import type { NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The decision provider: who answers Clark's typed decisions on this node, separate from the conversation model.
 *
 * - `GET /decision-provider` — the effective provider and model, what chose them, where the key comes from (`vault`,
 *   `environment` or `none`), whether a call would be attempted and why not, and the last call's outcome.
 * - `PUT /decision-provider {selection}` — the person's choice: `{provider:"typesafe"}`,
 *   `{provider:"cloudflare", model, accountId?}`, `{provider:"openrouter", model}`, or `null` to follow the
 *   environment. Stored as the registered preference `ai.decisionProvider`, so it has a revision and an undo.
 * - `PUT /decision-provider/credential {provider, value}` — the provider's key, stored under its own vault name.
 * - `DELETE /decision-provider/credential/:provider` — removes it.
 *
 * Every write is person-only (`isPersonOnlyRoute`): which third party a redacted intent is sent to is the person's
 * decision, never an AI client's. A change applies from the next decision; the node does not restart, and no answer
 * claims it did. No answer carries a key, its length, or a request body.
 */
export interface DecisionProviderRouteDeps {
  services: Pick<NodeServices, "runtime" | "conductor" | "jev">;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
  /** The environment the node's decider reads; the process's own by default. A test hands one in. */
  env?: NodeJS.ProcessEnv;
}

export function handleDecisionProviderRoutes(deps: DecisionProviderRouteDeps): GatewayResponse | undefined {
  const { request, segments, services } = deps;
  if (segments[0] !== "decision-provider") return undefined;
  const { runtime } = services;
  const principalId = runtime.identity.ownerPrincipalId;
  const preferenceDeps = { db: runtime.db, now: () => deps.at() as Instant };
  const view = (): GatewayResponse =>
    json(200, {
      decisionProvider: decisionProviderView({
        config: services.jev.config,
        selection: readDecisionSelection(preferenceDeps, principalId),
        env: deps.env ?? process.env,
        vault: credentialNames(runtime.db, principalId),
        telemetry: services.jev.telemetry(),
      }),
    });

  if (segments.length === 1 && request.method === "GET") return view();

  if (segments.length === 1 && request.method === "PUT") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    if (!("selection" in parsed.value)) {
      return fail(400, "INVALID_SCHEMA", "a decision provider write needs a selection (an object, or null to follow the environment)");
    }
    const written = writeRegisteredPreference(preferenceDeps, {
      principalId,
      key: DECISION_PROVIDER_PREFERENCE,
      value: parsed.value.selection,
    });
    // The message names the field the schema refused, never the value that arrived.
    if (!written.ok) return fail(400, written.code, written.message);
    return view();
  }

  if (segments[1] !== "credential") return fail(404, "NOT_FOUND", "no such decision provider route");

  if (segments.length === 2 && request.method === "PUT") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const provider = decisionProviderIdSchema.safeParse(parsed.value.provider);
    if (!provider.success) return fail(400, "INVALID_SCHEMA", "provider must be typesafe, cloudflare or openrouter");
    const stored = storeDecisionCredential(
      { db: runtime.db, ownerPrincipalId: principalId, nodeId: runtime.identity.nodeId, newId: services.conductor.newId },
      { provider: provider.data, value: parsed.value.value },
    );
    if (!stored.ok) return fail(400, stored.code, stored.message);
    return view();
  }

  if (segments.length === 3 && request.method === "DELETE") {
    const provider = decisionProviderIdSchema.safeParse(segments[2]);
    if (!provider.success) return fail(400, "INVALID_SCHEMA", "provider must be typesafe, cloudflare or openrouter");
    const removed = removeDecisionCredential({ db: runtime.db, ownerPrincipalId: principalId }, provider.data);
    // "Removed" and "there was nothing to remove" are different answers.
    if (!removed.removed) return fail(404, "RESOURCE_NOT_FOUND", `no stored key for the ${provider.data} decision provider`);
    return view();
  }

  return fail(405, "METHOD_NOT_ALLOWED", "this decision provider route does not accept that method");
}
