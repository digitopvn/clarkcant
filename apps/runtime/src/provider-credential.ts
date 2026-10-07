/**
 * Which key a provider call uses, when a node could hold two.
 *
 * A provider key can reach a node in two places: the vault, where the credential card writes a key a person typed, and
 * the environment, where an operator puts one before the node starts. When both hold one, the vault wins. Saving a key
 * in the product is the person's most recent, explicit statement of which key to use; a card that said "saved" while
 * an older variable kept answering would be a control that claims something the node does not do. The environment
 * stays the operator's default for a node whose vault holds none.
 *
 * Every provider credential the node resolves goes through `resolveProviderCredential`, so voice, a dispatched task's
 * worker and the decision provider cannot disagree about the rule. What a diagnostic reports is the `source`, never the
 * value: "vault", "environment" or "none".
 *
 * A blank value is no key at all, in either place: `KEY=` in a file is how somebody turns a variable off, and passing a
 * blank on would fail deeper with a message that says less than "none" does.
 */

export type CredentialSource = "vault" | "environment" | "none";

/**
 * The credentials the node stores under a name of its own, and the variables each one's key may arrive under.
 *
 * A dispatched task's worker is not listed: its key is stored under the provider's own name and read from the variable
 * the model adapter names for that provider (`keyVariableFor`).
 */
export const CREDENTIAL_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  /** Gemini Live, for voice (`VOICE_CREDENTIAL_NAME`). */
  gemini: ["GEMINI_API_KEY"],
  /**
   * TypeSafe, for the decision provider. Only the variable it reads: a key under another provider's name is not one
   * Jev can use, and counting it would skip the first run's key step on a node whose selector then stays disabled.
   */
  typesafe: ["TYPESAFE_API_KEY"],
};

/** The key in effect and where it came from. `value` is present exactly when `source` is not `"none"`. */
export type ResolvedCredential =
  | { source: "vault" | "environment"; value: string }
  | { source: "none"; value?: undefined };

export interface ProviderCredentialInput {
  /** What the vault holds under the credential's name, read by the caller at the moment it needs the key. */
  stored: string | undefined;
  /** The node's environment. Passed in rather than read here, so the rule can be tested without one. */
  env: Readonly<Record<string, string | undefined>>;
  /** The variables the provider's key may arrive under, in the order they are read. */
  variables: readonly string[];
}

/** The key a provider call should use: the vault's, else the first non-blank variable, else none. */
export function resolveProviderCredential(input: ProviderCredentialInput): ResolvedCredential {
  const stored = nonBlank(input.stored);
  if (stored !== undefined) return { source: "vault", value: stored };
  for (const variable of input.variables) {
    const value = nonBlank(input.env[variable]);
    if (value !== undefined) return { source: "environment", value };
  }
  return { source: "none" };
}

/**
 * The same rule, answered from the vault's list of names rather than its values.
 *
 * A diagnostic that only needs to say where the key in effect comes from has no reason to read a secret, so it asks
 * whether the vault holds the name. A stored credential is never blank (the vault refuses a value made only of whitespace), so holding
 * the name is holding a key.
 */
export function providerCredentialSource(input: {
  inVault: boolean;
  env: Readonly<Record<string, string | undefined>>;
  variables: readonly string[];
}): CredentialSource {
  if (input.inVault) return "vault";
  return resolveProviderCredential({ stored: undefined, env: input.env, variables: input.variables }).source;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
