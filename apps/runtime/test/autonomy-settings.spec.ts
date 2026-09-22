import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type ExecutionPolicyConfig,
  type Instant,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, readExecutionPolicy } from "@clarkcant/core";
import { migrate, openDatabase, type Database } from "@clarkcant/storage";

import {
  policyFromAutonomySettings,
  projectPolicyPreference,
  readAutonomySettings,
  saveAutonomySettings,
  writePolicyPreference,
} from "../src/autonomy-settings.ts";
import { readRegisteredPreference, writeRegisteredPreference, type PreferenceDeps } from "@clarkcant/core";
import { handleRequest, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The compatibility surface around the one policy.
 *
 * Two shapes still exist in the product that predate it: the five fields the Control tab posts, and the two
 * registered preference keys a surface may still spell the mode and the rules in. Both are views here — never
 * a second copy — and the property under test is the one that matters for a view: reading it and writing it
 * back unchanged must not move anything, and writing part of it must not delete the part it cannot name.
 */

const PRINCIPAL = "prin_owner";
const AT = "2026-09-21T12:00:00.000Z" as Instant;

let db: Database;
let deps: PreferenceDeps;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  deps = { db, now: () => AT };
});

function storedPolicy(): ExecutionPolicyConfig {
  return readExecutionPolicy(deps, PRINCIPAL);
}

function writePolicy(value: ExecutionPolicyConfig): void {
  const outcome = writeRegisteredPreference(deps, {
    principalId: PRINCIPAL,
    key: EXECUTION_POLICY_PREFERENCE_KEY,
    value,
    source: "user",
  });
  if (!outcome.ok) throw new Error(outcome.message);
}

describe("the five fields the panel posts", () => {
  it("reads the canonical policy, not a default of its own", () => {
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "guarded" });
    expect(readAutonomySettings(deps, PRINCIPAL).executionPolicy).toBe("guarded");
  });

  it("says a node-wide refusal as the refusal option, not as the mode it wraps", () => {
    // The one case AC-2 named: a node that refuses everything must not be displayed as merely "Guarded".
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, prohibition: "all" });
    expect(readAutonomySettings(deps, PRINCIPAL).executionPolicy).toBe("deny");
  });

  it("leaves the rules alone when a write through the legacy shape cannot name them", () => {
    /*
     * The legacy shape has no rule table. A panel that edits the guardrail switches and saves must not therefore
     * delete a refusal the user wrote somewhere else — that would be a widening performed by a save button.
     */
    writePolicy({
      ...DEFAULT_EXECUTION_POLICY_CONFIG,
      rules: [
        { effectCategory: "financial", decision: "deny" },
        { effectCategory: "external-write", decision: "execute" },
      ],
    });
    const current = storedPolicy();

    const next = policyFromAutonomySettings(current, { executionPolicy: "guarded", jevGuardrails: true });

    expect(next.rules).toEqual(current.rules);
    expect(next.mode).toBe("guarded");
  });

  it("stores what it is given, and does not keep a parallel row of its own", () => {
    const saved = saveAutonomySettings(deps, PRINCIPAL, {
      executionPolicy: "confirm",
      jevGuardrails: false,
      instructions: "never delete git repositories",
      guardedClasses: ["financial"],
      whenJevUnavailable: "deny",
    });
    if (!saved.ok) throw new Error(saved.message);
    const stored = saved.stored;

    expect(stored.mode).toBe("ask");
    expect(stored.guardrails).toEqual({
      enabled: false,
      instructions: "never delete git repositories",
      classes: ["financial"],
      whenUnavailable: "deny",
    });
    // Read back through the reader, not through a cached value.
    expect(storedPolicy()).toEqual(stored);
  });

  it("does not lift a refusal the user set, and does not move the mode of its own accord", () => {
    /*
     * The legacy five fields have no way to say "not a refusal" and no way to say "leave the mode alone":
     * `parseAutonomySettings` fills a gap with the legacy default, so a partial body reads as if the person had
     * chosen `guarded` and `none`. A write through this shape is therefore a patch over the policy — it may add a
     * refusal (the `deny` option is the legacy spelling of that) and it may not clear one.
     */
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "guarded", prohibition: "all" });

    const named = saveAutonomySettings(deps, PRINCIPAL, { executionPolicy: "guarded" });
    expect(named.ok).toBe(true);
    expect(storedPolicy().prohibition).toBe("all");
    expect(storedPolicy().mode).toBe("guarded");

    // A body that names nothing at all moves nothing, including the mode the legacy default would have named.
    const empty = saveAutonomySettings(deps, PRINCIPAL, {});
    expect(empty.ok).toBe(true);
    expect(storedPolicy().mode).toBe("guarded");
    expect(storedPolicy().prohibition).toBe("all");
  });

  it("moves the mode when the body names the legacy policy, and adds a refusal when it names deny", () => {
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "autonomous" });

    const confirm = saveAutonomySettings(deps, PRINCIPAL, { executionPolicy: "confirm" });
    expect(confirm.ok).toBe(true);
    expect(storedPolicy().mode).toBe("ask");

    const deny = saveAutonomySettings(deps, PRINCIPAL, { executionPolicy: "deny" });
    expect(deny.ok).toBe(true);
    expect(storedPolicy().prohibition).toBe("all");
    expect(readAutonomySettings(deps, PRINCIPAL).executionPolicy).toBe("deny");
  });

  it("reports a refused write instead of the policy it could not store", () => {
    /*
     * Seventeen classes is more than the canonical list holds, and the registry validates before it stores. The
     * outcome is what tells the caller which of the two happened — the panel renders this as the state of the
     * node, and a body it refused reported as stored would describe a change that never happened.
     */
    const refuse = saveAutonomySettings(deps, PRINCIPAL, {
      executionPolicy: "guarded",
      jevGuardrails: true,
      instructions: "",
      guardedClasses: Array.from({ length: 17 }, () => "commands"),
      whenJevUnavailable: "allow",
    });

    expect(refuse.ok).toBe(false);
    if (refuse.ok) throw new Error("expected a refusal");
    expect(refuse.code).toBe("PREFERENCE_INVALID");
    expect(refuse.message).toContain("classes");
    // Nothing was stored: the node still runs under the default policy.
    expect(storedPolicy()).toEqual(DEFAULT_EXECUTION_POLICY_CONFIG);
  });
});

