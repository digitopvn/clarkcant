import { describe, expect, it } from "vitest";

import { LIVE_VOICE_PROBE_STATUS, VOICE_CREDENTIAL_ENV, probeLiveVoice } from "../src/voice-live-check.ts";

/**
 * The live voice check (V17).
 *
 * The live-provider checks in this repository are opt-in, and this is the half of one that runs everywhere: the
 * probe says which resource is missing, by name, so a reader can tell "this node has no account" apart from "this
 * node's voice path is broken". The session against the provider's own service is not attempted here — it needs a
 * real account, which is exactly what the probe reports.
 *
 * `CC_VOICE_FIXTURE=1` drives the same wiring with a scripted provider, and that path is asserted end to end in
 * `apps/web/e2e/voice-control.spec.ts` and `voice-bar.spec.ts`, where a sentence and a click are compared.
 */

describe("the live voice probe", () => {
  it("names the provider account as what is missing", () => {
    const probe = probeLiveVoice({ env: {}, vaultCredential: undefined });

    expect(probe.available).toBe(false);
    expect(probe.available ? "" : probe.reason).toBe("requires-live-account");
    expect(probe.available ? "" : probe.detail).toContain(VOICE_CREDENTIAL_ENV);
  });

  it("reports the names it looked for and never a value", () => {
    /*
     * The assertion that matters for a probe. It runs precisely where a credential may be absent, and an answer that
     * carried the value would put a credential into every log, audit record and error message the answer reaches.
     */
    const secret = "not-a-real-credential-value-8f3a";
    const missing = probeLiveVoice({ env: { [VOICE_CREDENTIAL_ENV]: "" }, vaultCredential: undefined });
    const present = probeLiveVoice({ env: { [VOICE_CREDENTIAL_ENV]: secret }, vaultCredential: undefined });

    expect(JSON.stringify(missing)).not.toContain(secret);
    // And the available answer is a source, not the credential: there is no field here a value could travel in.
    expect(JSON.stringify(present)).not.toContain(secret);
    expect(present).toEqual({ available: true, source: "environment" });
  });

  it("treats a blank variable as absent rather than as a credential", () => {
    // A variable somebody cleared is not a credential, and passing it on would fail deeper with a message that says
    // less than this one does.
    const probe = probeLiveVoice({ env: { [VOICE_CREDENTIAL_ENV]: "" }, vaultCredential: undefined });
    expect(probe.available ? "" : probe.reason).toBe("requires-live-account");
  });

  it("finds a credential the person typed into the node's own vault", () => {
    // The vault is checked second because the environment wins, and both are real: a key typed into the credential
    // card is a key the person expects to be used.
    const probe = probeLiveVoice({ env: {}, vaultCredential: "stored-in-the-vault" });
    expect(probe).toEqual({ available: true, source: "vault" });
  });

  it("says which status it is, so a reader knows this is the half that runs", () => {
    expect(LIVE_VOICE_PROBE_STATUS).toBe("opt-in-check-implemented");
  });
});
