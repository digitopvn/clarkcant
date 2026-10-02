import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CapabilityRef,
  DEFAULT_EXECUTION_POLICY_CONFIG,
  EGRESS_ERROR_CODES,
  type Instant,
  RESOURCE_PROFILES,
  SERVICE_ARTIFACT_ERROR_CODES,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, writeRegisteredPreference } from "@clarkcant/core";
import { createConversation, createPin, migrate, openDatabase, type Database } from "@clarkcant/storage";

import { type CapabilityInvokeDeps, invokeCapability, runApprovedCapability } from "../src/application/capability-invoke.ts";
import {
  type ArtifactBrokerDeps,
  createWorkingArtifact,
  readArtifactRange,
  revokeArtifactAccess,
  storePickedArtifact,
  storedBytesForPrincipal,
} from "../src/artifact-broker.ts";
import { createPackageJobHost, type PackageJobHost } from "../src/job-host.ts";
import { createServiceHost, type ServiceHost, type ServiceLauncher } from "../src/service-host.ts";
import { createWorkSupervisor, type WorkSupervisor } from "../src/work-supervisor.ts";
import { WAV_HEADER_BYTES, applyGain, fixtureClip, parseWavHeader, renderPlan, wavHeader } from "../../../examples/reference-apps/media-render/service/wav.mjs";

/**
 * A package service reading a file a widget holds, end to end through the node: the reference media render package's
 * real service, run as a plain process through the launcher seam, started as a job by `invokeCapability` the way a
 * widget press starts it, and streamed the picked clip by the service host a range at a time.
 *
 * What is checked is the host's side of the boundary: the grant, the profile's input cap before anything is sent, the
 * reads a call may make and no others, the rendered file kept only when the job completes, and nothing kept when it is
 * stopped. The service's own refusals are tested beside it in the package.
 */

const NODE = "node_a";
const PRINCIPAL = "prin_owner";
const CONVERSATION = "conv_render";
const INSTANCE = "winst_render";
const BINDING = "binding_media_render";
const PACKAGE = "com.clarkcant.reference.media-render";
const GENERATION = `${PACKAGE}@1.0.0:code_1`;
const RENDER = "com.clarkcant.reference.media-render.render@1" as CapabilityRef;
const MEDIA = fileURLToPath(new URL("../../../examples/reference-apps/media-render/", import.meta.url));

const READER = "com.example.reader";
const READER_GENERATION = `${READER}@1.0.0:code_1`;
const READ_TWO = "com.example.reader.read-two@1" as CapabilityRef;

const PROBE = "com.example.probe";
const PROBE_GENERATION = `${PROBE}@1.0.0:code_1`;
const PROBE_READ = "com.example.probe.read@1" as CapabilityRef;
const PROBE_BINDING = "binding_probe";
/** The provider origin the probe declares. Nothing listens there: egress goes to the fake `fetch` below. */
const PROVIDER = "http://127.0.0.1:8879";

let dir: string;
let db: Database;
let host: ServiceHost | undefined;
let jobs: PackageJobHost;
let supervisor: WorkSupervisor;
let broker: ArtifactBrokerDeps;
let roots: Record<string, string>;
let counter = 0;
const logs: string[] = [];

function plainLauncher(): ServiceLauncher {
  return (spec) => ({ command: process.execPath, args: [join(spec.packageRoot, spec.entry)] });
}

function activate(packageId: string, generationId: string): void {
  const at = new Date(Date.UTC(2026, 9, 2, 6, 0, counter++)).toISOString();
  const generation = {
    generationId,
    packageId,
    version: "1.0.0",
    digest: `sha256:${packageId}-digest`,
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
  ).run(generationId, packageId, "1.0.0", generation.digest, NODE, "code_1", at, JSON.stringify(generation));
}

