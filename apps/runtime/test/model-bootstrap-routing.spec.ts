import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant, UserModelProfile } from "@clarkcant/contracts";
import type { ModelCatalogue } from "@clarkcant/pi-adapter";

import { routeNodeBackgroundModel, workerModelCandidates } from "../src/bootstrap/model-bootstrap.ts";
import { writeModelPool } from "../src/model-registry.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { nodeWorkerModel } from "../src/worker-model.ts";

/**
 * The node's own background routing, as the model turn calls it: the pool it stores, the catalogue it reads, and what
 * that catalogue states about tool calling.
 */

const AT = "2026-09-30T10:00:00.000Z" as Instant;

let dir: string;
let services: NodeServices;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-routing-"));
  services = bootNodeServices({ dataDir: dir, label: "routing test node" });
  // Every profile here is on the provider this node runs, so every one counts as having a key.
  services.model = { provider: "acme", id: "can-call", maxWallClockMs: 60_000, maxTokens: 32_000 };
  // No policy layer: with it, two eligible profiles would be put to a model, and what is tested here is the filter.
  const { decider: _decider, ...projects } = services.projects;
  services.projects = projects;
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function profile(alias: string, modelId: string, priority: number, enabled = true): UserModelProfile {
  return {
    modelProfileId: `profile_${alias}`,
    alias,
    provider: "acme",
    modelId,
    enabled,
    roles: ["background"],
    priority,
  };
}

function storePool(...profiles: UserModelProfile[]): void {
  writeModelPool(services.runtime.db, services.runtime.identity.ownerPrincipalId, { profiles }, AT);
}

const catalogue: ModelCatalogue = [
  {
    id: "acme",
    models: [
      { provider: "acme", id: "can-call", current: true, toolCalls: true },
      { provider: "acme", id: "cannot-call", current: false, toolCalls: false },
      { provider: "acme", id: "never-said", current: false },
    ],
  },
];

describe("the node's background routing reads tool support from its catalogue", () => {
  it("routes around a profile the catalogue states cannot call tools, even when it comes first", async () => {
    storePool(profile("no", "cannot-call", 1), profile("yes", "can-call", 2));
    services.modelCatalogue = async () => catalogue;

    expect(await routeNodeBackgroundModel(services)).toEqual({ provider: "acme", id: "can-call" });
  });

  it("routes to a profile the catalogue says nothing about, because unknown is not no", async () => {
    storePool(profile("no", "cannot-call", 1), profile("unknown", "never-said", 2));
    services.modelCatalogue = async () => catalogue;

    expect(await routeNodeBackgroundModel(services)).toEqual({ provider: "acme", id: "never-said" });
  });

  it("routes nowhere when every profile is stated unable to call tools, so the configured model is what is checked", async () => {
    storePool(profile("no", "cannot-call", 1));
    services.modelCatalogue = async () => catalogue;

    expect(await routeNodeBackgroundModel(services)).toBeUndefined();
  });
});

describe("whether a dispatched worker's model can call tools", () => {
  const source = (
    candidates: readonly { provider: string; id: string }[],
    read: () => Promise<ModelCatalogue> = async () => catalogue,
  ) =>
    nodeWorkerModel({
      modelTurn: { workerModel: async () => ({ provider: "acme", id: "cannot-call", via: "configured" }), catalogue: read },
      candidates: () => candidates,
      env: {},
      storedCredential: () => undefined,
    });

  it("is no only when the catalogue states no for every model a worker could run on", async () => {
    expect(await source([{ provider: "acme", id: "cannot-call" }]).toolCalls?.()).toBe(false);
    expect(await source([{ provider: "acme", id: "can-call" }]).toolCalls?.()).toBe(true);
    // One stated yes, or one unknown, among the no's leaves the answer open.
    expect(await source([{ provider: "acme", id: "cannot-call" }, { provider: "acme", id: "can-call" }]).toolCalls?.()).toBeUndefined();
    expect(await source([{ provider: "acme", id: "cannot-call" }, { provider: "acme", id: "never-said" }]).toolCalls?.()).toBeUndefined();
    expect(await source([]).toolCalls?.()).toBeUndefined();
  });

  it("is unknown when the catalogue cannot be read, never no", async () => {
    const unreadable = source([{ provider: "acme", id: "cannot-call" }], async () => {
      throw new Error("catalogue unavailable");
    });
    expect(await unreadable.toolCalls?.()).toBeUndefined();
    expect((await unreadable.launch())?.toolCalls).toBeUndefined();
  });

  it("carries what the catalogue states about the model a launch chose", async () => {
    expect((await source([]).launch())?.toolCalls).toBe(false);
  });
});

describe("the models a dispatched worker could be started on", () => {
  it("are the configured model and every enabled profile of the pool", () => {
    storePool(profile("no", "cannot-call", 1), profile("off", "can-call", 2, false), profile("unknown", "never-said", 3));

    expect(workerModelCandidates(services, { provider: "acme", id: "configured" })).toEqual([
      { provider: "acme", id: "configured" },
      { provider: "acme", id: "cannot-call" },
      { provider: "acme", id: "never-said" },
    ]);
    expect(workerModelCandidates(services, undefined)).toEqual([
      { provider: "acme", id: "cannot-call" },
      { provider: "acme", id: "never-said" },
    ]);
  });
});
