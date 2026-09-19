import { describe, expect, it } from "vitest";

import { firstRunSteps } from "../src/first-run.ts";

describe("the steps a first run shows", () => {
  it("walks everything on a node that has been told nothing", () => {
    expect(firstRunSteps({ model: false, credentials: [] })).toEqual(["welcome", "provider", "model", "key"]);
  });

  it("skips straight through on a node whose environment already answered", () => {
    // The case this exists for: a filled-in .env means there is nothing to ask, and asking anyway asks somebody to
    // retype a key the machine already has.
    expect(firstRunSteps({ model: true, credentials: ["gemini", "typesafe"] })).toEqual(["welcome"]);
  });

  it("asks only for what is actually missing", () => {
    expect(firstRunSteps({ model: true, credentials: [] })).toEqual(["welcome", "key"]);
    expect(firstRunSteps({ model: false, credentials: ["typesafe"] })).toEqual(["welcome", "provider", "model"]);
    // Gemini is not a step here at all: the voice surface asks for it where it is used, with the reason in front of the
    // person, rather than as a form on a screen about something they have not tried yet.
    expect(firstRunSteps({ model: true, credentials: ["gemini"] })).toEqual(["welcome", "key"]);
  });
});
