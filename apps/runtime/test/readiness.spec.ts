import { describe, expect, it } from "vitest";

import { availableCredentials, KNOWN_CREDENTIALS } from "../src/readiness.ts";

describe("what a node already has", () => {
  it("counts a key in the vault and a key in the environment the same way", () => {
    expect(availableCredentials({ env: {}, vault: ["typesafe"] })).toEqual(["typesafe"]);
    expect(availableCredentials({ env: { TYPESAFE_API_KEY: "set" }, vault: [] })).toEqual(["typesafe"]);
    expect(availableCredentials({ env: { GEMINI_API_KEY: "set", TYPESAFE_API_KEY: "set" }, vault: [] })).toEqual([
      "gemini",
      "typesafe",
    ]);
  });

  it("treats a blank variable as unanswered, because that is what disabling one looks like", () => {
    // `KEY=` in a file is how somebody turns a key off, and skipping a step on the strength of it would leave the node
    // unable to run while the first run said everything was ready.
    expect(availableCredentials({ env: { TYPESAFE_API_KEY: "   " }, vault: [] })).toEqual([]);
    expect(availableCredentials({ env: { TYPESAFE_API_KEY: "" }, vault: [] })).toEqual([]);
  });

  it("reports names only, and only ones it knows how to look for", () => {
    const names = availableCredentials({ env: { SOMETHING_ELSE: "set" }, vault: ["unrelated"] });
    expect(names).toEqual([]);
    // Every name it can report is one the interface has a field for; an unknown name would be a step nobody can take.
    expect(KNOWN_CREDENTIALS.length).toBeGreaterThan(0);
  });
});
