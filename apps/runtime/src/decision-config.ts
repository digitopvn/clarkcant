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
   * Read through a function rather than handed over as a value, because it is read when the selector is built and the
   * point of storing one is that it works without restarting the node. The environment wins when both exist: an
   * operator who set it deliberately should not be overridden by a value typed later into a card.
   */
  stored?: StoredCredential,
): DecisionConfig {
  const selected = selectedProvider(env);
  const provider = selected.ok ? selected.id : DEFAULT_DECISION_PROVIDER;
  const resolved = decisionProviderFor(provider).connection(env, stored);
  const connection: DecisionProviderConnection = selected.ok
    ? resolved
    : { ...resolved, apiKey: undefined, endpointRefusal: selected.reason };
  const localOnly = flag(env.CLARKCANT_JEV_LOCAL_ONLY);
  const explicit = env.CLARKCANT_JEV_ENABLED === undefined ? undefined : flag(env.CLARKCANT_JEV_ENABLED);
  const timeoutMs = Number.parseInt(env.CLARKCANT_JEV_TIMEOUT_MS ?? "4000", 10);

  return {
    provider,
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
