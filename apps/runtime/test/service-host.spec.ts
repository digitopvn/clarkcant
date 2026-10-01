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
import { EXECUTION_POLICY_PREFERENCE_KEY, getCapability, registerCapability, writeRegisteredPreference } from "@clarkcant/core";
import { migrate, openDatabase, type Database } from "@clarkcant/storage";

import {
  type CapabilityInvokeDeps,
  capabilityDigest,
  invokeCapability,
  runApprovedCapability,
} from "../src/application/capability-invoke.ts";
import { describeCapabilityOutcome } from "../src/invoke-capability-tool.ts";
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

function start(
  options: {
    engine?: ServiceEngine | (() => ServiceEngine);
    launcher?: ServiceLauncher;
    restartBaseMs?: number;
    engineRetryMs?: number;
    packageRoot?: (packageId: string) => string | undefined;
  } = {},
): ServiceHost {
  const engine = options.engine;
  host = createServiceHost({
    registry: { db, nodeId: NODE },
    dataDir: dir,
    engine: async () => (typeof engine === "function" ? engine() : (engine ?? RUNNING)),
    packageRoot: (generation) =>
      options.packageRoot === undefined ? (generation.packageId === PACKAGE ? root : undefined) : options.packageRoot(generation.packageId),
    launcher: options.launcher ?? plainLauncher(),
    log: (line) => logs.push(line),
    timings: {
      restartBaseMs: options.restartBaseMs ?? 20,
      pingIntervalMs: 60_000,
      ...(options.engineRetryMs === undefined ? {} : { engineRetryMs: options.engineRetryMs }),
    },
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

/** A row as a previous run of the node, or the node itself, left it. */
function preRegister(ref: CapabilityRef, provider: "package" | "node"): void {
  registerCapability(
    { db, nodeId: NODE },
    {
      ref,
      ...(provider === "package"
        ? { providedBy: { packageId: PACKAGE, version: "1.0.0", digest: "sha256:notes-service-digest", generation: GENERATION } }
        : {}),
      executionNodeId: NODE,
      summary: provider === "package" ? "Add a note" : "The node's own add",
      resourceKinds: [],
      effectCategory: "read",
      supportsCancellation: false,
      requiresConnection: false,
      readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      uiAffordances: [],
    },
  );
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
    expect(asked.card.operationDigest).toBe(
      capabilityDigest(ADD, { text: "gọi mẹ" }, { generation: GENERATION, effectCategory: "local-write" }),
    );
    // Nothing ran: the service still has no notes.
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "autonomous" });
    expect(await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "agent" })).toMatchObject({ output: "No notes yet." });

    const forged = await runApprovedCapability(invokeDeps(), {
      payload: JSON.stringify({
        kind: "capability",
        capabilityRef: ADD,
        args: { text: "chuyển tiền" },
        source: "agent",
        generation: GENERATION,
        effectCategory: "local-write",
      }),
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

  it("does not run an approval the policy has since refused, or one for a capability that changed", async () => {
    activate();
    await running(start());
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask" });
    const asked = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "gọi mẹ" }, source: "agent" });
    if (asked.kind !== "approval-required") throw new Error(`expected a card, got ${JSON.stringify(asked)}`);
    const approvedBy = { approvalId: asked.approval.approvalId, generation: GENERATION, effectCategory: "local-write" as const };

    // A refusal the person set after the card was shown outranks the card.
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask", rules: [{ effectCategory: "local-write", decision: "deny" }] });
    const denied = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "gọi mẹ" }, source: "agent", approvedBy });
    expect(denied).toMatchObject({ kind: "refused", code: "POLICY_REFUSED" });
    const run = await runApprovedCapability(invokeDeps(), {
      payload: asked.card.payload ?? "",
      expectedDigest: asked.card.operationDigest,
      approvalId: asked.approval.approvalId,
      conversationId: "conv_a",
    });
    expect(run).toMatchObject({ ok: true, succeeded: false });
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask" });

    // The card covered one package generation and one effect; either changing voids it.
    const updated = await invokeCapability(invokeDeps(), {
      ref: ADD,
      args: { text: "gọi mẹ" },
      source: "agent",
      approvedBy: { ...approvedBy, generation: `${PACKAGE}@2.0.0:code_2` },
    });
    expect(updated).toMatchObject({ kind: "refused", code: "APPROVAL_STALE", status: 409 });
    if (updated.kind !== "refused") throw new Error("unreachable");
    expect(updated.message).toContain("its package was updated");
    const descriptor = getCapability({ db, nodeId: NODE }, ADD, NODE);
    if (descriptor === undefined) throw new Error("unreachable");
    registerCapability({ db, nodeId: NODE }, { ...descriptor, effectCategory: "destructive" });
    const riskier = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "gọi mẹ" }, source: "agent", approvedBy });
    expect(riskier).toMatchObject({ kind: "refused", code: "APPROVAL_STALE" });
    if (riskier.kind !== "refused") throw new Error("unreachable");
    expect(riskier.message).toContain("it is now destructive");

    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "autonomous" });
    registerCapability({ db, nodeId: NODE }, descriptor);
    expect(await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "agent" })).toMatchObject({ output: "No notes yet." });
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

