import { describe, expect, it } from "vitest";

import { FakePiAdapter } from "@clarkcant/pi-adapter";
import { createModelCatalogue, createModelTurn } from "../src/model-turn.ts";

/**
 * A node that has never run a model still has to be able to offer one.
 *
 * The picker in Settings is how a node stops having no model, and its list was published only when a model turn
 * already existed — so a fresh node showed an empty list, refused every choice it could not make, and stayed that way.
 * Two things have to be true instead, and each has a test here:
 *
 * - the catalogue is readable **while no model is chosen**, because reading it needs no model;
 * - a **stored choice is reason enough** for the node to run one, with the environment as the fallback rather than
 *   the gate. Without the second, the picker would save a value only the environment could have made meaningful,
 *   which is a control that does nothing while looking like it does something.
 */
const ENV = { CC_MODEL_PROVIDER: "env-provider", CC_MODEL_ID: "env-model" } satisfies NodeJS.ProcessEnv;

function fakeAdapter(): FakePiAdapter {
  return new FakePiAdapter({ script: [] });
}

describe("the catalogue a node shows before it has a model", () => {
  it("is readable while nothing has been chosen, because reading it needs no model", async () => {
    const catalogue = createModelCatalogue({ cwd: process.cwd(), adapter: fakeAdapter() });

    const providers = await catalogue();

    // The fake's catalogue is deliberately wider than one row, so this asserts the list rather than its emptiness.
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0]?.id).toBe("fake");
    expect(providers[0]?.models.length).toBeGreaterThan(1);
  });

  it("reads again on every call, so a provider added to pi appears without a restart", async () => {
    const catalogue = createModelCatalogue({ cwd: process.cwd(), adapter: fakeAdapter() });

    const first = await catalogue();
    const second = await catalogue();

    expect(second).toEqual(first);
  });
});

describe("what makes a node run a model", () => {
  it("a stored choice is enough on its own, with no model in the environment", async () => {
    const turn = await createModelTurn({
      env: {},
      cwd: process.cwd(),
      adapter: fakeAdapter(),
      model: () => ({ provider: "chosen-provider", id: "chosen-model" }),
    });

    expect(turn).toBeDefined();
    expect(turn?.selection).toEqual({ provider: "chosen-provider", id: "chosen-model" });
  });

  it("the stored choice wins over the environment, because it is the more specific statement", async () => {
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter: fakeAdapter(),
      model: () => ({ provider: "chosen-provider", id: "chosen-model" }),
    });

    expect(turn?.selection).toEqual({ provider: "chosen-provider", id: "chosen-model" });
  });

  it("the environment still decides when nothing was chosen", async () => {
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter: fakeAdapter() });

    expect(turn?.selection).toEqual({ provider: "env-provider", id: "env-model" });
  });

  it("neither means no turn at all, which is still the honest answer", async () => {
    // A node with no model is a working node that answers with recipes and installed capabilities. This is the state
    // the catalogue above exists to let somebody leave.
    const turn = await createModelTurn({ env: {}, cwd: process.cwd(), adapter: fakeAdapter() });

    expect(turn).toBeUndefined();
  });
});
