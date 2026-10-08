import {
  DECISION_CREDENTIAL_NAMES,
  DECISION_PROVIDER_IDS,
  type DecisionProviderId,
  type DecisionProviderSelection,
} from "@clarkcant/contracts";

import { type DecisionConfig, type DecisionSelectionSource, currentDecisionConfig } from "../decision-config.ts";
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

/**
 * Why decisions do or do not leave the node right now.
 *
 * - `ready`: a call would be attempted.
 * - `local-only`: the operator forbids third-party processing; nothing is sent whatever is chosen.
 * - `misconfigured`: the configuration names no endpoint this node will call (a missing model or account id).
 * - `no-credential`: no key, in the vault or the environment.
 * - `disabled`: the operator switched decisions off (`CLARKCANT_JEV_ENABLED=0`).
 */
export type DecisionProviderStatus = "ready" | "local-only" | "misconfigured" | "no-credential" | "disabled";

export interface DecisionProviderView {
  provider: DecisionProviderId;
  selectedBy: DecisionSelectionSource;
  /** The person's stored choice, or `null` when the node follows its environment. */
  selection: DecisionProviderSelection | null;
  /** The pinned model a call names. */
  model: string;
  /** The host decisions are sent to; never a path, never a query. */
  endpointHost: string;
  status: DecisionProviderStatus;
  /** Why the status is not `ready`, in the decider's own words. */
  reason?: string;
  localOnly: boolean;
  credential: { name: string; source: CredentialSource };
  /** Cloudflare only: where the account id comes from. The id itself is not a secret but is not echoed either. */
  account?: { source: "settings" | "environment" | "none" };
  /** A change to the provider, its model or its key applies from the next decision; nothing restarts. */
  applies: "next-decision";
  /** What every decision falls back to when the provider cannot answer. */
  fallback: "deterministic";
  /** The most recent provider call or refusal on this node since it started. No body, no key, no prompt. */
  lastCall?: Pick<JevTelemetry, "event" | "status" | "model" | "durationMs" | "reason">;
  /** Every provider this node can use, for the selector, each with where its key would come from. */
  providers: {
    id: DecisionProviderId;
    /** The models a person may choose from, or `null` when the provider takes a pinned slug. */
    models: readonly string[] | null;
    credential: { name: string; source: CredentialSource };
  }[];
}

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

function statusOf(config: DecisionConfig): { status: DecisionProviderStatus; reason?: string } {
  // `decisionCallRefusal`'s checks, except that a missing key is named before the "disabled" it implies: with no key and
  // no explicit switch, `enabled` is false only because there is no key, and "add a key" is the thing to tell somebody.
  if (config.localOnly) return { status: "local-only", reason: "this node is configured local-only, so no intent is sent to a provider" };
  if (config.endpointRefusal !== undefined) return { status: "misconfigured", reason: config.endpointRefusal };
  if (config.apiKey === undefined) return { status: "no-credential", reason: "no provider credential is configured on this node" };
  if (!config.enabled) return { status: "disabled", reason: "the selector is disabled on this node" };
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
          },
        }),
    providers: DECISION_PROVIDER_IDS.map((id) => ({
      id,
      models: decisionProviderFor(id).models ?? null,
      credential: credentialOf(input, id),
    })),
  };
}
