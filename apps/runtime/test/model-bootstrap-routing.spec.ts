import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant, UserModelProfile } from "@clarkcant/contracts";
import type { ModelCatalogue } from "@clarkcant/pi-adapter";

import { routeNodeBackgroundModel, routeOrFallBack, workerModelCandidates } from "../src/bootstrap/model-bootstrap.ts";
import { writeModelPool } from "../src/model-registry.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { nodeWorkerModel } from "../src/worker-model.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

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

afterEach(async () => {
  services.runtime.close();
  await removeTestDirectory(dir);
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

describe("why background work falls back to the configured model", () => {
  const stderrLines = (): { lines: string[]; restore: () => void } => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    return { lines, restore: () => (process.stderr.write = original) };
  };

  it("answers the data class when no profile may receive it, and says so on stderr", async () => {
    storePool({ ...profile("narrow", "can-call", 1), allowedDataClasses: ["public", "internal"] });
    services.modelCatalogue = async () => catalogue;
    const captured = stderrLines();
    try {
      expect(await routeNodeBackgroundModel(services, { dataClass: "confidential" })).toEqual({
        fallback: { reason: "data-class", dataClass: "confidential" },
      });
    } finally {
      captured.restore();
    }
    expect(captured.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: "model-route", fallback: "data-class", dataClass: "confidential", rejected: 1 },
    ]);
    // The same profile may receive internal work, so that is routed rather than a fallback.
    expect(await routeNodeBackgroundModel(services, { dataClass: "internal" })).toEqual({ provider: "acme", id: "can-call" });
  });

  it("answers a failed route as a fallback rather than throwing, and says so on stderr without the error", async () => {
    storePool(profile("yes", "can-call", 1));
    services.modelCatalogue = async () => {
      throw new Error("catalogue at C:\\Users\\someone unavailable");
    };
    const captured = stderrLines();
    try {
      expect(await routeOrFallBack(() => services, { dataClass: "internal" })).toEqual({ fallback: { reason: "route-failed" } });
    } finally {
      captured.restore();
    }
    expect(captured.lines).toEqual([`${JSON.stringify({ event: "model-route", fallback: "route-failed" })}\n`]);
  });

  it("says so too when the node cannot give its services yet", async () => {
    const captured = stderrLines();
    try {
      expect(
        await routeOrFallBack(() => {
          throw new Error("services not ready");
        }),
      ).toEqual({ fallback: { reason: "route-failed" } });
    } finally {
      captured.restore();
    }
    expect(captured.lines).toEqual([`${JSON.stringify({ event: "model-route", fallback: "route-failed" })}\n`]);
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

  it("carries the reason routing fell back into the launch, and none when there was none", async () => {
    const launchWith = (fallback?: { reason: "route-failed" }) =>
      nodeWorkerModel({
        modelTurn: {
          workerModel: async () => ({ provider: "acme", id: "can-call", via: "configured", ...(fallback === undefined ? {} : { fallback }) }),
        },
        env: {},
        storedCredential: () => undefined,
      }).launch();
    expect((await launchWith({ reason: "route-failed" }))?.fallback).toEqual({ reason: "route-failed" });
    expect(await launchWith()).not.toHaveProperty("fallback");
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
