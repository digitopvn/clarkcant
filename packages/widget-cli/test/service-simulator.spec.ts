import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  actionAvailability,
  actionResult,
  initialServiceState,
  readServiceSimulator,
  serviceStatus,
  transitionServiceState,
} from "../src/service-simulator.ts";
import { initialState, applyShellAction } from "../src/dev-shell.ts";

const created: string[] = [];
const capability = "com.example.notes.add@1";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "clark-service-simulator-"));
  created.push(root);
  mkdirSync(join(root, "fixtures"));
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("service simulator fixtures", () => {
  it("loads bounded data bindings only for capabilities declared by the package", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "fixtures", "dev-host-services.json"), JSON.stringify({ bindings: [
      { actionBindingId: "notes.list", capabilityRef: capability, outcome: { status: "accepted", message: "Loaded" } },
    ] }));

    expect(readServiceSimulator(root, [capability])).toMatchObject({
      capabilities: [capability],
      bindings: [{ actionBindingId: "notes.list", capabilityRef: capability }],
    });
    expect(() => readServiceSimulator(root, [])).toThrow(/undeclared capability/);
  });

  it("refuses an oversized fixture and a duplicate action binding", () => {
    const root = fixtureRoot();
    const path = join(root, "fixtures", "dev-host-services.json");
    writeFileSync(path, " ".repeat(32 * 1024 + 1));
    expect(() => readServiceSimulator(root, [capability])).toThrow(/exceeds/);

    writeFileSync(path, JSON.stringify({ bindings: [
      { actionBindingId: "same", capabilityRef: capability, outcome: {} },
      { actionBindingId: "same", capabilityRef: capability, outcome: {} },
    ] }));
    expect(() => readServiceSimulator(root, [capability])).toThrow(/repeats action binding/);
  });
});

describe("service readiness and bridge outcomes", () => {
  it("preserves host capability denial while simulating readiness and offline precedence", () => {
    const loading = initialServiceState([capability]);
    expect(loading[capability]).toBeDefined();
    expect(loading[capability] === undefined ? "missing" : serviceStatus(loading[capability])).toBe("loading");
    const ready = transitionServiceState(loading, capability, "ready");
    const bindings = [{ actionBindingId: "notes.list", capabilityRef: capability, outcome: {} }];

    expect(actionAvailability({ bindings, readiness: ready, offline: false })).toEqual([
      { actionBindingId: "notes.list", available: true },
    ]);
    expect(actionAvailability({ bindings, readiness: ready, offline: true })[0]).toMatchObject({
      available: false,
      reason: "the node is offline",
    });

    const shell = initialState({ fixtures: ["default"], requestedCapabilities: [capability], serviceCapabilities: [capability] });
    expect(shell.capabilities[capability]).toBe("denied");
    const simulatedReady = applyShellAction(shell, { kind: "service-readiness", value: "ready", capabilityRef: capability, status: "ready" }, {
      fixtures: ["default"], capabilities: [capability], serviceCapabilities: [capability],
    });
    expect(simulatedReady.capabilities[capability]).toBe("denied");
    expect(serviceStatus(simulatedReady.serviceReadiness[capability]!)).toBe("ready");
    expect(applyShellAction(simulatedReady, {
      kind: "service-readiness", value: "ready", capabilityRef: "not-declared@1", status: "ready",
    }, { fixtures: ["default"], capabilities: [capability], serviceCapabilities: [capability] })).toBe(simulatedReady);
  });

  it("turns malformed outcomes into a bridge-valid refusal", () => {
    const result = actionResult({
      nonce: "dev-nonce-1234567890",
      actionBindingId: "notes.list",
      invocationId: "invocation-1",
      outcome: { status: "invalid", message: "" },
    });
    expect(result).toMatchObject({
      kind: "action-result",
      status: "refused",
      message: "the configured service fixture returned a malformed response",
    });
  });
});
