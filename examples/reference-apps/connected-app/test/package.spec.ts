import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { declaredReachOf, manifestProblems, packageManifestSchema } from "../../../../packages/contracts/src/index.ts";
import { runConformance } from "../../../../packages/widget-cli/src/conformance.ts";
import { readTaskList, readUpdatedTask, titleProblem } from "../widgets/main/tasks-core.js";

/**
 * The connected app as a package: it passes the conformance suite `clark widget test` runs, declares one connection
 * whose scopes each capability names, and its frame never names the provider. Here, in the default test run, so a
 * change to the app or to the suite that breaks the reference fails the repository's own checks.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8")) as Record<string, unknown>;
}

describe("the connected app package", () => {
  it("passes the conformance suite, including the check that the frame leaves connecting to the host", () => {
    const result = runConformance(ROOT);
    expect(result.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(result.checks.find((check) => check.id === "security.connectionHostOwned")?.status).toBe("pass");
    expect(result.ok).toBe(true);
  });

  it("is a UI facet first, a service with one connection, and skills, with no permissions of its own", () => {
    const manifest = packageManifestSchema.parse(json("clarkcant.json"));
    expect(manifestProblems(manifest)).toEqual([]);
    expect(manifest.facets.map((facet) => facet.kind)).toEqual(["ui", "tools", "skills"]);
    expect(manifest.permissions).toEqual({ networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] });
    const tools = manifest.facets[1];
    if (tools?.kind !== "tools") throw new Error("the second facet is the service");
    expect(tools.egress).toBeUndefined();
    expect(tools.capabilities.map((capability) => [capability.ref, capability.effectCategory, capability.requiredScopes])).toEqual([
      ["com.clarkcant.reference.connected-app.list-tasks@1", "read", ["tasks.read"]],
      ["com.clarkcant.reference.connected-app.update-task@1", "external-write", ["tasks.write"]],
    ]);
    expect(tools.connection?.flow).toBe("oauth-pkce");
    // A public client: no secret, anywhere in the package.
    expect(JSON.stringify(manifest)).not.toMatch(/secret/i);
  });

  it("shows the account it connects to in its declared reach", () => {
    const reach = declaredReachOf(packageManifestSchema.parse(json("clarkcant.json")));
    expect(reach.connections?.map((connection) => [connection.provider, connection.scopes.map((scope) => scope.scope)])).toEqual([
      ["fake.tasks", ["tasks.read", "tasks.write"]],
    ]);
  });

  it("declares the effects its bindings can have, and a state that holds nothing", () => {
    const definition = json("widgets/main/widget.json");
    expect(definition.effectCategories).toEqual(["read", "external-write"]);
    expect(definition.stateSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("runs its portable service tests against the fake connector", () => {
    const run = spawnSync(process.execPath, ["--test", fileURLToPath(new URL("../dev/service.test.mjs", import.meta.url))], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/# pass 5|pass 5/);
  });
});

describe("what the frame reads from the service's answers", () => {
  it("reads a task list and drops anything that is not a task", () => {
    expect(readTaskList(JSON.stringify({ tasks: [{ id: "task-1", title: "A", done: true }, { id: "../x", title: "B" }, null] }))).toEqual({
      ok: true,
      tasks: [{ id: "task-1", title: "A", done: true }],
    });
    expect(readTaskList("The provider answered 500.").ok).toBe(false);
    expect(readTaskList(JSON.stringify({ items: [] })).ok).toBe(false);
  });

  it("reads a renamed task, and nothing else", () => {
    expect(readUpdatedTask(JSON.stringify({ task: { id: "task-2", title: "Mới" } }))).toEqual({ id: "task-2", title: "Mới", done: false });
    expect(readUpdatedTask("not json")).toBeUndefined();
  });

  it("refuses an empty or overlong title before anything is sent", () => {
    expect(titleProblem("  ")).toMatch(/trống/);
    expect(titleProblem("x".repeat(201))).toMatch(/200/);
    expect(titleProblem(" Ổn ")).toBeUndefined();
  });
});
