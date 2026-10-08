import { DECISION_PROVIDER_PREFERENCE, type DecisionProviderSelection, decisionProviderPreferenceSchema } from "@clarkcant/contracts";
import { type PreferenceDeps, readRegisteredPreference } from "@clarkcant/core";

import {
  DECISION_PROVIDER_IDS,
  DEFAULT_DECISION_PROVIDER,
  type DecisionProviderConnection,
  type DecisionProviderId,
  type StoredCredential,
  decisionProviderFor,
} from "./decision-provider.ts";

/**
 * The decision layer's configuration.
 *
 * Most of it is Clark's policy and is the same whichever provider answers: whether decisions may leave the node at
 * all, the budget, the floors an answer must clear, the policy version stamped on what was decided. The provider's own
 * part - credential, endpoint, pinned model - is resolved by its adapter and carried here so a refusal can name it.
 */
export interface DecisionConfig {
  /**
   * Which provider answers. Absent means TypeSafe, which is what every configuration written before a second provider
   * existed meant; only `CLARKCANT_DECISION_PROVIDER` selects another.
   */
  provider?: DecisionProviderId;
  /**
   * What chose the provider: the person's Settings choice, the operator's `CLARKCANT_DECISION_PROVIDER`, or nothing
   * (TypeSafe by default). Reported by the diagnostics so a card can say why this provider answers.
   */
  selectedBy?: DecisionSelectionSource;
  /** False when the provider is switched off or has no key. No call is attempted. */
  enabled: boolean;
  /** True when the operator forbids third-party processing of any intent. */
  localOnly: boolean;
  apiKey: string | undefined;
  /** Validated at configuration time; `endpointRefusal` explains why it is unusable. */
  endpoint: string;
  /** Set when the configured endpoint is not one this node will call. */
  endpointRefusal: string | undefined;
  /** The exact model id the provider's answer must name; resolved by the provider's adapter. */
  model: string;
  /** Total budget for every call made while composing one turn, including waits. */
  timeoutMs: number;
  /** v1 makes at most two batches; the second exists only when the first changes the candidates. */
  maxCallsPerTurn: number;
  policyVersion: string;
  confidenceFloor: number;
  marginFloor: number;
  noulOnFloor: number;
  noulOffFloor: number;
}

export const JEV_POLICY_VERSION = "2026-09-17";

/** What chose the provider in effect. */
export type DecisionSelectionSource = "settings" | "environment" | "default";

/**
 * The provider an operator selected, or a refusal.
 *
 * An unrecognised name is refused rather than read as the default: an operator who wrote `cloudfare` meant to move
 * decisions away from TypeSafe, and quietly sending them there anyway would be the one outcome they did not choose.
 */
function selectedProvider(env: NodeJS.ProcessEnv): { ok: true; id: DecisionProviderId } | { ok: false; reason: string } {
  const raw = env.CLARKCANT_DECISION_PROVIDER?.trim().toLowerCase() ?? "";
  if (raw === "") return { ok: true, id: DEFAULT_DECISION_PROVIDER };
  const known = DECISION_PROVIDER_IDS.find((id) => id === raw);
  if (known !== undefined) return { ok: true, id: known };
  return {
    ok: false,
    reason: `CLARKCANT_DECISION_PROVIDER names no provider this node knows (${DECISION_PROVIDER_IDS.join(", ")}), so no decision is sent anywhere`,
  };
}

/**
 * The person's Settings choice laid over the operator's environment.
 *
 * The choice wins when there is one, by the same rule a key saved in the vault wins over a variable: it is the person's
 * most recent, explicit statement of who decides. It replaces only the provider, its model and Cloudflare's account id;
 * the local-only flag, the off switch, the budget and the policy version stay the operator's, so a Settings choice can
 * never send an intent from a node configured local-only. A model left in the environment for another provider is not
 * carried into a choice that names none (TypeSafe), so switching back does not leave a request TypeSafe can only refuse.
 */
function withSelection(env: NodeJS.ProcessEnv, selection: DecisionProviderSelection): NodeJS.ProcessEnv {
  const overlaid: NodeJS.ProcessEnv = { ...env, CLARKCANT_DECISION_PROVIDER: selection.provider };
  switch (selection.provider) {
    case "typesafe":
      delete overlaid.CLARKCANT_DECISION_MODEL;
      return overlaid;
    case "cloudflare":
      overlaid.CLARKCANT_DECISION_MODEL = selection.model;
      if (selection.accountId !== undefined) overlaid.CLOUDFLARE_ACCOUNT_ID = selection.accountId;
      return overlaid;
    case "openrouter":
      overlaid.CLARKCANT_DECISION_MODEL = selection.model;
      return overlaid;
  }
}

function flag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Read the provider configuration from the environment.
 *
 * `enabled` is derived rather than configured separately in the common case: a key with no
 * local-only flag means the provider may be used, and no key means it may not. Making those two
 * independent settings would allow the state "enabled with no key", which can only fail at call
 * time.
 */
