import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityRef, Instant, JobRecord } from "../../../../packages/contracts/src/index.ts";
import { getCapability } from "../../../../packages/core/src/index.ts";
import { migrate, openDatabase, type Database } from "../../../../packages/storage/src/index.ts";
import { type CapabilityInvokeDeps, invokeCapability } from "../../../../apps/runtime/src/application/capability-invoke.ts";
import { storeCredentialFields } from "../../../../apps/runtime/src/application/credential-vault.ts";
import { type ArtifactBrokerDeps, readArtifactRange } from "../../../../apps/runtime/src/artifact-broker.ts";
import { createPackageJobHost, type PackageJobHost } from "../../../../apps/runtime/src/job-host.ts";
import { createSecretBroker } from "../../../../apps/runtime/src/secret-broker.ts";
import { type EgressAuditEvent, egressSecretProblem } from "../../../../apps/runtime/src/service-egress.ts";
import type { ServiceEngine } from "../../../../apps/runtime/src/service-container.ts";
import { createServiceHost, type ServiceHost, type ServiceLauncher } from "../../../../apps/runtime/src/service-host.ts";
import { createWorkSupervisor } from "../../../../apps/runtime/src/work-supervisor.ts";
import { renderImage } from "../service/png.mjs";
import { FAKE_PROVIDER_STEPS, type FakeProvider, startFakeProvider } from "./fake-provider.ts";

/**
 * The image generator's service, run by the node's own service host and job host against the fake provider.
 *
 * The service runs as a plain Node process through the host's launcher seam, as the runtime's own service tests run
 * theirs; the browser journey runs the same package in a real container. Everything between the call and the stored
 * image is the node's: the gate, the job, the egress broker that adds the key, the progress the service reports and the
 * artifact the image becomes.
 */

const NODE = "node_image";
const PRINCIPAL = "prin_owner";
const PACKAGE = "com.clarkcant.reference.image-generator";
const GENERATION = `${PACKAGE}@1.0.0:code_1`;
const GENERATE = `${PACKAGE}.image.generate@1` as CapabilityRef;
const SECRET_NAME = "IMAGE_PROVIDER_KEY";
const SOURCE = fileURLToPath(new URL("..", import.meta.url));
const RUNNING: ServiceEngine = { available: true, engine: "docker", version: "test" };
const OWNER = { ownerPrincipalId: PRINCIPAL, instanceId: "winst_gallery", actionBindingId: "binding_image_generate", packageGeneration: GENERATION };

let dir: string;
let db: Database;
let host: ServiceHost | undefined;
let jobs: PackageJobHost;
let broker: ArtifactBrokerDeps;
let provider: FakeProvider;
let secret: string;
let counter = 0;
const logs: string[] = [];
const audit: EgressAuditEvent[] = [];
const notices: string[] = [];
const launched: unknown[] = [];

const newId = (prefix: string): string => `${prefix}_${String(++counter)}`;