/**
 * The route the settings panel posts these five fields to.
 *
 * Tested over the wire rather than through the function, because the failure this catches is a route that answers
 * with a policy the node is not running under: the write was refused, and the refusal has to reach the caller as
 * one.
 */
describe("the autonomy route", () => {
  const AT_HTTP = "2026-09-21T12:00:00.000Z";
  let routeDir: string;
  let services: NodeServices;

  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "clarkcant-autonomy-route-"));
    services = bootNodeServices({ dataDir: routeDir, label: "autonomy route test node" });
  });

  afterEach(() => {
    services.runtime.close();
    rmSync(routeDir, { recursive: true, force: true });
  });

  async function post(body: unknown): Promise<GatewayResponse> {
    const outgoing: GatewayRequest = {
      method: "POST",
      path: "/autonomy",
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: JSON.stringify(body),
    };
    return handleRequest({ services, now: () => AT_HTTP as never }, outgoing);
  }

  function inForce(): ExecutionPolicyConfig {
    return readExecutionPolicy(
      { db: services.runtime.db, now: () => AT },
      services.runtime.identity.ownerPrincipalId,
    );
  }

  it("answers a refused write with a rejection rather than ok: true", async () => {
    const response = await post({
      settings: {
        executionPolicy: "guarded",
        jevGuardrails: true,
        instructions: "",
        guardedClasses: Array.from({ length: 17 }, () => "commands"),
        whenJevUnavailable: "allow",
      },
    });

    expect(response.status).toBe(400);
    const body = response.body as Record<string, unknown>;
    expect(body["code"]).toBe("PREFERENCE_INVALID");
    expect(body["ok"]).not.toBe(true);
    // And the node is not running under a policy the registry refused to store.
    expect(inForce()).toEqual(DEFAULT_EXECUTION_POLICY_CONFIG);
  });

  it("answers a write it stored with the policy the node now runs under", async () => {
    const response = await post({
      settings: {
        executionPolicy: "confirm",
        jevGuardrails: true,
        instructions: "never delete git repositories",
        guardedClasses: ["commands"],
        whenJevUnavailable: "allow",
      },
    });

    expect(response.status).toBe(200);
    const body = response.body as { ok: boolean; policy: ExecutionPolicyConfig };
    expect(body.ok).toBe(true);
    expect(body.policy.mode).toBe("ask");
    expect(inForce().mode).toBe("ask");
  });
});

describe("the two preference keys that still name the mode and the rules", () => {
  it("answers them from the canonical policy", () => {
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask", rules: [{ effectCategory: "read", decision: "deny" }] });
    const policy = readRegisteredPreference(deps, { principalId: PRINCIPAL, key: EXECUTION_POLICY_PREFERENCE_KEY });
    const mode = readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "execution.mode" });
    const rules = readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "execution.rules" });
    if (policy === undefined || mode === undefined || rules === undefined) throw new Error("missing preference");

    expect(projectPolicyPreference(policy, mode).value).toBe("ask");
    expect(projectPolicyPreference(policy, rules).value).toEqual([{ effectCategory: "read", decision: "deny" }]);
    // The revision reported is the policy's, because that is the value the surface is being shown.
    expect(projectPolicyPreference(policy, mode).revision).toBe(policy.revision);
    expect(projectPolicyPreference(policy, mode).isDefault).toBe(policy.isDefault);
  });

  it("writes them into the policy, so the key a surface writes is the key the node obeys", () => {
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "guarded" });

    const mode = writePolicyPreference(deps, { principalId: PRINCIPAL, key: "execution.mode", value: "ask" });
    expect(mode?.ok).toBe(true);
    expect(storedPolicy().mode).toBe("ask");

    const rules = writePolicyPreference(deps, {
      principalId: PRINCIPAL,
      key: "execution.rules",
      value: [{ effectCategory: "financial", decision: "deny" }],
    });
    expect(rules?.ok).toBe(true);
    expect(storedPolicy().rules).toEqual([{ effectCategory: "financial", decision: "deny" }]);
    // And the mode the first write set is still there: two keys, one policy.
    expect(storedPolicy().mode).toBe("ask");
  });

  it("refuses a value the canonical schema refuses, rather than storing a policy it cannot read", () => {
    const outcome = writePolicyPreference(deps, { principalId: PRINCIPAL, key: "execution.mode", value: "yolo" });
    expect(outcome?.ok).toBe(false);
    expect(storedPolicy()).toEqual(DEFAULT_EXECUTION_POLICY_CONFIG);
  });

  it("does not touch a key that is not one of the two", () => {
    expect(writePolicyPreference(deps, { principalId: PRINCIPAL, key: "experience.theme", value: "dark" })).toBeUndefined();
  });
});