export function decisionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  /**
   * The key a person typed into the interface, when there is one.
   *
   * Read through a function rather than handed over as a value, so a running node can read it again
   * (`liveDecisionConfig`). The typed key wins when both exist (`provider-credential.ts`): it is the person's most
   * recent statement of which key to use.
   */
  stored?: StoredCredential,
  /** The person's Settings choice (`ai.decisionProvider`), when they made one. `null` follows the environment. */
  selection?: DecisionProviderSelection | null,
): DecisionConfig {
  const effectiveEnv = selection === undefined || selection === null ? env : withSelection(env, selection);
  const selectedBy: DecisionSelectionSource =
    selection !== undefined && selection !== null
      ? "settings"
      : (env.CLARKCANT_DECISION_PROVIDER?.trim() ?? "") === ""
        ? "default"
        : "environment";
  const selected = selectedProvider(effectiveEnv);
  const provider = selected.ok ? selected.id : DEFAULT_DECISION_PROVIDER;
  const resolved = decisionProviderFor(provider).connection(effectiveEnv, stored);
  const connection: DecisionProviderConnection = selected.ok
    ? resolved
    : { ...resolved, apiKey: undefined, endpointRefusal: selected.reason };
  const localOnly = flag(env.CLARKCANT_JEV_LOCAL_ONLY);
  const explicit = env.CLARKCANT_JEV_ENABLED === undefined ? undefined : flag(env.CLARKCANT_JEV_ENABLED);
  const timeoutMs = Number.parseInt(env.CLARKCANT_JEV_TIMEOUT_MS ?? "4000", 10);

  return {
    provider,
    selectedBy,
    enabled: explicit ?? (connection.apiKey !== undefined && !localOnly),
    localOnly,
    apiKey: connection.apiKey,
    endpoint: connection.endpoint,
    endpointRefusal: connection.endpointRefusal,
    model: connection.model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 4000,
    maxCallsPerTurn: 2,
    policyVersion: env.CLARKCANT_JEV_POLICY_VERSION?.trim() || JEV_POLICY_VERSION,
    confidenceFloor: 0.85,
    marginFloor: 0.2,
    noulOnFloor: 0.85,
    noulOffFloor: 0.15,
  };
}

/** The fields a key, a Settings choice or a removed key can change while the node runs. */
const LIVE_FIELDS = ["provider", "selectedBy", "apiKey", "enabled", "endpoint", "endpointRefusal", "model"] as const;

/** How a live configuration resolves itself, kept beside it so `currentDecisionConfig` can take one consistent reading. */
const resolvers = new WeakMap<DecisionConfig, () => DecisionConfig>();

/**
 * The configuration a running node decides with: its credential and its provider are resolved each time a decision
 * reads them.
 *
 * A key saved in the credential card, or removed from it, and a provider chosen in Settings, are used from the next
 * decision on, without a restart. Built once and read at start-up, the card would say "the node is using the new key"
 * while the decider kept the old one, or kept calling with a key the person had removed. Every live field is read
 * through `decisionConfigFromEnv`, so the rules that pick the provider and the key stay the ones above. A field in
 * `overrides` is fixed at the value given, which is how a test pins one.
 */
export function liveDecisionConfig(
  env: NodeJS.ProcessEnv,
  stored: StoredCredential | undefined,
  overrides: Partial<DecisionConfig> = {},
  selection?: () => DecisionProviderSelection | null | undefined,
): DecisionConfig {
  const resolve = (): DecisionConfig => ({ ...decisionConfigFromEnv(env, stored, selection?.()), ...overrides });
  const config: DecisionConfig = resolve();
  for (const field of LIVE_FIELDS) {
    if (field in overrides) continue;
    Object.defineProperty(config, field, {
      enumerable: true,
      get: () => resolve()[field],
    });
  }
  resolvers.set(config, resolve);
  return config;
}

/**
 * One consistent reading of a configuration, for the length of one provider call.
 *
 * Each live field resolves on its own, so a call that read the endpoint, then the key, then the model, could read them
 * across a switch and send one provider's key to another provider's endpoint. A call takes this snapshot once and reads
 * only from it. A configuration that is not live is already consistent and is returned as it is.
 */
export function currentDecisionConfig(config: DecisionConfig): DecisionConfig {
  return resolvers.get(config)?.() ?? config;
}

/**
 * The person's decision provider choice, or `null` when they made none.
 *
 * Read through the preference registry, which already answers a stored value this build cannot parse as the default;
 * parsed again here so the type the config reads is the contract's, not `unknown`.
 */
export function readDecisionSelection(deps: PreferenceDeps, principalId: string): DecisionProviderSelection | null {
  const preference = readRegisteredPreference(deps, { principalId, key: DECISION_PROVIDER_PREFERENCE });
  const parsed = decisionProviderPreferenceSchema.safeParse(preference?.value ?? null);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether a call may be attempted at all.
 *
 * Local-only is checked before the key, because an operator who has forbidden third-party
 * processing must not have that decision reversed by a key appearing in the environment.
 */
export function decisionCallRefusal(config: DecisionConfig): string | undefined {
  if (config.localOnly) return "this node is configured local-only, so no intent is sent to a provider";
  if (config.endpointRefusal !== undefined) return config.endpointRefusal;
  if (!config.enabled) return "the selector is disabled on this node";
  if (config.apiKey === undefined) return "no provider credential is configured on this node";
  return undefined;
}
