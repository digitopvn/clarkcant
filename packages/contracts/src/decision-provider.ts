import { z } from "zod";

/**
 * Who fills the decision role, as a person chooses it in Settings.
 *
 * The decision model is a role, separate from the conversation model: Pi answers the conversation, and a decision
 * provider answers the small typed questions Clark's policy asks (which template, which project, is this ambiguous).
 * TypeSafe Jev, Cloudflare Clef and OpenRouter's decisions API are providers that can fill it.
 *
 * Every value here is bounded, because choosing a provider decides where a redacted intent may be sent. No field is a
 * URL: each provider's endpoint is fixed or built from validated parts by its adapter, so no setting can point the node
 * at an arbitrary host.
 */

export const DECISION_PROVIDER_IDS = Object.freeze(["typesafe", "cloudflare", "openrouter"] as const);
export type DecisionProviderId = (typeof DECISION_PROVIDER_IDS)[number];
export const decisionProviderIdSchema = z.enum(DECISION_PROVIDER_IDS);

/** The registered preference that holds the person's choice. `null`, the default, follows the node's environment. */
export const DECISION_PROVIDER_PREFERENCE = "ai.decisionProvider";

export const CLOUDFLARE_DECISION_MODELS = Object.freeze(["clef", "clef-flash"] as const);
export const cloudflareDecisionModelSchema = z.enum(CLOUDFLARE_DECISION_MODELS);

/** A Cloudflare account id is 32 hexadecimal characters. Anything else never reaches a URL. */
export const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
export const cloudflareAccountIdSchema = z.string().regex(CLOUDFLARE_ACCOUNT_ID_PATTERN, "is not a Cloudflare account id");

/**
 * An OpenRouter model slug, pinned: `vendor/model`, lower case, bounded.
 *
 * An alias (`~typesafe/jev-latest`) is refused. A pinned model is what keeps one policy from being evaluated against a
 * model that changed underneath it, and an alias is by definition a model that changes.
 */
export const OPENROUTER_DECISION_MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,95}$/;

/**
 * Whether a slug names one of OpenRouter's own routers (`openrouter/auto`, and anything else under the `openrouter/`
 * vendor) rather than a model. A router picks a different model per request, so its answer never names the pinned slug
 * and every decision would be refused as drift: a choice that can never answer is refused when it is saved instead.
 */
export function isOpenrouterRouterSlug(slug: string): boolean {
  return slug.startsWith("openrouter/");
}

export const openrouterDecisionModelSchema = z
  .string()
  .regex(OPENROUTER_DECISION_MODEL_PATTERN, "is not a pinned OpenRouter model slug (vendor/model, no ~ alias)")
  .refine((slug) => !isOpenrouterRouterSlug(slug), "is an OpenRouter router, which never answers as one pinned model");

export const decisionProviderSelectionSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("typesafe") }),
  z.strictObject({
    provider: z.literal("cloudflare"),
    model: cloudflareDecisionModelSchema,
    /** Absent means the node's `CLOUDFLARE_ACCOUNT_ID`. Not a secret, but still only ever a validated id. */
    accountId: cloudflareAccountIdSchema.optional(),
  }),
  z.strictObject({ provider: z.literal("openrouter"), model: openrouterDecisionModelSchema }),
]);
export type DecisionProviderSelection = z.infer<typeof decisionProviderSelectionSchema>;

export const decisionProviderPreferenceSchema = decisionProviderSelectionSchema.nullable();

/**
 * The vault name each provider's key is stored under.
 *
 * TypeSafe keeps `typesafe`, the name its card has always written. The others are host-owned names the generic
 * credential store refuses, so a secret somebody stored for another consumer (a `cloudflare` token for a deploy
 * command) can never become a decision provider's bearer, and a decision key cannot be replaced from a form.
 */
export const DECISION_CREDENTIAL_NAMES: Readonly<Record<DecisionProviderId, string>> = Object.freeze({
  typesafe: "typesafe",
  cloudflare: "decision:cloudflare",
  openrouter: "decision:openrouter",
});

/** The host-owned names, which only the decision provider's own credential route may write. */
export const HOST_OWNED_DECISION_CREDENTIALS: readonly string[] = Object.freeze([
  DECISION_CREDENTIAL_NAMES.cloudflare,
  DECISION_CREDENTIAL_NAMES.openrouter,
]);

/**
 * Why decisions do or do not leave the node right now.
 *
 * - `ready`: a call would be attempted.
 * - `local-only`: the operator forbids third-party processing; nothing is sent whatever is chosen.
 * - `misconfigured`: the configuration names no endpoint this node will call (a missing model or account id).
 * - `no-credential`: no key, in the vault or the environment.
 * - `disabled`: the operator switched decisions off (`CLARKCANT_JEV_ENABLED=0`).
 */
export const DECISION_PROVIDER_STATUSES = Object.freeze(["ready", "local-only", "misconfigured", "no-credential", "disabled"] as const);
export type DecisionProviderStatus = (typeof DECISION_PROVIDER_STATUSES)[number];

/** What chose the provider in effect: the person in Settings, the node's environment, or neither (TypeSafe). */
export type DecisionSelectionSource = "settings" | "environment" | "default";

/** Where a decision provider's key comes from: the node's vault, its environment, or nowhere. Never the key. */
export type DecisionCredentialSource = "vault" | "environment" | "none";

/**
 * `GET /decision-provider`: who decides on this node, with which model, with a key from where, and whether the last
 * call worked. Names, sources and reasons only: never a key, never a length, never a request body.
 */
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
  credential: { name: string; source: DecisionCredentialSource };
  /**
   * Cloudflare only: where the account id comes from. The id is not a secret: one the person chose is returned in
   * `selection` so the card can show it; one from the environment is named by its source only.
   */
  account?: { source: "settings" | "environment" | "none" };
  /** A change to the provider, its model or its key applies from the next decision; nothing restarts. */
  applies: "next-decision";
  /** What every decision falls back to when the provider cannot answer. */
  fallback: "deterministic";
  /** The most recent provider call or refusal on this node since it started. No body, no key, no prompt. */
  lastCall?: {
    event: "call" | "refusal" | "policy" | "model_drift" | "error" | "oversized_state";
    status: "answered" | "abstained" | "unavailable";
    model: string;
    durationMs: number;
    reason?: string;
  };
  /** Every provider this node can use, for the selector, each with where its key would come from. */
  providers: {
    id: DecisionProviderId;
    /** The models a person may choose from, or `null` when the provider takes a pinned slug. */
    models: readonly string[] | null;
    credential: { name: string; source: DecisionCredentialSource };
  }[];
}

/** The consumer recorded on a decision provider's stored key. */
export function decisionCredentialConsumer(provider: DecisionProviderId): string {
  return `decision:${provider}`;
}
