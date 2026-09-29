import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CapabilityRef,
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type ExecutionPolicyConfig,
  type Instant,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, getCapability, writeRegisteredPreference } from "@clarkcant/core";
import { migrate, openDatabase, type Database } from "@clarkcant/storage";

import {
  type CapabilityInvokeDeps,
  capabilityDigest,
  invokeCapability,
  runApprovedCapability,
} from "../src/application/capability-invoke.ts";
import { NEEDS_ENGINE_REASON, type ServiceEngine } from "../src/service-container.ts";
import { createServiceHost, serviceEffectCategory, type ServiceHost, type ServiceLauncher } from "../src/service-host.ts";

/**
 * The service host and the one gate every caller goes through, against the notes package's real service.
 *
 * The service runs as a plain Node process here, through the host's launcher seam: what is under test is the host's
 * own logic — matching what the service lists against what the manifest declares, readiness, restart, stop — and the
 * gate in front of it. The container boundary is `serviceRunArgs`, tested on its own, and the E2E run starts the same
 * package in a real container.
 */

const NODE = "node_a";
const PRINCIPAL = "prin_owner";
const PACKAGE = "com.example.notes";
const GENERATION = `${PACKAGE}@1.0.0:code_1`;
const ADD = "com.example.notes.add@1" as CapabilityRef;
const LIST = "com.example.notes.list@1" as CapabilityRef;
const FIXTURE = fileURLToPath(new URL("../../web/e2e/fixtures/notes-service/", import.meta.url));

let dir: string;
let root: string;
let db: Database;
let host: ServiceHost | undefined;
let counter = 0;
const logs: string[] = [];

const RUNNING: ServiceEngine = { available: true, engine: "docker", version: "test" };

/**
 * The same file the container runs, as a plain process, with its pid written where the test can find it.
 *
 * The wrapper is what lets a test kill the service the way `docker kill` would, without an engine.
 */
function plainLauncher(): ServiceLauncher {
  const wrapper = join(dir, "run-service.mjs");
  writeFileSync(
    wrapper,
    [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const data = process.argv[process.argv.indexOf("--data") + 1];',
      'writeFileSync(join(data, "pid"), String(process.pid));',
      "await import(process.argv[2]);",
    ].join("\n"),
  );
  return (spec) => ({
    command: process.execPath,
    args: [wrapper, pathToFileURL(join(spec.packageRoot, spec.entry)).href, "--data", spec.dataDir],
  });
}

function start(options: { engine?: ServiceEngine; launcher?: ServiceLauncher; restartBaseMs?: number } = {}): ServiceHost {
  host = createServiceHost({
    registry: { db, nodeId: NODE },
    dataDir: dir,
    engine: async () => options.engine ?? RUNNING,
    packageRoot: (generation) => (generation.packageId === PACKAGE ? root : undefined),
    launcher: options.launcher ?? plainLauncher(),
    log: (line) => logs.push(line),
    timings: { restartBaseMs: options.restartBaseMs ?? 20, pingIntervalMs: 60_000 },
  });
  return host;
}