describe("what the agent is told about a call that failed", () => {
  it("does not say nothing ran when the request reached the service", () => {
    for (const code of ["SERVICE_UNREACHABLE", "SERVICE_TOOL_FAILED"] as const) {
      const told = describeCapabilityOutcome({ kind: "refused", status: 504, code, message: "no answer in 30 s", sent: true });
      expect(told, code).not.toContain("Không có gì được chạy");
      expect(told, code).toContain("có thể nó đã chạy một phần");
    }
    const refused = describeCapabilityOutcome({ kind: "refused", status: 403, code: "POLICY_REFUSED", message: "denied", sent: false });
    expect(refused).toContain("Không có gì được chạy");
  });
});

describe("a capability something else on the node already provides", () => {
  it("is left as it was, and the package's service does not serve it", async () => {
    preRegister(ADD, "node");
    activate();
    await running(start());

    const row = getCapability({ db, nodeId: NODE }, ADD, NODE);
    expect(row?.summary).toBe("The node's own add");
    expect(row?.providedBy).toBeUndefined();
    expect(row?.readiness).toMatchObject({ loaded: true, healthy: true });
    expect(host?.serves(ADD)).toBeUndefined();
    expect(host?.serves(LIST)).toEqual({ packageId: PACKAGE, generationId: GENERATION });
    expect(await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "x" }, source: "agent" })).toMatchObject({
      kind: "refused",
      code: "NOT_A_SERVICE_CAPABILITY",
    });
    expect(logs.filter((line) => line.includes(`declares ${ADD}, which is already registered`))).toHaveLength(1);

    uninstall();
    await host?.reconcile();
    expect(getCapability({ db, nodeId: NODE }, ADD, NODE)?.readiness).toMatchObject({ installed: true, loaded: true, healthy: true });
    expect(readiness(LIST)).toMatchObject({ installed: false });
  });
});

describe("a capability another package held when this one started", () => {
  const OTHER = "com.example.othernotes";
  const OTHER_GENERATION = `${OTHER}@1.0.0:code_1`;

  function activateOther(): void {
    const at = new Date(Date.UTC(2026, 8, 29, 5, 0, counter++)).toISOString();
    const generation = {
      generationId: OTHER_GENERATION,
      packageId: OTHER,
      version: "1.0.0",
      digest: "sha256:other-notes-digest",
      nodeId: NODE,
      codeGeneration: "code_1",
      activatedAt: at,
      uiOnlyFacets: [],
      grantedCapabilities: [],
    };
    db.prepare(
      `INSERT INTO package_generations
         (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(OTHER_GENERATION, OTHER, "1.0.0", generation.digest, NODE, "code_1", at, JSON.stringify(generation));
  }

  /** Each facet's pid file by its folder, so a restart shows as a changed or new pid. */
  function pids(): Map<string, string> {
    const servicesDir = join(dir, "services");
    const found = new Map<string, string>();
    for (const packageFolder of readdir(servicesDir)) {
      for (const facetFolder of readdir(join(servicesDir, packageFolder))) {
        const pid = join(servicesDir, packageFolder, facetFolder, "pid");
        if (existsSync(pid)) found.set(join(packageFolder, facetFolder), readFileSync(pid, "utf8"));
      }
    }
    return found;
  }

  it("is served by this package after the next reconcile once that package is gone, without restarting its service", async () => {
    // Package B declares the same refs as the notes package, from its own copy of the files.
    const otherRoot = join(dir, "other-package");
    cpSync(FIXTURE, otherRoot, { recursive: true });
    const serviceHost = start({
      packageRoot: (packageId) => (packageId === PACKAGE ? root : packageId === OTHER ? otherRoot : undefined),
    });

    // 1. B holds ADD.
    activateOther();
    await running(serviceHost);
    expect(serviceHost.serves(ADD)).toEqual({ packageId: OTHER, generationId: OTHER_GENERATION });
    const otherOnly = pids();
    expect(otherOnly.size).toBe(1);

    // 2. The notes package starts and is refused ADD, which stays B's.
    activate();
    await running(serviceHost);
    await until(() => pids().size === 2, "the notes service's pid file");
    const notesFolder = [...pids().keys()].find((folder) => !otherOnly.has(folder));
    if (notesFolder === undefined) throw new Error("unreachable");
    const notesPid = pids().get(notesFolder);
    expect(logs.filter((line) => line.includes(`${GENERATION}#com.example.notes.service declares ${ADD}, which is already registered`))).toHaveLength(1);
    expect(serviceHost.serves(ADD)).toEqual({ packageId: OTHER, generationId: OTHER_GENERATION });
    expect(getCapability({ db, nodeId: NODE }, ADD, NODE)?.providedBy?.packageId).toBe(OTHER);

    // 3. B is uninstalled. 4. After one reconcile, the notes package serves ADD.
    db.prepare("UPDATE package_generations SET superseded_at = ? WHERE package_id = ? AND superseded_at IS NULL").run(
      new Date().toISOString(),
      OTHER,
    );
    await serviceHost.reconcile();

    expect(serviceHost.serves(ADD)).toEqual({ packageId: PACKAGE, generationId: GENERATION });
    const add = getCapability({ db, nodeId: NODE }, ADD, NODE);
    expect(add?.providedBy).toMatchObject({ packageId: PACKAGE, generation: GENERATION });
    expect(add?.readiness).toMatchObject({ installed: true, loaded: true, healthy: true });
    expect(add?.inputSchema).toBeDefined();
    expect(readiness(LIST)).toMatchObject({ installed: true, loaded: true, healthy: true });
    expect(logs.some((line) => line.includes(`now serves ${ADD}`))).toBe(true);

    const added = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "sau khi gỡ" }, source: "agent" });
    expect(added).toMatchObject({ kind: "done" });
    const listed = await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "agent" });
    expect(JSON.stringify(listed)).toContain("sau khi gỡ");

    // The notes service is the same process it was before B went away.
    expect(serviceHost.status()).toEqual([expect.objectContaining({ packageId: PACKAGE, state: "running" })]);
    expect(pids().get(notesFolder)).toBe(notesPid);
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
    expect(getCapability({ db, nodeId: NODE }, "com.example.notes.board-move@1" as CapabilityRef, NODE)).toBeUndefined();
    expect(logs.some((line) => line.includes("which its package does not declare"))).toBe(true);
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