/** A copy of the media package asking for another profile, so the cap a test needs is a real profile's. */
function requesting(profile: string): void {
  const path = join(roots[PACKAGE] ?? "", "clarkcant.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...manifest, resources: { version: 1, profile } }, null, 2));
}

/**
 * A service that asks for two files: the one the call declared, and another id it was handed as a plain string. The
 * host must answer the first and refuse the second, whatever the second names.
 */
function writeReaderPackage(): void {
  const root = join(dir, "reader");
  mkdirSync(join(root, "service"), { recursive: true });
  writeFileSync(
    join(root, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: READER,
      version: "1.0.0",
      displayName: "Reader",
      description: "Reads two files.",
      hostApi: { min: 1, max: 1 },
      facets: [
        {
          kind: "tools",
          id: `${READER}.service`,
          entry: "service/server.mjs",
          isolation: "service",
          protocol: "mcp-stdio",
          capabilities: [
            { tool: "read_two", ref: READ_TWO, summary: "Read two files", effectCategory: "read", inputArtifacts: { version: 1, fields: ["source"] } },
          ],
        },
      ],
      requestedCapabilities: [],
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
      dependencies: [],
    }),
  );
  writeFileSync(
    join(root, "service", "server.mjs"),
    `
let buffer = "";
const waiting = new Map();
let next = 1;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const read = (artifactId) => new Promise((resolve) => {
  const id = "read-" + String(next++);
  waiting.set(id, resolve);
  send({ id, method: "clarkcant/artifacts.read", params: { version: 1, artifactId, offset: 0, length: 4 } });
});
async function handle(message) {
  if (message.method === undefined && waiting.has(message.id)) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve(message);
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "reader", version: "1.0.0" }, capabilities: { tools: {} } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ id: message.id, result: { tools: [{ name: "read_two", inputSchema: { type: "object", properties: { source: { type: "string" }, other: { type: "string" } }, required: ["source"] } }] } });
    return;
  }
  if (message.method === "tools/call") {
    const first = await read(message.params.arguments.source);
    const second = await read(message.params.arguments.other);
    send({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ first, second }) }] } });
    return;
  }
  if (message.id !== undefined && message.method !== undefined) send({ id: message.id, result: {} });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== "") void handle(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
});
`,
  );
  roots[READER] = root;
}

/**
 * A service that does what its call's `steps` say, in order, and records what the host answered each with:
 *
 * - `read`: ask for a range of `artifactId` (the call's `source` when absent), `times` times; with `detach`, the read is
 *   sent and not waited for, so the call can end while it is on its way;
 * - `egress`: ask the host for a request to `url`;
 * - `signal`: write a file at `path`, so the test knows the service got there;
 * - `waitFor`: wait until a file exists at `path`, so the test can change something mid-call;
 * - `answer`: answer the call now. What the steps after it record, and the detached reads, are written to `report`.
 *
 * Its one capability is declared `read`; a test that needs a call decided otherwise says so to the service host.
 */
