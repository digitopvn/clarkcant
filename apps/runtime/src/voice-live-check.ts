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

import { CREDENTIAL_VARIABLES, type ResolvedCredential, resolveProviderCredential } from "./provider-credential.ts";

export const LIVE_VOICE_PROBE_STATUS = "opt-in-check-implemented";

/** The environment variable the node reads when its own vault holds no voice key. */
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
  const key = voiceCredential(input);
  if (key.source !== "none") return { available: true, source: key.source };
  return {
    available: false,
    reason: "requires-live-account",
    detail: `no voice provider credential: ${VOICE_CREDENTIAL_ENV} is unset and this node's vault holds none for its owner`,
  };
}

/**
 * The voice key in effect: the vault's when it holds one, else the environment's (`provider-credential.ts`).
 *
 * The one place voice resolves its key, used by the live session, the dedicated recognizer and this probe alike, so a
 * probe cannot report one source while a session opens on another.
 */
export function voiceCredential(input: LiveVoiceProbeInput): ResolvedCredential {
  return resolveProviderCredential({
    stored: input.vaultCredential,
    env: input.env,
    variables: CREDENTIAL_VARIABLES["gemini"] ?? [VOICE_CREDENTIAL_ENV],
  });
}