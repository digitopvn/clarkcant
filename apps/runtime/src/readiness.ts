import { CREDENTIAL_VARIABLES, type CredentialSource, providerCredentialSource } from "./provider-credential.ts";

/**
 * The credentials a node already has, by name, and where the one in effect comes from.
 *
 * Two places count, and they are different kinds of answer. The vault is where an interface stores a key somebody typed;
 * the environment is where an operator puts one before the node starts. A first run needs to know whether a question has
 * already been answered, and both are answers. When both hold one, the vault's is the key in effect
 * (`provider-credential.ts`), and the source says so.
 *
 * Only names and sources are ever reported. A node that answered with values would be the place they leaked from, and
 * the whole point of this answer is to let a question be skipped rather than to reveal anything.
 *
 * These are the credential names this node knows how to look for.
 */
export const KNOWN_CREDENTIALS: readonly string[] = Object.keys(CREDENTIAL_VARIABLES);

interface ReadinessInput {
  env: NodeJS.ProcessEnv;
  vault: readonly string[];
}

/**
 * Where each known credential's key in effect comes from: `vault`, `environment` or `none`.
 *
 * A blank environment variable is not an answer: an empty string is what a shell leaves behind when somebody writes
 * `KEY=` in a file to disable it, and treating that as configured would skip a step and leave the node unable to run.
 */
export function credentialSources(input: ReadinessInput): Record<string, CredentialSource> {
  return Object.fromEntries(
    KNOWN_CREDENTIALS.map((name) => [
      name,
      providerCredentialSource({
        inVault: input.vault.includes(name),
        env: input.env,
        variables: CREDENTIAL_VARIABLES[name] ?? [],
      }),
    ]),
  );
}

/** Which of them are already available, from either place. */
export function availableCredentials(input: ReadinessInput): string[] {
  const sources = credentialSources(input);
  return KNOWN_CREDENTIALS.filter((name) => sources[name] !== "none");
}