function writeProbePackage(): void {
  const root = join(dir, "probe");
  mkdirSync(join(root, "service"), { recursive: true });
  const capability = (tool: string, ref: string, effectCategory: string) => ({
    tool,
    ref,
    summary: `Probe (${effectCategory})`,
    effectCategory,
    inputArtifacts: { version: 1, fields: ["source"] },
  });
  writeFileSync(
    join(root, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: PROBE,
      version: "1.0.0",
      displayName: "Probe",
      description: "Reads and asks the way a test tells it to.",
      hostApi: { min: 1, max: 1 },
      facets: [
        {
          kind: "tools",
          id: `${PROBE}.service`,
          entry: "service/server.mjs",
          isolation: "service",
          protocol: "mcp-stdio",
          capabilities: [capability("probe", PROBE_READ, "read")],
          egress: { version: 1, secrets: [], origins: [{ origin: PROVIDER, purpose: "Answers the probe's requests." }] },
        },
      ],
      requestedCapabilities: [],
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
      dependencies: [],
    }),
  );
  writeFileSync(
    join(root, "service", "server.mjs"),
    `
import { existsSync, writeFileSync } from "node:fs";
let buffer = "";
const waiting = new Map();
let next = 1;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const ask = (method, params) => new Promise((resolve) => {
  const id = "ask-" + String(next++);
  waiting.set(id, resolve);
  send({ id, method, params });
});
const brief = (answer) => answer.error !== undefined
  ? { code: answer.error.code, message: answer.error.message }
  : { bytes: answer.result.bytes === undefined ? undefined : Buffer.from(answer.result.bytes, "base64").byteLength, status: answer.result.status };
async function run(id, args) {
  const results = [];
  const detached = [];
  let answered = false;
  for (const step of args.steps ?? []) {
    if (step.op === "read") {
      for (let index = 0; index < (step.times ?? 1); index += 1) {
        const asked = ask("clarkcant/artifacts.read", { version: 1, artifactId: step.artifactId ?? args.source, offset: step.offset ?? 0, length: step.length ?? 4 });
        if (step.detach === true) detached.push(asked.then(brief));
        else results.push(brief(await asked));
      }
    } else if (step.op === "egress") {
      results.push(brief(await ask("clarkcant/egress.fetch", { version: 1, url: step.url, method: step.method ?? "GET" })));
    } else if (step.op === "signal") {
      writeFileSync(step.path, "here");
    } else if (step.op === "waitFor") {
      while (!existsSync(step.path)) await new Promise((resolve) => setTimeout(resolve, 20));
    } else if (step.op === "answer") {
      send({ id, result: { content: [{ type: "text", text: JSON.stringify(results.splice(0)) }] } });
      answered = true;
    }
  }
  const late = await Promise.all(detached);
  if (answered) writeFileSync(args.report, JSON.stringify({ results, detached: late }));
  else send({ id, result: { content: [{ type: "text", text: JSON.stringify([...results, ...late]) }] } });
}
async function handle(message) {
  if (message.method === undefined && waiting.has(message.id)) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve(message);
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "probe", version: "1.0.0" }, capabilities: { tools: {} } } });
    return;
  }
  if (message.method === "tools/list") {
    const inputSchema = { type: "object", properties: { source: { type: "string" }, steps: { type: "array" }, report: { type: "string" } }, required: ["source", "steps"] };
    send({ id: message.id, result: { tools: [{ name: "probe", inputSchema, annotations: { readOnlyHint: true } }] } });
    return;
  }
  if (message.method === "tools/call") {
    void run(message.id, message.params.arguments);
    return;
  }
  if (message.id !== undefined && message.method !== undefined) send({ id: message.id, result: {} });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== "") void handle(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
});
`,
  );
  roots[PROBE] = root;
}

interface ProbeAnswer {
  code?: number;
  message?: string;
  bytes?: number;
  status?: number;
}