describe("a tool whose input schema could stall the node", () => {
  it("is registered as not loaded, says why, and cannot stall the node on an input made to backtrack", async () => {
    // The service lists add_note with a pattern that backtracks exponentially on a run of a's ending in something else.
    const server = join(root, "service", "server.mjs");
    const source = readFileSync(server, "utf8");
    const safe = 'text: { type: "string", minLength: 1, maxLength: 500 }';
    expect(source).toContain(safe);
    writeFileSync(server, source.replace(safe, 'text: { type: "string", pattern: "^(a+)+$" }'));
    activate();
    await running(start());

    const add = getCapability({ db, nodeId: NODE }, ADD, NODE);
    expect(add?.readiness).toMatchObject({ installed: true, loaded: false, healthy: true });
    expect(add?.readiness.blockedReason).toContain("add_note");
    expect(add?.readiness.blockedReason).toContain('"^(a+)+$"');
    expect(add?.readiness.blockedReason).toContain("could stall this node");
    // The schema is not kept, so nothing reads it later; the tool beside it is unaffected.
    expect(add?.inputSchema).toBeUndefined();
    expect(readiness(LIST)).toMatchObject({ loaded: true, healthy: true });
    expect(logs.some((line) => line.includes("add_note was refused"))).toBe(true);

    const started = performance.now();
    const outcome = await invokeCapability(invokeDeps(), { ref: ADD, args: { text: `${"a".repeat(49)}!` }, source: "widget" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(outcome).toMatchObject({ kind: "refused", code: "CAPABILITY_NOT_READY", status: 503 });
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.message).toContain("simpler pattern");
    expect(await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "agent" })).toMatchObject({ kind: "done" });
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

  it("starts the service once an engine appears, without restarting the node", async () => {
    activate();
    let answer: ServiceEngine = { available: false, reason: NEEDS_ENGINE_REASON, detail: "docker: not found" };
    const serviceHost = start({ engine: () => answer, engineRetryMs: 50 });
    await serviceHost.reconcile();
    await until(() => readiness(ADD)?.blockedReason === NEEDS_ENGINE_REASON, "the missing engine");

    answer = RUNNING;
    await until(() => readiness(ADD)?.healthy === true, "the service to start once the engine is there");
    expect(await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "voice" })).toMatchObject({ kind: "done" });
  });

  it("does not show what a previous run registered as ready before anything has started", async () => {
    preRegister(ADD, "package");
    activate();
    const serviceHost = start({ packageRoot: () => undefined });
    expect(readiness(ADD)).toMatchObject({ loaded: false, healthy: false, blockedReason: "the service has not started yet" });

    await serviceHost.reconcile();
    expect(readiness(ADD)?.blockedReason).toBe("the package's files are not on this node");
    expect(await invokeCapability(invokeDeps(), { ref: ADD, args: { text: "x" }, source: "widget" })).toMatchObject({
      kind: "refused",
    });
  });

  it("does not come back after a stop that landed while it was waiting to restart", async () => {
    activate();
    const serviceHost = start({ restartBaseMs: 400 });
    await running(serviceHost);
    const pidFile = await until(() => findPidFile(join(dir, "services")), "the pid file");
    const firstPid = readFileSync(pidFile, "utf8");
    process.kill(Number(firstPid));
    await until(() => readiness(ADD)?.blockedReason?.includes("restarts in") === true, "the restart backoff");

    await serviceHost.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(serviceHost.status()).toEqual([]);
    expect(readiness(ADD)).toMatchObject({ loaded: false, healthy: false, blockedReason: "the node stopped its services" });
    expect(readFileSync(pidFile, "utf8")).toBe(firstPid);
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

  it("reports a call whose service exits mid-call as sent, so the caller keeps it as one that may have run", async () => {
    activate();
    await running(start({ restartBaseMs: 1_500 }));
    const pidFile = await until(() => findPidFile(join(dir, "services")), "the pid file");
    const pending = invokeCapability(invokeDeps(), {
      ref: "com.example.notes.add-slowly@1" as CapabilityRef,
      args: { text: "giữa chừng", seconds: 2 },
      source: "widget",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.kill(Number(readFileSync(pidFile, "utf8")));
    const lost = await pending;
    expect(lost).toMatchObject({ kind: "refused", sent: true, effectCategory: "local-write" });
    if (lost.kind !== "refused") throw new Error("unreachable");
    expect(["SERVICE_UNREACHABLE", "SERVICE_TOOL_FAILED"]).toContain(lost.code);
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


describe("a call its caller bounds", () => {
  const SLOW = "com.example.notes.add-slowly@1" as CapabilityRef;

  it("ends a call past the caller's deadline as timed out, says it may have run, and tells the service to drop it", async () => {
    activate();
    await running(start());

    const late = await invokeCapability(invokeDeps(), { ref: SLOW, args: { text: "chậm", seconds: 2 }, source: "widget", timeoutMs: 300 });
    // Sent, so it may have run: the caller must not free what it asked for.
    expect(late).toMatchObject({ kind: "refused", status: 504, code: "SERVICE_TIMED_OUT", sent: true, effectCategory: "local-write" });
    // The service was told the request is withdrawn, and this one honours it: the note is never written.
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "widget" })).toMatchObject({ kind: "done", output: "No notes yet." });
  });

  it("withdraws a call when the caller's signal aborts, as cancelled rather than as nothing having happened", async () => {
    activate();
    await running(start());

    const controller = new AbortController();
    const pending = invokeCapability(invokeDeps(), {
      ref: SLOW,
      args: { text: "dừng", seconds: 2 },
      source: "widget",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const stopped = await pending;
    expect(stopped).toMatchObject({ kind: "refused", status: 409, code: "SERVICE_CANCELLED", sent: true });
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "widget" })).toMatchObject({ kind: "done", output: "No notes yet." });
  });

  it("never gives a call more time than the host's own ceiling, and answers a quick one as usual", async () => {
    activate();
    await running(start());
    const quick = await invokeCapability(invokeDeps(), {
      ref: SLOW,
      args: { text: "nhanh", seconds: 1 },
      source: "widget",
      timeoutMs: 10 * 60_000,
    });
    expect(quick).toMatchObject({ kind: "done", output: "Saved. 1 note(s): nhanh" });
  });

  it("reports a call withdrawn before it was written as not sent, so no caller treats it as one that may have run", async () => {
    activate();
    await running(start());
    const controller = new AbortController();
    controller.abort();
    const withdrawn = await invokeCapability(invokeDeps(), {
      ref: ADD,
      args: { text: "không gửi" },
      source: "widget",
      signal: controller.signal,
    });
    expect(withdrawn).toMatchObject({ kind: "refused", code: "SERVICE_CANCELLED", sent: false });
    expect(await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "widget" })).toMatchObject({ kind: "done", output: "No notes yet." });
  });

  it("refuses to send a call it cannot first write down, and sends nothing", async () => {
    activate();
    await running(start());
    const outcome = await invokeCapability(invokeDeps(), {
      ref: ADD,
      args: { text: "không ghi được" },
      source: "widget",
      beforeSend: () => {
        throw new Error("the disk is full");
      },
    });
    expect(outcome).toMatchObject({ kind: "refused", status: 503, code: "LEDGER_UNAVAILABLE", sent: false });
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.message).toContain("nothing was sent");
    expect(await invokeCapability(invokeDeps(), { ref: LIST, args: {}, source: "widget" })).toMatchObject({ kind: "done", output: "No notes yet." });
  });
});
