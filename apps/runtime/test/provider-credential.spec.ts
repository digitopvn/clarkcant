import { describe, expect, it } from "vitest";

import { nodeVoiceCredential } from "../src/bootstrap/voice-bootstrap.ts";
import { decisionConfigFromEnv } from "../src/decision-config.ts";
import { providerCredentialSource, resolveProviderCredential } from "../src/provider-credential.ts";
import { credentialSources } from "../src/readiness.ts";
import { probeLiveVoice } from "../src/voice-live-check.ts";
import { nodeWorkerModel } from "../src/worker-model.ts";

/**
 * Which key a provider call uses when the vault and the environment both hold one.
 *
 * The key a person saved in the credential card wins; the environment is the default for a node whose vault holds none.
 * The rule lives in one helper, and these tests hold each caller to it, so voice, a dispatched worker and the decision
 * provider cannot drift apart again.
 */

const SAVED = "saved-in-the-card-not-a-real-key";
const FROM_ENV = "set-in-the-environment-not-a-real-key";

describe("the provider credential rule", () => {
  it("uses the vault's key when both places hold one", () => {
    expect(resolveProviderCredential({ stored: SAVED, env: { GEMINI_API_KEY: FROM_ENV }, variables: ["GEMINI_API_KEY"] })).toEqual({
      source: "vault",
      value: SAVED,
    });
  });

  it("falls back to the environment when the vault holds none", () => {
    expect(resolveProviderCredential({ stored: undefined, env: { GEMINI_API_KEY: FROM_ENV }, variables: ["GEMINI_API_KEY"] })).toEqual({
      source: "environment",
      value: FROM_ENV,
    });
  });

  it("answers none when neither holds one, and treats a blank as none in either place", () => {
    expect(resolveProviderCredential({ stored: undefined, env: {}, variables: ["GEMINI_API_KEY"] })).toEqual({ source: "none" });
    expect(resolveProviderCredential({ stored: "  ", env: { GEMINI_API_KEY: "" }, variables: ["GEMINI_API_KEY"] })).toEqual({
      source: "none",
    });
    // A blank saved key does not shadow a real one in the environment.
    expect(resolveProviderCredential({ stored: "", env: { GEMINI_API_KEY: FROM_ENV }, variables: ["GEMINI_API_KEY"] }).source).toBe(
      "environment",
    );
  });

  it("reads only the variables it is given", () => {
    expect(resolveProviderCredential({ stored: undefined, env: { OTHER_API_KEY: FROM_ENV }, variables: ["GEMINI_API_KEY"] })).toEqual({
      source: "none",
    });
    expect(resolveProviderCredential({ stored: undefined, env: { GEMINI_API_KEY: FROM_ENV }, variables: [] }).source).toBe("none");
  });

  it("answers the same source from the vault's names as from its values", () => {
    const env = { GEMINI_API_KEY: FROM_ENV };
    const variables = ["GEMINI_API_KEY"];
    expect(providerCredentialSource({ inVault: true, env, variables })).toBe("vault");
    expect(providerCredentialSource({ inVault: false, env, variables })).toBe("environment");
    expect(providerCredentialSource({ inVault: false, env: {}, variables })).toBe("none");
  });
});

describe("voice uses the key saved in the card", () => {
  it("opens a session and the recognizer on the vault's key when the environment also holds one", () => {
    const credential = nodeVoiceCredential({ fixture: false, env: { GEMINI_API_KEY: FROM_ENV }, stored: () => SAVED });
    expect(credential()).toBe(SAVED);
  });

  it("uses the environment's key when nothing was saved, and none when neither holds one", () => {
    expect(nodeVoiceCredential({ fixture: false, env: { GEMINI_API_KEY: FROM_ENV }, stored: () => undefined })()).toBe(FROM_ENV);
    expect(nodeVoiceCredential({ fixture: false, env: {}, stored: () => undefined })()).toBeUndefined();
  });

  it("reads the vault when a session opens, so a key saved while the node runs is the next one used", () => {
    const vault: { gemini?: string } = {};
    const credential = nodeVoiceCredential({ fixture: false, env: { GEMINI_API_KEY: FROM_ENV }, stored: () => vault.gemini });
    expect(credential()).toBe(FROM_ENV);
    vault.gemini = SAVED;
    expect(credential()).toBe(SAVED);
  });

  it("reports the vault as the probe's source when both hold one", () => {
    expect(probeLiveVoice({ env: { GEMINI_API_KEY: FROM_ENV }, vaultCredential: SAVED })).toEqual({ available: true, source: "vault" });
  });
});

describe("a dispatched worker uses the key saved for its provider", () => {
  const launch = (env: Record<string, string>, stored: string | undefined) =>
    nodeWorkerModel({
      modelTurn: { workerModel: async () => ({ provider: "google", id: "gemini-test", via: "configured" }) },
      env,
      storedCredential: (name) => (name === "google" ? stored : undefined),
    }).launch();

  it("hands the worker the stored key, and records it as stored, when the environment also holds one", async () => {
    const started = await launch({ GEMINI_API_KEY: FROM_ENV }, SAVED);
    expect(started?.credential).toBe(SAVED);
    expect(started?.credentialSource).toBe("stored");
  });

  it("falls back to the environment, then to the model runtime's own configuration", async () => {
    const fromEnvironment = await launch({ GEMINI_API_KEY: FROM_ENV }, undefined);
    expect(fromEnvironment?.credential).toBe(FROM_ENV);
    expect(fromEnvironment?.credentialSource).toBe("environment");

    const neither = await launch({}, undefined);
    expect(neither).not.toHaveProperty("credential");
    expect(neither?.credentialSource).toBe("model-config");
  });
});

describe("the decision provider uses the key saved in the card", () => {
  it("prefers the stored TypeSafe key over the environment's", () => {
    expect(decisionConfigFromEnv({ TYPESAFE_API_KEY: FROM_ENV }, () => SAVED).apiKey).toBe(SAVED);
    expect(decisionConfigFromEnv({ TYPESAFE_API_KEY: FROM_ENV }, () => undefined).apiKey).toBe(FROM_ENV);
    expect(decisionConfigFromEnv({}, () => undefined).apiKey).toBeUndefined();
  });
});

describe("the diagnostic says which source is in effect", () => {
  it("names the source for each credential and carries no value", () => {
    const env = { GEMINI_API_KEY: FROM_ENV, TYPESAFE_API_KEY: FROM_ENV };
    const sources = credentialSources({ env, vault: ["gemini"] });
    expect(sources).toEqual({ gemini: "vault", typesafe: "environment" });
    expect(JSON.stringify(sources)).not.toContain(FROM_ENV);
    expect(credentialSources({ env: {}, vault: [] })).toEqual({ gemini: "none", typesafe: "none" });
  });
});
