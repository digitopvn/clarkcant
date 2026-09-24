import { afterEach, describe, expect, it } from "vitest";

import { commandEnvironment, terminalEnvironment, withheldVariables, withholdFromChildren } from "../src/child-env.ts";

const SOURCE: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/person",
  LANG: "vi_VN.UTF-8",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  GH_TOKEN: "token-from-dotenv",
  TYPESAFE_API_KEY: "node-provider-key",
  MY_OWN_SETTING: "person-set-this",
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("what a command the model runs inherits", () => {
  it("is the allowlist only: no credential and nothing the node did not choose to pass", () => {
    const env = commandEnvironment({}, SOURCE);

    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["LANG"]).toBe("vi_VN.UTF-8");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("TYPESAFE_API_KEY");
    expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(env).not.toHaveProperty("MY_OWN_SETTING");
  });

  it("adds exactly the variables the broker granted this command, unfiltered", () => {
    const env = commandEnvironment({ GH_TOKEN: "granted-for-this-command" }, SOURCE);
    expect(env["GH_TOKEN"]).toBe("granted-for-this-command");
  });
});

describe("what a terminal inherits", () => {
  it("is everything except the provider keys and the names the node itself loaded", () => {
    cleanups.push(withholdFromChildren(() => ["GH_TOKEN"]));

    const env = terminalEnvironment(SOURCE);

    expect(env["SSH_AUTH_SOCK"]).toBe("/tmp/agent.sock");
    expect(env["MY_OWN_SETTING"]).toBe("person-set-this");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("TYPESAFE_API_KEY");
  });

  it("reads the withheld names each time, so a secret stored after boot is withheld from the next shell", () => {
    const stored: string[] = [];
    cleanups.push(withholdFromChildren(() => stored));
    expect(terminalEnvironment(SOURCE)["MY_OWN_SETTING"]).toBe("person-set-this");

    stored.push("MY_OWN_SETTING");

    expect(terminalEnvironment(SOURCE)).not.toHaveProperty("MY_OWN_SETTING");
  });

  it("keeps the fixed list when a registered source throws", () => {
    cleanups.push(
      withholdFromChildren(() => {
        throw new Error("the secret store is locked");
      }),
    );
    expect(withheldVariables().has("TYPESAFE_API_KEY")).toBe(true);
  });
});
