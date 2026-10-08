import {
  DECISION_CREDENTIAL_NAMES,
  DECISION_PROVIDER_IDS,
  type DecisionProviderId,
  type DecisionProviderSelection,
  type DecisionProviderStatus,
  type DecisionProviderView,
  type DecisionReasonCode,
} from "@clarkcant/contracts";

import { type DecisionConfig, currentDecisionConfig } from "../decision-config.ts";
import { decisionProviderFor } from "../decision-provider.ts";
import type { JevTelemetry } from "../jev-selector.ts";
import { CREDENTIAL_VARIABLES, type CredentialSource, providerCredentialSource } from "../provider-credential.ts";

/**
 * What the decision provider card shows: who decides on this node, with which model, with a key from where, and
 * whether the last call worked.
 *
 * Read from the configuration the decider itself reads (`currentDecisionConfig`), so the card and the decider cannot
 * disagree. Names, sources and reasons only: never a key, never a length, never a request body.
 */

/** The view's shape is the contract's, so the Settings card and this route cannot drift apart. */
export type { DecisionProviderStatus, DecisionProviderView };

export interface DecisionProviderViewInput {
  config: DecisionConfig;
  selection: DecisionProviderSelection | null;
  env: Readonly<Record<string, string | undefined>>;
  /** The vault's credential names; values are never read here. */
  vault: readonly string[];
  telemetry: readonly JevTelemetry[];
}

function credentialOf(input: DecisionProviderViewInput, provider: DecisionProviderId): { name: string; source: CredentialSource } {
  const name = DECISION_CREDENTIAL_NAMES[provider];
  return {
    name,
    source: providerCredentialSource({
      inVault: input.vault.includes(name),
      env: input.env,
      variables: CREDENTIAL_VARIABLES[name] ?? [],
    }),
  };
}

/**
 * The state the decider is in, why in English for logs and machine clients, and why as a code the card words in the
 * person's language: the card never shows the English sentence.
 */
function statusOf(config: DecisionConfig): { status: DecisionProviderStatus; reason?: string; reasonCode?: DecisionReasonCode } {
  // `decisionCallRefusal`'s checks, except that a missing key is named before the "disabled" it implies: with no key and
  // no explicit switch, `enabled` is false only because there is no key, and "add a key" is the thing to tell somebody.
  if (config.localOnly) {
    return { status: "local-only", reason: "this node is configured local-only, so no intent is sent to a provider", reasonCode: "local-only" };
  }
  if (config.endpointRefusal !== undefined) {
    return { status: "misconfigured", reason: config.endpointRefusal, reasonCode: config.endpointRefusalCode ?? "endpoint-invalid" };
  }
  if (config.apiKey === undefined) {
    return { status: "no-credential", reason: "no provider credential is configured on this node", reasonCode: "no-credential" };
  }
  if (!config.enabled) return { status: "disabled", reason: "the selector is disabled on this node", reasonCode: "disabled" };
  return { status: "ready" };
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "";
  }
}

export function decisionProviderView(input: DecisionProviderViewInput): DecisionProviderView {
  const config = currentDecisionConfig(input.config);
  const provider = config.provider ?? "typesafe";
  const last = input.telemetry.at(-1);
  const accountSource =
    input.selection?.provider === "cloudflare" && input.selection.accountId !== undefined
      ? "settings"
      : (input.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "") !== ""
        ? "environment"
        : "none";
  return {
    provider,
    selectedBy: config.selectedBy ?? "default",
    selection: input.selection,
    model: config.model,
    endpointHost: hostOf(config.endpoint),
    ...statusOf(config),
    localOnly: config.localOnly,
    credential: credentialOf(input, provider),
    ...(provider === "cloudflare" ? { account: { source: accountSource } } : {}),
    applies: "next-decision",
    fallback: "deterministic",
    ...(last === undefined
      ? {}
      : {
          lastCall: {
            event: last.event,
            status: last.status,
            model: last.model,
            durationMs: last.durationMs,
            ...(last.reason === undefined ? {} : { reason: last.reason }),
            ...(last.reasonCode === undefined ? {} : { reasonCode: last.reasonCode }),
          },
        }),
    providers: DECISION_PROVIDER_IDS.map((id) => ({
      id,
      models: decisionProviderFor(id).models ?? null,
      credential: credentialOf(input, id),
    })),
  };
}
