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
export const openrouterDecisionModelSchema = z
  .string()
  .regex(OPENROUTER_DECISION_MODEL_PATTERN, "is not a pinned OpenRouter model slug (vendor/model, no ~ alias)");

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

/** The consumer recorded on a decision provider's stored key. */
export function decisionCredentialConsumer(provider: DecisionProviderId): string {
  return `decision:${provider}`;
}