function plainLauncher(): ServiceLauncher {
  const wrapper = join(dir, "run-service.mjs");
  writeFileSync(wrapper, "await import(process.argv[2]);\n");
  return (spec) => {
    launched.push(spec);
    return { command: process.execPath, args: [wrapper, pathToFileURL(join(spec.packageRoot, spec.entry)).href] };
  };
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

function storeKey(value = secret): void {
  const stored = storeCredentialFields({ db, ownerPrincipalId: PRINCIPAL, nodeId: NODE, newId }, [
    { name: SECRET_NAME, value, kind: "token", consumer: `package:${PACKAGE}` },
  ]);
  expect(stored.ok).toBe(true);
}

async function startService(): Promise<ServiceHost> {
  host = createServiceHost({
    registry: { db, nodeId: NODE },
    dataDir: dir,
    engine: async () => RUNNING,
    packageRoot: (generation) => (generation.packageId === PACKAGE ? join(dir, "package") : undefined),
    launcher: plainLauncher(),
    log: (line) => logs.push(line),
    timings: { restartBaseMs: 20, pingIntervalMs: 60_000 },
    egress: {
      secrets: createSecretBroker({ db, principalId: PRINCIPAL, now: () => new Date().toISOString() as Instant }),
      secretProblem: (packageId, name) => egressSecretProblem({ db, principalId: PRINCIPAL }, packageId, name),
      audit: (event) => audit.push(event),
      // The fake provider is on loopback, which a node reaches for services only when it is started saying so.
      allowPrivateNetwork: true,
    },
  });
  const serviceHost = host;
  await serviceHost.reconcile();
  await until(() => serviceHost.status().length > 0 && serviceHost.status().every((entry) => entry.state === "running"), "the service");
  return serviceHost;
}

function deps(): CapabilityInvokeDeps {
  return { db, nodeId: NODE, principalId: PRINCIPAL, newId, serviceHost: host, packageJobs: jobs };
}

function generate(prompt: string, invocationId = newId("inv")) {
  return invokeCapability(deps(), {
    ref: GENERATE,
    args: { prompt },
    source: "widget",
    conversationId: "conv_images",
    bindingGeneration: GENERATION,
    jobOrigin: { instanceId: OWNER.instanceId, actionBindingId: OWNER.actionBindingId, invocationId },
  });
}

async function started(prompt: string): Promise<{ jobId: string; seen: JobRecord[] }> {
  const outcome = await generate(prompt);
  if (outcome.kind !== "job") throw new Error(`the job did not start: ${JSON.stringify(outcome)}`);
  const seen: JobRecord[] = [];
  jobs.subscribe(outcome.job.jobId, OWNER, (snapshot) => seen.push(snapshot));
  return { jobId: outcome.job.jobId, seen };
}

const ended = (jobId: string) =>
  until(() => {
    const job = jobs.get(jobId, OWNER);
    return job !== undefined && !["queued", "running", "waiting"].includes(job.status) ? job : undefined;
  }, `job ${jobId} to end`);

/** Every byte the node wrote under its data directory, as text, so a key in any file is found. */
function everythingWritten(root: string): string {
  let text = "";
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    text += statSync(path).isDirectory() ? everythingWritten(path) : readFileSync(path).toString("latin1");
  }
  return text;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cc-image-generator-"));
  secret = `fake-${randomBytes(16).toString("hex")}`;
  provider = await startFakeProvider({ key: secret });
  // The package as published, with its provider origin moved to this test's port.
  cpSync(SOURCE, join(dir, "package"), { recursive: true, filter: (path) => !path.includes(`${join(SOURCE, "test")}`) });
  const manifestPath = join(dir, "package", "clarkcant.json");
  const manifest = readFileSync(manifestPath, "utf8");
  expect(manifest).toContain("http://127.0.0.1:8881");
  writeFileSync(manifestPath, manifest.replace("http://127.0.0.1:8881", provider.origin));

  db = openDatabase({ path: ":memory:" });
  migrate(db);
  const at = new Date().toISOString();
  const generation = {
    generationId: GENERATION,
    packageId: PACKAGE,
    version: "1.0.0",
    digest: "sha256:image-generator-digest",
    nodeId: NODE,
    codeGeneration: "code_1",
    activatedAt: at,
    uiOnlyFacets: [],
    grantedCapabilities: [],
  };
  db.prepare(
    `INSERT INTO package_generations (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(GENERATION, PACKAGE, "1.0.0", generation.digest, NODE, "code_1", at, JSON.stringify(generation));

  broker = { db, dataDir: dir, nodeId: NODE, newId, now: () => new Date() };
  jobs = createPackageJobHost({
    db,
    nodeId: NODE,
    nodeBootId: "boot_image",
    newId,
    supervisor: createWorkSupervisor(),
    artifactBroker: broker,
    report: (_conversationId, text) => notices.push(text),
    // The assertions below read the ending in English; the owner's language is the job host's concern, tested there.
    language: () => "en",
  });
  logs.length = 0;
  audit.length = 0;
  notices.length = 0;
  launched.length = 0;
});

afterEach(async () => {
  await host?.stopAll();
  host = undefined;
  await provider.close();
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("the image generator service", () => {
  it("is not signed in, and sends nothing, until the person stores the provider key for this package", async () => {
    await startService();
    expect(getCapability({ db, nodeId: NODE }, GENERATE, NODE)).toMatchObject({
      requiresConnection: true,
      readiness: { authenticated: false, blockedReason: `the secret ${SECRET_NAME} has not been provided on this node` },
    });
    expect(await generate("a red kite")).toMatchObject({ kind: "refused", code: "CAPABILITY_NOT_AUTHENTICATED", sent: false });
    expect(provider.requests).toEqual([]);
  });

  it("runs as a job: the provider's progress, then a PNG artifact the widget can read, and a note in the conversation", async () => {
    storeKey();
    await startService();
    const { jobId, seen } = await started("a red kite over the river");
    const job = await ended(jobId);

    expect(job).toMatchObject({ status: "completed", capabilityRef: GENERATE, conversationId: "conv_images", instanceId: OWNER.instanceId });
    // Progress is only what the provider reported, one step per status read, up to its total.
    const steps = seen.flatMap((snapshot) => (snapshot.progress === undefined ? [] : [snapshot.progress.current]));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(job.progress).toEqual({ current: FAKE_PROVIDER_STEPS, total: FAKE_PROVIDER_STEPS, message: `The provider finished step ${String(FAKE_PROVIDER_STEPS)} of ${String(FAKE_PROVIDER_STEPS)}.` });
    expect(job.output).toContain("Image for “a red kite over the river” (192×192 PNG).");

    expect(job.resultRefs).toHaveLength(1);
    const ref = job.resultRefs[0];
    if (ref === undefined) throw new Error("no image");
    expect(ref).toMatchObject({ kind: "finalized", mimeType: "image/png" });
    const read = readArtifactRange(broker, { principalId: PRINCIPAL, instanceId: OWNER.instanceId, artifactId: ref.artifactId, offset: 0, length: ref.sizeBytes });
    if (!read.ok) throw new Error("the image could not be read back");
    expect(Buffer.from(read.bytes).equals(renderImage("a red kite over the river"))).toBe(true);
    // Another widget cannot read it by its ref.
    expect(readArtifactRange(broker, { principalId: PRINCIPAL, instanceId: "winst_other", artifactId: ref.artifactId, offset: 0, length: 10 }).ok).toBe(false);
    expect(notices.join("\n")).toContain(`The package job for ${GENERATE} completed and produced`);

    // Every provider request was one the node signed; none was made without the key. Starting the image was the one
    // POST, its prompt in the body (the fake refuses one in the URL); following it and fetching it were reads.
    expect(provider.requests.length).toBeGreaterThanOrEqual(FAKE_PROVIDER_STEPS + 2);
    expect(provider.requests.every((request) => request.authorized)).toBe(true);
    expect(provider.requests.map((request) => `${request.method} ${request.path.replace(/img_\d+/u, "{id}")}`)).toEqual([
      "POST /v1/images/generate",
      ...provider.requests.slice(1, -1).map(() => "GET /v1/images/{id}"),
      "GET /v1/images/{id}/image",
    ]);
    expect(audit.every((event) => event.secret === SECRET_NAME && event.outcome === "done")).toBe(true);
  });

  it("ends as failed with the provider's reason, keeping no image", async () => {
    storeKey();
    await startService();
    provider.failNext(2);
    const { jobId } = await started("a storm");
    const job = await ended(jobId);
    expect(job).toMatchObject({ status: "failed", resultRefs: [] });
    expect(job.error).toContain("The provider could not make the image: the provider ran out of ink");
  });

  it("redacts the key from a provider error that echoes it, plain and JSON-escaped, before it reaches the job", async () => {
    // Quote and backslash make the JSON-escaped form on the wire differ from the key as the person stored it.
    secret = `fake-"quoted"\\${randomBytes(8).toString("hex")}`;
    await provider.close();
    provider = await startFakeProvider({ key: secret });
    const manifestPath = join(dir, "package", "clarkcant.json");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace(/http:\/\/127\.0\.0\.1:\d+/u, provider.origin));
    storeKey();
    await startService();
    provider.failNext(2, "the provider ran out of ink", { echoKey: true });
    const { jobId } = await started("a leaking pen");
    const job = await ended(jobId);

    expect(job.status).toBe("failed");
    expect(job.error).toContain("the provider ran out of ink (request signed with [redacted])");
    const escaped = JSON.stringify(secret).slice(1, -1);
    for (const form of [secret, escaped]) {
      expect(job.error).not.toContain(form);
      expect(JSON.stringify(db.prepare("SELECT * FROM jobs").all())).not.toContain(form);
      expect(notices.join("\n")).not.toContain(form);
      expect(logs.join("\n")).not.toContain(form);
    }
  });

  it("says plainly when the provider refuses the key it was given", async () => {
    storeKey("fake-wrong-key");
    await startService();
    const { jobId } = await started("a lighthouse");
    const job = await ended(jobId);
    expect(job).toMatchObject({ status: "failed", resultRefs: [] });
    expect(job.error).toContain("The provider refused the key this package was given (401).");
    expect(provider.requests.map((request) => request.authorized)).toEqual([false]);
  });

  it("stops a running job when it is cancelled, and the provider is asked nothing more", async () => {
    storeKey();
    await startService();
    provider.holdAt(1);
    const { jobId } = await started("a slow sunrise");
    await until(() => jobs.get(jobId, OWNER)?.progress?.current === 1, "the first step");
    expect(jobs.cancel(jobId, { ...OWNER, actionBindingId: "binding_other" })).toBe(false);
    expect(jobs.cancel(jobId, OWNER)).toBe(true);
    const job = await ended(jobId);
    expect(job).toMatchObject({ status: "cancelled", resultRefs: [] });

    // The service stops polling once it hears; give it a few poll intervals to prove it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const asked = provider.requests.length;
    provider.release();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(provider.requests.length).toBe(asked);
    expect(provider.requests.some((request) => request.path.endsWith("/image"))).toBe(false);
  });

  it("never lets the key reach the service, its results, the job, the logs, the audit or the files the node keeps", async () => {
    storeKey();
    await startService();
    const { jobId } = await started("a quiet harbour");
    const job = await ended(jobId);
    expect(job.status).toBe("completed");

    expect(JSON.stringify(launched)).not.toContain(secret);
    expect(JSON.stringify(job)).not.toContain(secret);
    expect(JSON.stringify(db.prepare("SELECT * FROM jobs").all())).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(notices.join("\n")).not.toContain(secret);
    expect(everythingWritten(dir)).not.toContain(secret);
  });
});