/** A widget instance the conversation holds, pinned there, as a widget a person pressed is. */
function hold(instanceId: string, conversationId = CONVERSATION): void {
  const at = new Date(Date.UTC(2026, 9, 2, 6, 0, 0)).toISOString();
  if (db.prepare("SELECT 1 FROM conversations WHERE conversation_id = ?").get(conversationId) === undefined) {
    createConversation(db, { conversationId, homeNodeId: NODE, at: at as never });
  }
  db.prepare(
    `INSERT OR IGNORE INTO widget_instances
       (instance_id, definition_id, definition_version, package_digest, owner_node_id, owner_principal_id,
        revision, presentation_revision, data_revision, action_binding_revision, lifecycle, document, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(instanceId, "media.render@1", "1.0.0", "sha256:fixture", NODE, PRINCIPAL, 1, 1, 1, 1, "active", "{}", at);
  createPin(db, {
    pinId: `pin_${String(++counter)}`,
    conversationId,
    instanceId,
    displayMode: "expanded",
    position: 0,
    refreshPolicy: "manual",
    createdAt: at,
  } as never);
}

async function until<T>(read: () => T | undefined | false, what: string, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; log: ${logs.join(" | ")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Every request the services' egress made, by URL; the fake provider answers each with 200. */
let fetched: string[] = [];

async function startServices(options: { artifactReadDelayMs?: number } = {}): Promise<ServiceHost> {
  host = createServiceHost({
    registry: { db, nodeId: NODE },
    dataDir: dir,
    engine: async () => ({ available: true, engine: "docker", version: "test" }),
    packageRoot: (generation) => roots[generation.packageId],
    launcher: plainLauncher(),
    log: (line) => logs.push(line),
    timings: { restartBaseMs: 20, pingIntervalMs: 60_000, ...options },
    egress: {
      secrets: { headersFor: () => ({ ok: false, message: "the probe declares no secret" }) } as never,
      secretProblem: () => undefined,
      fetch: (async (input: string | URL | Request) => {
        fetched.push(String(input instanceof Request ? input.url : input));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      // The declared origin is on loopback, which a node lets services reach only when started saying so.
      allowPrivateNetwork: true,
    },
  });
  await host.reconcile();
  const started = host;
  await until(() => started.status().length > 0 && started.status().every((entry) => entry.state === "running"), "the services to run");
  return started;
}

function deps(): CapabilityInvokeDeps {
  return { db, nodeId: NODE, principalId: PRINCIPAL, newId: (prefix) => `${prefix}_${String(++counter)}`, serviceHost: host, packageJobs: jobs, dataDir: dir };
}

function pick(bytes: Uint8Array, instanceId = INSTANCE, name = "clip.wav", mimeType = "audio/wav") {
  const stored = storePickedArtifact(broker, { principalId: PRINCIPAL, conversationId: CONVERSATION, instanceId, name, mimeType, bytes, accept: [mimeType] });
  if (!stored.ok) throw new Error(stored.message);
  return stored.ref;
}

function press(args: Record<string, unknown>, instanceId = INSTANCE) {
  return invokeCapability(deps(), {
    ref: RENDER,
    args,
    source: "widget",
    conversationId: CONVERSATION,
    bindingGeneration: GENERATION,
    jobOrigin: { instanceId, actionBindingId: BINDING },
  });
}

const OWNER = { ownerPrincipalId: PRINCIPAL, instanceId: INSTANCE, actionBindingId: BINDING, packageGeneration: GENERATION };

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** What the render must produce, computed here from the transform alone. */
function expectedRender(input: Uint8Array, parameters: { gainDb: number; trimStartMs?: number; trimEndMs?: number }): Uint8Array {
  const header = parseWavHeader(input.subarray(0, WAV_HEADER_BYTES), input.byteLength);
  if (!header.ok) throw new Error(header.reason);
  const plan = renderPlan(header, parameters);
  if (!plan.ok) throw new Error(plan.reason);
  const output = new Uint8Array(44 + plan.end - plan.start);
  output.set(wavHeader(header.format, plan.end - plan.start), 0);
  output.set(applyGain(input.subarray(plan.start, plan.end), plan.gain), 44);
  return output;
}

function readAll(artifactId: string, sizeBytes: number): Uint8Array {
  const out = new Uint8Array(sizeBytes);
  for (let offset = 0; offset < sizeBytes; offset += 262_144) {
    const read = readArtifactRange(broker, { principalId: PRINCIPAL, instanceId: INSTANCE, artifactId, offset, length: 262_144 });
    if (!read.ok) throw new Error(read.message);
    out.set(read.bytes, offset);
  }
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-artifact-input-"));
  roots = { [PACKAGE]: join(dir, "media-render") };
  cpSync(MEDIA, roots[PACKAGE] ?? "", { recursive: true, filter: (source) => !source.includes(`${join(MEDIA, "test")}`) });
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  logs.length = 0;
  fetched = [];
  // The widget a person presses is one this conversation holds, and the files it picked are this conversation's.
  hold(INSTANCE);
  broker ={ db, dataDir: dir, nodeId: NODE, newId: (prefix) => `${prefix}_${String(++counter)}`, now: () => new Date() };
  supervisor = createWorkSupervisor();
  jobs = createPackageJobHost({ db, nodeId: NODE, nodeBootId: "boot_1", newId: broker.newId, supervisor, artifactBroker: broker });
});

afterEach(async () => {
  jobs.stopAll();
  await host?.stopAll();
  host = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("a package service reading a widget's file", () => {
  it("renders a picked clip larger than one chunk as a job, with progress, and keeps the result as a file", async () => {
    activate(PACKAGE, GENERATION);
    await startServices();
    const clip = fixtureClip({ seconds: 24 });
    expect(clip.byteLength).toBeGreaterThan(262_144);
    const source = pick(clip);
    const parameters = { gainDb: -6, trimStartMs: 250, trimEndMs: 250 };

    const outcome = await press({ source: source.artifactId, ...parameters });
    if (outcome.kind !== "job") throw new Error(`expected a job, got ${JSON.stringify(outcome)}`);
    const seen: number[] = [];
    jobs.subscribe(outcome.job.jobId, OWNER, (job) => {
      if (job.progress !== undefined) seen.push(job.progress.current);
    });
    const ended = await until(() => {
      const job = jobs.get(outcome.job.jobId, OWNER);
      return job !== undefined && job.status !== "running" && job.status !== "queued" ? job : undefined;
    }, "the render to end");

    expect(ended.status).toBe("completed");
    expect(ended.output).toContain("Rendered 23.5 s at -6 dB");
    expect(ended.progress).toMatchObject({ current: ended.progress?.total });
    expect(seen.length).toBeGreaterThan(0);
    expect(ended.resultRefs).toHaveLength(1);
    const result = ended.resultRefs[0];
    if (result === undefined) throw new Error("no result");
    expect(result).toMatchObject({ kind: "finalized", mimeType: "audio/wav", name: "untitled.wav" });

    // The file the widget is given is exactly the render of the clip it picked, and its digest says so.
    const expected = expectedRender(clip, parameters);
    expect(result.sizeBytes).toBe(expected.byteLength);
    expect(result.digest).toBe(sha256(expected));
    expect(sha256(readAll(result.artifactId, result.sizeBytes))).toBe(sha256(expected));
  });

  it("stops a render mid-way and keeps no file from it", async () => {
    activate(PACKAGE, GENERATION);
    // Each read answered late, as a fixture node does, so the render is still running when it is stopped.
    await startServices({ artifactReadDelayMs: 200 });
    const clip = fixtureClip({ seconds: 24 });
    const source = pick(clip);
    const before = storedBytesForPrincipal(db, PRINCIPAL);

    const outcome = await press({ source: source.artifactId, gainDb: 0 });
    if (outcome.kind !== "job") throw new Error(`expected a job, got ${JSON.stringify(outcome)}`);
    await until(() => (jobs.get(outcome.job.jobId, OWNER)?.progress?.current ?? 0) > 0, "progress");
    expect(jobs.cancel(outcome.job.jobId, OWNER)).toBe(true);
    const ended = await until(() => {
      const job = jobs.get(outcome.job.jobId, OWNER);
      return job?.status === "cancelled" ? job : undefined;
    }, "the cancel");
    expect(ended.resultRefs).toEqual([]);
    expect(ended.progress?.current).toBeLessThan(ended.progress?.total ?? 0);
    // Wait out the read that was on its way; the service answers nothing, and nothing is stored.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(jobs.get(outcome.job.jobId, OWNER)?.status).toBe("cancelled");
    expect(storedBytesForPrincipal(db, PRINCIPAL)).toBe(before);
  });

  it("refuses a file over the granted profile's input cap before anything is sent", async () => {
    requesting("interactive-light");
    activate(PACKAGE, GENERATION);
    await startServices();
    const cap = RESOURCE_PROFILES["interactive-light"].input.maxBytes;
    const clip = fixtureClip({ seconds: Math.ceil(cap / 44_100) + 2 });
    expect(clip.byteLength).toBeGreaterThan(cap);
    const source = pick(clip);

    const outcome = await press({ source: source.artifactId, gainDb: 0 });
    expect(outcome).toMatchObject({ kind: "refused", status: 413, code: "ARTIFACT_INPUT_TOO_LARGE" });
    if (outcome.kind === "refused") {
      expect(outcome.message).toBe(`clip.wav is ${String(clip.byteLength)} bytes, over the ${String(cap)} byte input this package's resource profile allows; nothing was sent`);
    }
    expect(supervisor.list()).toEqual([]);
  });

  it("refuses a file the pressing widget holds no grant on", async () => {
    activate(PACKAGE, GENERATION);
    await startServices();
    const theirs = pick(fixtureClip({ seconds: 1 }), "winst_someone_else");
    const outcome = await press({ source: theirs.artifactId, gainDb: 0 });
    expect(outcome).toMatchObject({ kind: "refused", status: 403, code: "ARTIFACT_INPUT_REFUSED" });
    expect(supervisor.list()).toEqual([]);
  });

  it("answers a service's read only for a file its call declared, and refuses any other id it asks for", async () => {
    writeReaderPackage();
    activate(READER, READER_GENERATION);
    await startServices();
    const mine = pick(new TextEncoder().encode("plain text one"), INSTANCE, "one.txt", "text/plain");
    // Held by the same widget, but not named in a declared field of this call.
    const other = pick(new TextEncoder().encode("plain text two"), INSTANCE, "two.txt", "text/plain");

    const outcome = await invokeCapability(deps(), {
      ref: READ_TWO,
      args: { source: mine.artifactId, other: other.artifactId },
      source: "widget",
      conversationId: CONVERSATION,
      bindingGeneration: READER_GENERATION,
      jobOrigin: { instanceId: INSTANCE, actionBindingId: "binding_reader" },
    });
    if (outcome.kind !== "done") throw new Error(`expected an answer, got ${JSON.stringify(outcome)}`);
    const answer = JSON.parse(outcome.output) as {
      first: { result?: { bytes: string; mimeType: string; sizeBytes: number } };
      second: { error?: { code: number } };
    };
    expect(Buffer.from(answer.first.result?.bytes ?? "", "base64").toString("utf8")).toBe("plai");
    expect(answer.first.result).toMatchObject({ mimeType: "text/plain", sizeBytes: 14 });
    expect(answer.second.error?.code).toBe(SERVICE_ARTIFACT_ERROR_CODES.notAnInput);
  });
});