function activate(generationId = GENERATION, version = "1.0.0"): void {
  const at = new Date(Date.UTC(2026, 8, 29, 6, 0, counter++)).toISOString();
  db.prepare("UPDATE package_generations SET superseded_at = ? WHERE package_id = ? AND superseded_at IS NULL").run(at, PACKAGE);
  const generation = {
    generationId,
    packageId: PACKAGE,
    version,
    digest: "sha256:notes-service-digest",
    nodeId: NODE,
    codeGeneration: generationId.split(":")[1] ?? "code",
    activatedAt: at,
    uiOnlyFacets: [],
    grantedCapabilities: [],
  };
  db.prepare(
    `INSERT INTO package_generations
       (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(generationId, PACKAGE, version, generation.digest, NODE, generation.codeGeneration, at, JSON.stringify(generation));
}

function uninstall(): void {
  db.prepare("UPDATE package_generations SET superseded_at = ? WHERE package_id = ? AND superseded_at IS NULL").run(
    new Date().toISOString(),
    PACKAGE,
  );
}

function writePolicy(value: ExecutionPolicyConfig): void {
  const outcome = writeRegisteredPreference(
    { db, now: () => new Date().toISOString() as Instant },
    { principalId: PRINCIPAL, key: EXECUTION_POLICY_PREFERENCE_KEY, value, source: "user" },
  );
  if (!outcome.ok) throw new Error(outcome.message);
}

function invokeDeps(): CapabilityInvokeDeps {
  return { db, nodeId: NODE, principalId: PRINCIPAL, newId: (prefix) => `${prefix}_${String(++counter)}`, serviceHost: host };
}

function readiness(ref: CapabilityRef) {
  return getCapability({ db, nodeId: NODE }, ref, NODE)?.readiness;
}

async function until<T>(read: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; log: ${logs.join(" | ")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function running(serviceHost: ServiceHost): Promise<void> {
  await serviceHost.reconcile();
  await until(() => serviceHost.status().every((entry) => entry.state === "running") && serviceHost.status().length > 0, "running");
}

/** A copy of the package whose manifest a test may change, so the fixture on disk stays what E2E installs. */
function withManifest(change: (manifest: { facets: { kind: string; capabilities?: unknown[] }[] }) => void): void {
  const path = join(root, "clarkcant.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { facets: { kind: string; capabilities?: unknown[] }[] };
  change(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-service-host-"));
  root = join(dir, "package");
  cpSync(FIXTURE, root, { recursive: true });
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  logs.length = 0;
});

afterEach(async () => {
  await host?.stopAll();
  host = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("the effect a service call is decided under", () => {
  it("is raised by what the tool says about itself and never lowered by it", () => {
    expect(serviceEffectCategory("read", { name: "t", inputSchema: {} })).toBe("local-write");
    expect(serviceEffectCategory("read", { name: "t", inputSchema: {}, annotations: { readOnlyHint: true } })).toBe("read");
    expect(serviceEffectCategory("local-write", { name: "t", inputSchema: {}, annotations: { destructiveHint: true } })).toBe("destructive");
    // A read-only claim does not lower what the manifest declared.
    expect(serviceEffectCategory("external-write", { name: "t", inputSchema: {}, annotations: { readOnlyHint: true } })).toBe("external-write");
  });
});

describe("a running service", () => {
  it("registers each declared tool it lists as ready, with the schema and effect the service reported", async () => {
    activate();
    await running(start());

    const add = getCapability({ db, nodeId: NODE }, ADD, NODE);
    expect(add?.readiness).toMatchObject({ installed: true, loaded: true, authorized: true, healthy: true });
    expect(add?.readiness.blockedReason).toBeUndefined();
    expect(add?.inputSchema).toMatchObject({ required: ["text"] });
    expect(add?.effectCategory).toBe("local-write");
    expect(add?.providedBy).toMatchObject({ packageId: PACKAGE, generation: GENERATION });
    expect(getCapability({ db, nodeId: NODE }, LIST, NODE)?.effectCategory).toBe("read");
    expect(host?.serves(ADD)).toEqual({ packageId: PACKAGE, generationId: GENERATION });
  });

  it("runs a call through the policy and answers with what the service said, keeping its data in the private folder", async () => {
    activate();
    await running(start());

    const added = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "mua sữa" }, source: "widget" });
    expect(added).toMatchObject({ kind: "done", output: "Saved. 1 note(s): mua sữa" });
    const listed = await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "voice" });
    expect(listed).toMatchObject({ kind: "done", output: "mua sữa" });

    // The one folder the service may write, under the node's data directory and nowhere in the package.
    const pid = findPidFile(join(dir, "services"));
    if (pid === undefined) throw new Error("the service's private folder was not created");
    expect(JSON.parse(readFileSync(join(pid, "..", "notes.json"), "utf8"))).toEqual(["mua sữa"]);
    expect(existsSync(join(root, "notes.json"))).toBe(false);
    // Each call is on the record before it ran, whichever surface asked.
    const executions = db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'effect.executed'").get() as { count: number };
    expect(executions.count).toBe(2);
  });

  it("refuses input the capability's own schema does not accept, before anything runs", async () => {
    activate();
    await running(start());

    const empty = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "" }, source: "agent" });
    expect(empty).toMatchObject({ kind: "refused", code: "INVALID_INPUT", status: 400 });
    const extra = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "a", owner: "x" }, source: "agent" });
    expect(extra).toMatchObject({ kind: "refused", code: "INVALID_INPUT" });
    const listed = await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "agent" });
    expect(listed).toMatchObject({ kind: "done", output: "No notes yet." });
  });

  it("refuses a ref no active package's service declares", async () => {
    activate();
    await running(start());
    const outcome = await invokeCapability(invokeDeps(), {
      ref: "com.example.other.add@1",
      args: {},
      source: "agent",
    });
    expect(outcome).toMatchObject({ kind: "refused", code: "NOT_A_SERVICE_CAPABILITY", status: 404 });
  });

  it("refuses a binding pinned to a generation that is no longer active, and ignores a pin that names no generation", async () => {
    activate(`${PACKAGE}@0.9.0:code_0`, "0.9.0");
    activate();
    await running(start());

    const stale = await invokeCapability(invokeDeps(), {
      ref: LIST,
      args: {},
      source: "widget",
      bindingGeneration: `${PACKAGE}@0.9.0:code_0`,
    });
    expect(stale).toMatchObject({ kind: "refused", code: "BINDING_STALE", status: 409 });

    const current = await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "widget", bindingGeneration: GENERATION });
    expect(current.kind).toBe("done");
    // A widget definition's digest is what a binding compiled without the provider records: it pins nothing.
    const unpinned = await invokeCapability(invokeDeps(), {
      ref: LIST,
      args: {},
      source: "widget",
      bindingGeneration: "sha256:widget-definition",
    });
    expect(unpinned.kind).toBe("done");
  });
});

describe("the policy in front of a service", () => {
  it("puts a host-owned card in front of a call the policy asks about, and runs exactly what was approved", async () => {
    activate();
    await running(start());
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask" });

    const asked = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "gọi mẹ" }, source: "agent" });
    if (asked.kind !== "approval-required") throw new Error(`expected a card, got ${JSON.stringify(asked)}`);
    expect(asked.card.owner).toBe("host");
    expect(asked.card.operationDigest).toBe(capabilityDigest(ADD, { text: "gọi mẹ" }));
    // Nothing ran: the service still has no notes.
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "autonomous" });
    expect(await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "agent" })).toMatchObject({ output: "No notes yet." });

    const forged = await runApprovedCapability(invokeDeps(), {
      payload: JSON.stringify({ kind: "capability", capabilityRef: ADD, args: { text: "chuyển tiền" }, source: "agent" }),
      expectedDigest: asked.card.operationDigest,
      approvalId: asked.approval.approvalId,
      conversationId: "conv_a",
    });
    expect(forged).toMatchObject({ ok: false, code: "APPROVAL_FORGED" });

    const approved = await runApprovedCapability(invokeDeps(), {
      payload: asked.card.payload ?? "",
      expectedDigest: asked.card.operationDigest,
      approvalId: asked.approval.approvalId,
      conversationId: "conv_a",
    });
    expect(approved).toMatchObject({ ok: true, succeeded: true });
    if (!approved.ok) throw new Error("unreachable");
    expect(approved.blocks[0]).toMatchObject({ type: "tool-activity", status: "done", result: "Saved. 1 note(s): gọi mẹ" });
  });

  it("refuses a call the policy refuses, and runs nothing", async () => {
    activate();
    await running(start());
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, rules: [{ effectCategory: "local-write", decision: "deny" }] });

    const outcome = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "x" }, source: "voice" });
    expect(outcome).toMatchObject({ kind: "refused", code: "POLICY_REFUSED", status: 403 });
    expect(await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "voice" })).toMatchObject({ output: "No notes yet." });
  });
});

describe("what the manifest declares against what the service lists", () => {
  it("never registers a tool the manifest did not declare", async () => {
    withManifest((manifest) => {
      const tools = manifest.facets.find((facet) => facet.kind === "tools");
      if (tools?.capabilities !== undefined) tools.capabilities = tools.capabilities.slice(0, 1);
    });
    activate();
    await running(start());

    expect(readiness(ADD)?.loaded).toBe(true);
    expect(getCapability({ db, nodeId: NODE }, LIST, NODE)).toBeUndefined();
    expect(logs.some((line) => line.includes("list_notes, which its package does not declare"))).toBe(true);
  });

  it("registers a declared tool the service does not list as not loaded, with that as the reason", async () => {
    withManifest((manifest) => {
      manifest.facets
        .find((facet) => facet.kind === "tools")
        ?.capabilities?.push({
          tool: "archive_note",
          ref: "com.example.notes.archive@1",
          summary: "Archive a note",
          effectCategory: "local-write",
        });
    });
    activate();
    await running(start());

    const archive = readiness("com.example.notes.archive@1" as CapabilityRef);
    expect(archive).toMatchObject({ loaded: false });
    expect(archive?.blockedReason).toContain("archive_note");
    const outcome = await invokeCapability(invokeDeps(), { ref: "com.example.notes.archive@1", args: {}, source: "widget" });
    expect(outcome).toMatchObject({ kind: "refused", code: "CAPABILITY_NOT_READY" });
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.message).toContain("archive_note");
  });
});

describe("a service that is not running", () => {
  it("registers every capability as not loaded, with the reason a person can act on, when there is no engine", async () => {
    activate();
    const serviceHost = start({ engine: { available: false, reason: NEEDS_ENGINE_REASON, detail: "docker: not found" } });
    await serviceHost.reconcile();
    await until(() => readiness(ADD), "registration");

    expect(readiness(ADD)).toMatchObject({ installed: true, loaded: false, healthy: false, blockedReason: NEEDS_ENGINE_REASON });
    const outcome = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "x" }, source: "widget" });
    expect(outcome).toMatchObject({ kind: "refused", code: "CAPABILITY_NOT_READY", status: 503 });
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.message).toContain(NEEDS_ENGINE_REASON);
  });

  it("marks the capabilities down when the service is killed, and brings it back with its data", async () => {
    activate();
    const serviceHost = start({ restartBaseMs: 1_500 });
    await running(serviceHost);
    await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "trước khi tắt" }, source: "widget" });

    const pidFile = await until(() => findPidFile(join(dir, "services")), "the pid file");
    // What `docker kill` does to the container: the process ends without a word.
    process.kill(Number(readFileSync(pidFile, "utf8")));

    const down = await until(() => {
      const reason = readiness(ADD)?.blockedReason;
      return reason !== undefined && reason.includes("restarts in") ? reason : undefined;
    }, "the restart reason");
    expect(down).toContain("the service stopped");
    // The reason is read by a person; the MCP client's internal server id is left in the node's log.
    expect(down).not.toContain("mcp server");
    expect(readiness(ADD)?.healthy).toBe(false);
    const refused = await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "widget" });
    expect(refused).toMatchObject({ kind: "refused", code: "CAPABILITY_NOT_READY" });

    await until(() => readiness(ADD)?.healthy === true, "the restart");
    expect(await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "widget" })).toMatchObject({
      kind: "done",
      output: "trước khi tắt",
    });
  });

  it("leaves a service that keeps dying stopped, and says so", async () => {
    activate();
    const serviceHost = start({
      launcher: () => ({ command: process.execPath, args: ["-e", "process.exit(3)"] }),
      restartBaseMs: 5,
    });
    await serviceHost.reconcile();
    await until(() => serviceHost.status()[0]?.state === "failed", "giving up", 30_000);

    expect(readiness(ADD)?.blockedReason).toContain("left stopped");
  });

  it("marks the capabilities as no longer installed when the package is uninstalled", async () => {
    activate();
    const serviceHost = start();
    await running(serviceHost);

    uninstall();
    await serviceHost.reconcile();

    expect(serviceHost.status()).toEqual([]);
    expect(serviceHost.serves(ADD)).toBeUndefined();
    expect(readiness(ADD)).toMatchObject({ installed: false, loaded: false, healthy: false });
    expect(readiness(ADD)?.blockedReason).toContain("no longer installed");
    const outcome = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "x" }, source: "agent" });
    expect(outcome).toMatchObject({ kind: "refused", code: "NOT_A_SERVICE_CAPABILITY" });
  });

  it("stops every service on an emergency stop and says why", async () => {
    activate();
    const serviceHost = start();
    await running(serviceHost);

    expect(await serviceHost.stopAll()).toBe(1);
    expect(readiness(ADD)).toMatchObject({ loaded: false, healthy: false, blockedReason: "the node stopped its services" });
    // A reconcile after a stop does not start them again behind the person's back.
    await serviceHost.reconcile();
    expect(serviceHost.status()).toEqual([]);
  });
});

function findPidFile(servicesDir: string): string | undefined {
  if (!existsSync(servicesDir)) return undefined;
  for (const packageFolder of readdir(servicesDir)) {
    for (const facetFolder of readdir(join(servicesDir, packageFolder))) {
      const pid = join(servicesDir, packageFolder, facetFolder, "pid");
      if (existsSync(pid)) return pid;
    }
  }
  return undefined;
}

function readdir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
