import { describe, expect, it } from "vitest";

import { jevConfigFromEnv } from "../src/jev-selector.ts";

/**
 * The key a person types into the interface.
 *
 * The decider read its credential from the environment only, which made the TypeSafe field in settings pointless: a
 * key that is stored, reported as saved, and then never used is worse than no field at all, because the interface
 * said it worked.
 */
describe("the decider's key", () => {
  it("comes from the interface when the environment has none", () => {
    expect(jevConfigFromEnv({}, () => "stored-key").apiKey).toBe("stored-key");
  });

  it("uses the key saved in the interface over one in the environment", () => {
    // The person saved this key here, after whatever the environment was started with, and the card says it is in use;
    // every provider credential takes the saved key first.
    expect(jevConfigFromEnv({ TYPESAFE_API_KEY: "env-key" }, () => "stored-key").apiKey).toBe("stored-key");
  });

  it("falls back to the environment when nothing is saved", () => {
    expect(jevConfigFromEnv({ TYPESAFE_API_KEY: "env-key" }, () => undefined).apiKey).toBe("env-key");
  });

  it("enables the provider, because a key with no local-only flag means it may be used", () => {
    expect(jevConfigFromEnv({}, () => "stored-key").enabled).toBe(true);
  });

  it("treats a blank stored value as no key at all", () => {
    expect(jevConfigFromEnv({}, () => "   ").apiKey).toBeUndefined();
    expect(jevConfigFromEnv({}, () => "   ").enabled).toBe(false);
    expect(jevConfigFromEnv({}).apiKey).toBeUndefined();
  });
});