describe("the boundary around a call that holds a file", () => {
  const note = () => pick(new TextEncoder().encode("plain text one"), INSTANCE, "note.txt", "text/plain");
  let report: string;

  beforeEach(() => {
    writeProbePackage();
    activate(PROBE, PROBE_GENERATION);
    report = join(dir, "probe-report.json");
  });

  function probe(source: string, steps: unknown[], overrides: { deps?: CapabilityInvokeDeps; instanceId?: string } = {}) {
    return invokeCapability(overrides.deps ?? deps(), {
      ref: PROBE_READ,
      args: { source, steps, report },
      source: "widget",
      conversationId: CONVERSATION,
      bindingGeneration: PROBE_GENERATION,
      jobOrigin: { instanceId: overrides.instanceId ?? INSTANCE, actionBindingId: PROBE_BINDING },
    });
  }

  async function answers(outcome: ReturnType<typeof probe>): Promise<ProbeAnswer[]> {
    const settled = await outcome;
    if (settled.kind !== "done") throw new Error(`expected an answer, got ${JSON.stringify(settled)}; log: ${logs.join(" | ")}`);
    return JSON.parse(settled.output) as ProbeAnswer[];
  }

  function writePolicy(mode: "ask"): void {
    const outcome = writeRegisteredPreference(
      { db, now: () => new Date().toISOString() as Instant },
      { principalId: PRINCIPAL, key: EXECUTION_POLICY_PREFERENCE_KEY, value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode }, source: "user" },
    );
    if (!outcome.ok) throw new Error(outcome.message);
  }

  it("refuses the service's egress while a call decided as a read holds a file, and answers it for one decided as external-write", async () => {
    const services = await startServices();
    const file = note();
    const egress = { op: "egress", url: `${PROVIDER}/lookup?q=plai` };

    // The file was read, and a GET to the package's own declared origin would carry it there: refused, with the reason.
    const held = await answers(probe(file.artifactId, [{ op: "read" }, egress]));
    expect(held[0]).toMatchObject({ bytes: 4 });
    expect(held[1]?.code).toBe(EGRESS_ERROR_CODES.inputHeld);
    expect(held[1]?.message).toContain("holds a person's file and is decided as read");
    expect(fetched).toEqual([]);

    // The same request from a call that holds no file is a read like any other.
    const free = await services.call(PROBE_READ, { source: "none", steps: [egress] });
    expect(JSON.parse(free.content)).toEqual([{ status: 200 }]);
    // And a call decided as external-write may carry what it holds: that decision is the one that covers sending it.
    const input = { ids: new Set([file.artifactId]), read: async () => ({ ok: false as const, message: "not read here" }) };
    const written = await services.call(PROBE_READ, { source: file.artifactId, steps: [egress] }, { effectCategory: "external-write", artifactInput: input });
    expect(JSON.parse(written.content)).toEqual([{ status: 200 }]);
    expect(fetched).toEqual([`${PROVIDER}/lookup?q=plai`, `${PROVIDER}/lookup?q=plai`]);
  });

  it("refuses a file named by Clark or by voice: only the pressing widget's button can hand one over", async () => {
    await startServices();
    const file = note();
    for (const source of ["agent", "voice"] as const) {
      const outcome = await invokeCapability(deps(), {
        ref: PROBE_READ,
        args: { source: file.artifactId, steps: [{ op: "read" }] },
        source,
        conversationId: CONVERSATION,
      });
      expect(outcome).toMatchObject({ kind: "refused", status: 403, code: "ARTIFACT_INPUT_REFUSED" });
    }
  });

  it("answers no read once the call has ended, even one sent while it was in flight", async () => {
    // The answer to the read sent in flight is held back until after the call has ended.
    await startServices({ artifactReadDelayMs: 300 });
    const file = note();
    await answers(probe(file.artifactId, [{ op: "read", detach: true }, { op: "answer" }, { op: "read" }]));
    const late = JSON.parse(await until(() => (existsSync(report) ? readFileSync(report, "utf8") : undefined), "the report")) as {
      results: ProbeAnswer[];
      detached: ProbeAnswer[];
    };
    expect(late.results).toMatchObject([{ code: SERVICE_ARTIFACT_ERROR_CODES.notAnInput }]);
    expect(late.detached).toMatchObject([{ code: SERVICE_ARTIFACT_ERROR_CODES.notAnInput }]);
    expect(late.detached[0]?.bytes).toBeUndefined();
  });

  it("stops answering reads of a file whose grant is revoked mid-call", async () => {
    await startServices();
    const file = note();
    const reached = join(dir, "reached");
    const resume = join(dir, "resume");
    const outcome = probe(file.artifactId, [{ op: "read" }, { op: "signal", path: reached }, { op: "waitFor", path: resume }, { op: "read" }]);
    await until(() => existsSync(reached), "the first read");
    expect(revokeArtifactAccess(broker, { principalId: PRINCIPAL, instanceId: INSTANCE, artifactId: file.artifactId })).toMatchObject({ ok: true, revoked: true });
    writeFileSync(resume, "go");
    const [first, second] = await answers(outcome);
    expect(first).toMatchObject({ bytes: 4 });
    expect(second?.code).toBe(SERVICE_ARTIFACT_ERROR_CODES.refused);
  });

  it("refuses a read longer than one 256 KiB chunk, and answers one that is not", async () => {
    await startServices();
    const file = note();
    const [over, chunk] = await answers(probe(file.artifactId, [{ op: "read", length: 262_145 }, { op: "read", length: 262_144 }]));
    expect(over?.code).toBe(SERVICE_ARTIFACT_ERROR_CODES.invalid);
    expect(chunk).toMatchObject({ bytes: 14 });
  });

  it("refuses a file that is still being written before anything is sent", async () => {
    await startServices();
    const working = createWorkingArtifact(broker, { principalId: PRINCIPAL, conversationId: CONVERSATION, instanceId: INSTANCE, mimeType: "text/plain", name: "draft.txt" });
    if (!working.ok) throw new Error(working.message);
    const outcome = await probe(working.ref.artifactId, [{ op: "read" }]);
    expect(outcome).toMatchObject({ kind: "refused", status: 403, code: "ARTIFACT_INPUT_REFUSED" });
    if (outcome.kind === "refused") expect(outcome.message).toContain("still being written");
  });

  it("refuses reads past the call's budget, so a service cannot keep re-reading a file", async () => {
    await startServices();
    const file = note();
    // 14 bytes: the budget is four passes over them, 56 bytes, in 4-byte reads.
    const read = await answers(probe(file.artifactId, [{ op: "read", times: 30 }]));
    expect(read.filter((answer) => answer.bytes === 4)).toHaveLength(14);
    const refusals = read.slice(14);
    expect(refusals).toHaveLength(16);
    expect(refusals.every((answer) => answer.code === SERVICE_ARTIFACT_ERROR_CODES.refused)).toBe(true);
    expect(refusals[0]?.message).toContain("this call has used its read budget");
  });

  it("refuses a file when the node cannot say which profile bounds the package", async () => {
    const services = await startServices();
    const file = note();
    const withoutProfile: ServiceHost = { ...services };
    delete withoutProfile.profile;
    const outcome = await probe(file.artifactId, [{ op: "read" }], { deps: { ...deps(), serviceHost: withoutProfile } });
    expect(outcome).toMatchObject({ kind: "refused", status: 403, code: "ARTIFACT_INPUT_REFUSED" });
    if (outcome.kind === "refused") expect(outcome.message).toContain("cannot tell which resource profile");
  });

  it("refuses a file from another conversation, and a widget this conversation does not hold", async () => {
    await startServices();
    hold(INSTANCE, "conv_other");
    const stored = storePickedArtifact(broker, {
      principalId: PRINCIPAL,
      conversationId: "conv_other",
      instanceId: INSTANCE,
      name: "elsewhere.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("from another conversation"),
      accept: ["text/plain"],
    });
    if (!stored.ok) throw new Error(stored.message);
    const elsewhere = await probe(stored.ref.artifactId, [{ op: "read" }]);
    expect(elsewhere).toMatchObject({ kind: "refused", status: 403, code: "ARTIFACT_INPUT_REFUSED" });
    if (elsewhere.kind === "refused") expect(elsewhere.message).toBe("that artifact belongs to another conversation; nothing was sent");

    // A widget the conversation no longer holds, pressing over a file it picked here.
    const loose = pick(new TextEncoder().encode("loose"), "winst_loose", "loose.txt", "text/plain");
    const unheld = await probe(loose.artifactId, [{ op: "read" }], { instanceId: "winst_loose" });
    expect(unheld).toMatchObject({ kind: "refused", status: 403, code: "ARTIFACT_INPUT_REFUSED" });
    expect(fetched).toEqual([]);
  });

  it("runs an approved call that reads a file as the press it was approved for, and refuses the replay when that press is gone", async () => {
    await startServices();
    writePolicy("ask");
    const file = note();
    const asked = await probe(file.artifactId, [{ op: "read" }]);
    if (asked.kind !== "approval-required") throw new Error(`expected a card, got ${JSON.stringify(asked)}`);
    // The card names the press, so the digest the person approved covers which widget's file is read.
    expect(JSON.parse(asked.card.payload ?? "{}")).toMatchObject({ jobOrigin: { instanceId: INSTANCE, actionBindingId: PROBE_BINDING } });

    const replay = (present: boolean) =>
      runApprovedCapability(deps(), {
        payload: asked.card.payload ?? "",
        expectedDigest: asked.card.operationDigest,
        approvalId: asked.approval.approvalId,
        conversationId: CONVERSATION,
        checkJobOrigin: (origin, ref) =>
          present && origin.instanceId === INSTANCE && ref === PROBE_READ
            ? { ok: true, bindingGeneration: PROBE_GENERATION }
            : { ok: false, message: "the widget this job was approved for is no longer here" },
      });
    expect(await replay(false)).toMatchObject({ ok: false, code: "APPROVAL_STALE" });
    const approved = await replay(true);
    expect(approved).toMatchObject({ ok: true, succeeded: true, outcome: { kind: "done" } });
    if (approved.ok && approved.outcome.kind === "done") expect(JSON.parse(approved.outcome.output)).toEqual([{ bytes: 4 }]);
  });
});
