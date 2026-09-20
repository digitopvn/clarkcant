/**
 * Whether a live voice session could be opened.
 *
 * The voice path itself is real and does not depend on this: the fixture provider drives the same wiring, and
 * parity between a spoken sentence and a click is asserted against the same registry. What cannot be done in this
 * repository is a session against the provider's own service, because that needs an account.
 *
 * So the probe answers with a **named** missing resource rather than a flat "unavailable", and it reports the
 * *names* of what it looked for and never their values: a probe whose job is to run where a credential may be
 * absent must not be the thing that puts one in a log.
 */

export const LIVE_VOICE_PROBE_STATUS = "opt-in-check-implemented";

/** The environment variable the node reads first, before its own vault. */
export const VOICE_CREDENTIAL_ENV = "GEMINI_API_KEY";

export type LiveVoiceProbe =
  | { available: true; source: "environment" | "vault" }
  | { available: false; reason: "requires-live-account"; detail: string };

export interface LiveVoiceProbeInput {
  /** The node's environment. Passed in rather than read here, so the probe can be tested without one. */
  env: Record<string, string | undefined>;
  /** What this node's vault holds for the owner principal, when it holds anything. */
  vaultCredential: string | undefined;
}

/**
 * Ask what is missing.
 *
 * An empty string is treated as absent rather than as a credential: an environment variable that is present and
 * blank is a variable somebody cleared, and handing a blank to the adapter would produce "no credential was
 * provided for the live session" from somewhere much harder to read.
 */
export function probeLiveVoice(input: LiveVoiceProbeInput): LiveVoiceProbe {
  const fromEnvironment = input.env[VOICE_CREDENTIAL_ENV];
  if (typeof fromEnvironment === "string" && fromEnvironment !== "") {
    return { available: true, source: "environment" };
  }
  if (typeof input.vaultCredential === "string" && input.vaultCredential !== "") {
    return { available: true, source: "vault" };
  }
  return {
    available: false,
    reason: "requires-live-account",
    detail: `no voice provider credential: ${VOICE_CREDENTIAL_ENV} is unset and this node's vault holds none for its owner`,
  };
}
