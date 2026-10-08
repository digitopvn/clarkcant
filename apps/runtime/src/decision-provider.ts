import { DECISION_PROVIDER_IDS as PROVIDER_IDS, type DecisionProviderId, type DecisionReasonCode } from "@clarkcant/contracts";

import { cloudflareDecisionProvider } from "./cloudflare-decision-provider.ts";
import { openrouterDecisionProvider } from "./openrouter-decision-provider.ts";
import type { SystemOneResponse } from "./system-one-wire.ts";
import { typesafeDecisionProvider } from "./typesafe-decision-provider.ts";

/**
 * The decision role, as distinct from whoever fills it.
 *
 * Clark's decision policy - which options are offered, the floors an answer must clear, what a refusal, a timeout or
 * a malformed answer falls back to, and what is redacted before anything leaves the node - is written once, in the
 * selector and the decider. A provider is only the part that differs between vendors: where the call goes, which
 * credential it carries, and how the vendor's envelope is unwrapped into the System One answer the policy reads.
 *
 * That split is the boundary that keeps a provider from widening anything. An adapter cannot see the candidates, cannot
 * change a floor and cannot turn a refusal into a choice; it can only return a System One response or nothing.
 */

export type { DecisionProviderId };

/** Every provider id this node knows. TypeSafe is first because it is the default. */
export const DECISION_PROVIDER_IDS: readonly DecisionProviderId[] = PROVIDER_IDS;

/** Used when nothing names a provider, which is every configuration written before a second one existed. */
export const DEFAULT_DECISION_PROVIDER: DecisionProviderId = "typesafe";

/**
 * The provider to record beside a decision, or `undefined` for the default.
 *
 * Telemetry and provenance name a provider only when it is not the default, so a record written by a default node is
 * byte-for-byte what it was before a second provider existed, and a record that names one says who actually decided.
 */
export function recordedDecisionProvider(config: { provider?: DecisionProviderId | undefined }): DecisionProviderId | undefined {
  const provider = config.provider ?? DEFAULT_DECISION_PROVIDER;
  return provider === DEFAULT_DECISION_PROVIDER ? undefined : provider;
}

/** What an adapter resolves from operator configuration: where to call, with what, and which model is pinned. */
export interface DecisionProviderConnection {
  apiKey: string | undefined;
  /** The URL a call is made to. Only ever built from validated configuration. */
  endpoint: string;
  /** Set when the configuration does not describe an endpoint this node will call. No call is attempted. */
  endpointRefusal: string | undefined;
  /** The refusal as a code a card words in the person's language; set whenever `endpointRefusal` is. */
  endpointRefusalCode?: DecisionReasonCode | undefined;
  /** The exact model id the answer must name. */
  model: string;
}

/**
 * The key a person typed into the settings card for a provider, when there is one.
 *
 * A function rather than a value because it is read again for each decision (`liveDecisionConfig`), and the point of
 * storing one is that it works without restarting the node. It is asked by provider and answers from that provider's one
 * vault name (`DECISION_CREDENTIAL_NAMES`) and nothing else: a lookup by any name would let a secret stored for a
 * different consumer become a decision provider's bearer without the vault's consumer check.
 */
export type StoredCredential = (provider: DecisionProviderId) => string | undefined;

export interface DecisionProvider {
  readonly id: DecisionProviderId;
  /**
   * Credential, endpoint and pinned model, read from the operator's environment overlaid with the person's Settings
   * choice (`decision-config.ts`), and the key from the provider's own settings card.
   *
   * Never from conversation or project state: what a decision may be sent to is an operator's or the person's choice.
   */
  connection(env: NodeJS.ProcessEnv, stored: StoredCredential | undefined): DecisionProviderConnection;
  /**
   * The body of a successful response as a System One answer, or `undefined` when it is not one.
   *
   * Never throws, and never fills a missing field with a default: an answer that does not parse is reported by the
   * caller as malformed, exactly as it would be for any other provider.
   */
  readResponse(body: unknown): SystemOneResponse | undefined;
  /**
   * Whether the model an answer names is the model this node pinned. Absent means the two ids must be equal.
   *
   * A provider that serves a pinned name from a dated snapshot (`typesafe/jev-1.13` answered as
   * `typesafe/jev-1.13-20260917`) says so here, and nowhere looser: any other id is drift and is refused.
   */
  answersAs?(pinned: string, answered: string): boolean;
  /** The models a person may choose from in Settings, or `undefined` when the provider takes a pinned slug. */
  readonly models: readonly string[] | undefined;
}

/** The adapter for a provider id. */
export function decisionProviderFor(id: DecisionProviderId): DecisionProvider {
  switch (id) {
    case "typesafe":
      return typesafeDecisionProvider;
    case "cloudflare":
      return cloudflareDecisionProvider;
    case "openrouter":
      return openrouterDecisionProvider;
  }
}
