import { cloudflareDecisionProvider } from "./cloudflare-decision-provider.ts";
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

export type DecisionProviderId = "typesafe" | "cloudflare";

/** Every provider id this node knows. TypeSafe is first because it is the default. */
export const DECISION_PROVIDER_IDS: readonly DecisionProviderId[] = Object.freeze(["typesafe", "cloudflare"]);

/** Used when nothing names a provider, which is every configuration written before a second one existed. */
export const DEFAULT_DECISION_PROVIDER: DecisionProviderId = "typesafe";

/** What an adapter resolves from operator configuration: where to call, with what, and which model is pinned. */
export interface DecisionProviderConnection {
  apiKey: string | undefined;
  /** The URL a call is made to. Only ever built from validated configuration. */
  endpoint: string;
  /** Set when the configuration does not describe an endpoint this node will call. No call is attempted. */
  endpointRefusal: string | undefined;
  /** The exact model id the answer must name. */
  model: string;
}

/**
 * A credential a person stored through the interface, looked up by name.
 *
 * A function rather than a value because it is read when the selector is built, and the point of storing one is that
 * it works without restarting the node.
 */
export type StoredCredential = (name: string) => string | undefined;

export interface DecisionProvider {
  readonly id: DecisionProviderId;
  /**
   * Credential, endpoint and pinned model, read from the operator's environment and the credential store only.
   *
   * Never from conversation or project state: what a decision may be sent to is an operator choice.
   */
  connection(env: NodeJS.ProcessEnv, stored: StoredCredential | undefined): DecisionProviderConnection;
  /**
   * The body of a successful response as a System One answer, or `undefined` when it is not one.
   *
   * Never throws, and never fills a missing field with a default: an answer that does not parse is reported by the
   * caller as malformed, exactly as it would be for any other provider.
   */
  readResponse(body: unknown): SystemOneResponse | undefined;
}

/** The adapter for a provider id. */
export function decisionProviderFor(id: DecisionProviderId): DecisionProvider {
  switch (id) {
    case "typesafe":
      return typesafeDecisionProvider;
    case "cloudflare":
      return cloudflareDecisionProvider;
  }
}
