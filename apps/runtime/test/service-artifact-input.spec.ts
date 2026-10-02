import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CapabilityRef, RESOURCE_PROFILES, SERVICE_ARTIFACT_ERROR_CODES } from "@clarkcant/contracts";
import { migrate, openDatabase, type Database } from "@clarkcant/storage";

import { type CapabilityInvokeDeps, invokeCapability } from "../src/application/capability-invoke.ts";
import { type ArtifactBrokerDeps, readArtifactRange, storePickedArtifact, storedBytesForPrincipal } from "../src/artifact-broker.ts";
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

async function until<T>(read: () => T | undefined | false, what: string, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; log: ${logs.join(" | ")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startServices(): Promise<ServiceHost> {
  host = createServiceHost({
    registry: { db, nodeId: NODE },
    dataDir: dir,
    engine: async () => ({ available: true, engine: "docker", version: "test" }),
    packageRoot: (generation) => roots[generation.packageId],
    launcher: plainLauncher(),
    log: (line) => logs.push(line),
    timings: { restartBaseMs: 20, pingIntervalMs: 60_000 },
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
  broker = { db, dataDir: dir, nodeId: NODE, newId: (prefix) => `${prefix}_${String(++counter)}`, now: () => new Date() };
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
    await startServices();
    const clip = fixtureClip({ seconds: 24 });
    const source = pick(clip);
    const before = storedBytesForPrincipal(db, PRINCIPAL);

    const outcome = await press({ source: source.artifactId, gainDb: 0, paceMs: 200 });
    if (outcome.kind !== "job") throw new Error(`expected a job, got ${JSON.stringify(outcome)}`);
    await until(() => (jobs.get(outcome.job.jobId, OWNER)?.progress?.current ?? 0) > 0, "progress");
    expect(jobs.cancel(outcome.job.jobId, OWNER)).toBe(true);
    const ended = await until(() => {
      const job = jobs.get(outcome.job.jobId, OWNER);
      return job?.status === "cancelled" ? job : undefined;
    }, "the cancel");
    expect(ended.resultRefs).toEqual([]);
    expect(ended.progress?.current).toBeLessThan(ended.progress?.total ?? 0);
    // Wait out the pace the service was in; it answers nothing, and nothing is stored.
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
