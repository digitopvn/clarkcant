/**
 * The credentials a node already has, by name.
 *
 * Two places count, and they are different kinds of answer. The vault is where an interface stores a key somebody typed;
 * the environment is where an operator puts one before the node starts. A first run needs to know whether a question has
 * already been answered, and both are answers.
 *
 * Only names are ever reported. A node that answered with values would be the place they leaked from, and the whole point
 * of this answer is to let a question be skipped rather than to reveal anything.
 */
const ENV_BY_CREDENTIAL: Record<string, readonly string[]> = {
  gemini: ["GEMINI_API_KEY"],
  // Either name counts: the node reads both, so a first run that skipped while only one was set would be skipping a
  // question it still needs the answer to.
  typesafe: ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"],
};

/** The credential names this node knows how to look for. */
export const KNOWN_CREDENTIALS: readonly string[] = Object.keys(ENV_BY_CREDENTIAL);

/**
 * Which of them are already available.
 *
 * A blank environment variable is not an answer: an empty string is what a shell leaves behind when somebody writes
 * `KEY=` in a file to disable it, and treating that as configured would skip a step and leave the node unable to run.
 */
export function availableCredentials(input: {
  env: NodeJS.ProcessEnv;
  vault: readonly string[];
}): string[] {
  return KNOWN_CREDENTIALS.filter(
    (name) =>
      input.vault.includes(name) ||
      (ENV_BY_CREDENTIAL[name] ?? []).some((variable) => (input.env[variable] ?? "").trim() !== ""),
  );
}
