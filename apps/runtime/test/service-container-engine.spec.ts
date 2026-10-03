import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type CapabilityRef, type Instant, RESOURCE_PROFILES, type ResourceProfile } from "@clarkcant/contracts";
import { StdioMcpTransport } from "@clarkcant/mcp-adapters";
import { createConversation, createPin, migrate, openDatabase } from "@clarkcant/storage";

import { invokeCapability } from "../src/application/capability-invoke.ts";
import { storeCredentialFields } from "../src/application/credential-vault.ts";
import { type ArtifactBrokerDeps, readArtifactRange, storePickedArtifact } from "../src/artifact-broker.ts";
import { createPackageJobHost } from "../src/job-host.ts";
import { createSecretBroker } from "../src/secret-broker.ts";
import { egressSecretProblem } from "../src/service-egress.ts";
import { containerLauncher, createServiceHost, engineContainers } from "../src/service-host.ts";
import { createWorkSupervisor } from "../src/work-supervisor.ts";
import { WAV_HEADER_BYTES, applyGain, fixtureClip, parseWavHeader, renderPlan, wavHeader } from "../../../examples/reference-apps/media-render/service/wav.mjs";

import {
  detectServiceEngine,
  ensureServiceImage,
  prepareServiceDataDir,
  readEngineCapacity,
  removeServiceContainer,
  runEngine,
  serviceContainerName,
  serviceRunArgs,
} from "../src/service-container.ts";

/**
 * The container boundary, checked from inside a real container.
 *
 * `service-container.spec.ts` reads the command line; this runs it. A probe in place of a service tries each thing the
 * boundary exists to refuse and reports what happened, so a flag an engine ignores is caught here rather than trusted.
 *
 * Needs an engine that runs Linux containers. CI runs it on Linux under rootful Docker, rootless Docker and rootless
 * Podman; a machine without one (the macOS and Windows runners) has nothing this can check, and the suite says so by
 * skipping. Docker Desktop and Podman machine on macOS and Windows are checked by hand (`docs/platform-smoke.md`).
 */

const engine = await detectServiceEngine({ timeoutMs: 10_000 });

const NOTES_PACKAGE = fileURLToPath(new URL("../../web/e2e/fixtures/notes-service/", import.meta.url));

const PROBE = `
import { readFileSync, writeFileSync } from "node:fs";
const tried = {};
async function attempt(name, work) {
  try { await work(); tried[name] = "allowed"; } catch (error) { tried[name] = error.code ?? error.cause?.code ?? error.name; }
}
await attempt("network", () => fetch("http://1.1.1.1", { signal: AbortSignal.timeout(3000) }));
await attempt("writePackage", () => writeFileSync("/pkg/escaped.txt", "x"));
await attempt("writeRoot", () => writeFileSync("/etc/escaped.txt", "x"));
await attempt("writeRun", () => writeFileSync("/run/escaped.txt", "x"));
await attempt("writeVarTmp", () => writeFileSync("/var/tmp/escaped.txt", "x"));
tried.tmpfs = Object.fromEntries(
  readFileSync("/proc/mounts", "utf8").split("\\n").map((line) => line.split(" ")).filter((fields) => fields[2] === "tmpfs").map((fields) => [fields[1], fields[3]]),
);
await attempt("writeData", () => writeFileSync("/data/kept.txt", "kept"));
tried.uid = process.getuid();
tried.env = Object.keys(process.env).filter((key) => key.startsWith("CC_") || key.includes("KEY") || key.includes("TOKEN"));
process.stdout.write(JSON.stringify(tried));
`;

/**
 * What the kernel applies to the container, read from inside it: the cgroup v2 limits and the size of `/tmp`. A
 * second mode holds memory well past the light profile, page by page, so the limit is shown biting, not only set.
 */
const LIMITS_PROBE = `
import { readFileSync, statfsSync } from "node:fs";
const read = (path) => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };
if (process.argv[2] === "hold") {
  const held = [];
  for (let mib = 0; mib < Number(process.argv[3]); mib += 16) held.push(Buffer.alloc(16 * 1024 * 1024, 1));
  process.stdout.write(JSON.stringify({ held: held.length * 16 }));
} else {
  const tmp = statfsSync("/tmp");
  process.stdout.write(JSON.stringify({
    memory: read("/sys/fs/cgroup/memory.max"),
    cpu: read("/sys/fs/cgroup/cpu.max"),
    pids: read("/sys/fs/cgroup/pids.max"),
    tmpBytes: tmp.blocks * tmp.bsize,
  }));
}
`;

const capacity = engine.available ? await readEngineCapacity(engine.engine) : {};

let dir: string;
let name: string;

describe.skipIf(!engine.available)("a service container on a real engine", () => {
  beforeAll(async () => {
    if (!engine.available) return;
    const image = await ensureServiceImage(engine.engine);
    if (!image.ok) throw new Error(image.reason);
    dir = mkdtempSync(join(tmpdir(), "cc-service-engine-"));
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "probe.mjs"), PROBE);
    writeFileSync(join(dir, "pkg", "limits.mjs"), LIMITS_PROBE);
    prepareServiceDataDir(join(dir, "data"));
    name = serviceContainerName({ nodeId: "node_test", generationId: `probe-${String(Date.now())}`, facetId: "probe" });
  }, 600_000);

  afterAll(async () => {
    if (engine.available && name !== undefined) await removeServiceContainer(engine.engine, name);
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses the network and every write outside the private folder, and runs unprivileged", async () => {
    if (!engine.available) throw new Error("unreachable");
    const args = serviceRunArgs({
      engine: engine.engine,
      nodeId: "node_test",
      name,
      packageRoot: join(dir, "pkg"),
      dataDir: join(dir, "data"),
      entry: "probe.mjs",
      ...(engine.rootless === true ? { rootless: true } : {}),
    });
    const output = await new Promise<string>((settle, fail) => {
      // The node's own environment is not passed: a secret it holds must not be reachable from the container's.
      const child = execFile(
        engine.engine,
        args,
        { encoding: "utf8", timeout: 120_000, env: { ...process.env, CC_SECRET_PROBE_TOKEN: "must-not-leak" } },
        (error, stdout, stderr) => (error === null ? settle(stdout) : fail(new Error(`${error.message}\n${stderr}`))),
      );
      child.stdin?.end();
    });
    const tried = JSON.parse(output) as Record<string, unknown>;

    expect(tried.network).not.toBe("allowed");
    expect(tried.writePackage).toBe("EROFS");
    expect(tried.writeRoot).toBe("EROFS");
    // Podman's `--read-only` would mount writable tmpfs here, without the profile's size or `noexec`.
    expect(tried.writeRun).toBe("EROFS");
    expect(tried.writeVarTmp).toBe("EROFS");
    const tmpfs = tried.tmpfs as Record<string, string>;
    expect(tmpfs["/run"]).toBeUndefined();
    expect(tmpfs["/var/tmp"]).toBeUndefined();
    // The one scratch space is the profile's: its size, and nothing in it can be run.
    const scratch = (tmpfs["/tmp"] ?? "").split(",");
    expect(scratch).toContain("noexec");
    expect(scratch).toContain(`size=${String(RESOURCE_PROFILES["interactive-light"].container.tmpfsMib * 1024)}k`);
    expect(tried.writeData).toBe("allowed");
    expect(readFileSync(join(dir, "data", "kept.txt"), "utf8")).toBe("kept");
    // Rootless Docker runs the service as its id 0, the one id it maps back to the person; anywhere else it is not root.
    if (engine.rootless === true) expect(tried.uid).toBe(0);
    else expect(tried.uid).not.toBe(0);
    // On Linux the file it wrote is the person's own on the host, which is what makes the private folder theirs to read,
    // back up and delete. Docker Desktop and Podman machines map mount ownership themselves.
    // A node run as root hands the service an unprivileged id instead (`serviceUser`), so it is not checked then.
    if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() !== 0) {
      expect(statSync(join(dir, "data", "kept.txt")).uid).toBe(process.getuid());
    }
    expect(tried.env).toEqual([]);
  }, 180_000);

  /** Runs the limits probe under a profile; settles with the exit status rather than failing, so a kill can be read. */
  async function underProfile(profile: ResourceProfile, probeArgs: string[]): Promise<{ status: number | null; stdout: string }> {
    if (!engine.available) throw new Error("unreachable");
    const probeName = `${name}-${profile.name}-${String(probeArgs.length)}`;
    const args = serviceRunArgs({
      engine: engine.engine,
      nodeId: "node_test",
      name: probeName,
      packageRoot: join(dir, "pkg"),
      dataDir: join(dir, "data"),
      entry: "limits.mjs",
      profile,
      ...(engine.rootless === true ? { rootless: true } : {}),
    });
    try {
      return await new Promise((settle) => {
        const child = execFile(engine.engine, [...args, ...probeArgs], { encoding: "utf8", timeout: 120_000 }, (error, stdout) =>
          settle({ status: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout }),
        );
        child.stdin?.end();
      });
    } finally {
      await removeServiceContainer(engine.engine, probeName);
    }
  }

  // Only where the engine says it enforces limits: elsewhere (rootless without cgroup v2 delegation) the grant carries a
  // note instead, which `resource-profiles.spec.ts` covers, and there is nothing in the kernel to read.
  it.runIf(capacity.enforcesLimits === true)(
    "applies the granted profile's memory, CPU, process and scratch limits in the kernel",
    async () => {
      for (const profile of [RESOURCE_PROFILES["interactive-light"], RESOURCE_PROFILES["interactive-heavy"]]) {
        const answer = await underProfile(profile, []);
        expect(answer.status, answer.stdout).toBe(0);
        const applied = JSON.parse(answer.stdout) as { memory: string | null; cpu: string | null; pids: string | null; tmpBytes: number };
        const { memoryMib, cpus, pids, tmpfsMib } = profile.container;
        expect(applied.memory).toBe(String(memoryMib * 1024 * 1024));
        expect(applied.cpu).toBe(`${String(cpus * 100_000)} 100000`);
        expect(applied.pids).toBe(String(pids));
        expect(applied.tmpBytes).toBe(tmpfsMib * 1024 * 1024);
      }
    },
    240_000,
  );

  it.runIf(capacity.enforcesLimits === true)(
    "stops a service that holds more memory than its profile, and lets the larger profile hold it",
    async () => {
      const light = await underProfile(RESOURCE_PROFILES["interactive-light"], ["hold", "768"]);
      // The kernel's out-of-memory kill, which the engine reports as 128 + SIGKILL.
      expect(light.status).toBe(137);
      const heavy = await underProfile(RESOURCE_PROFILES["interactive-heavy"], ["hold", "768"]);
      expect(heavy.status).toBe(0);
      expect(JSON.parse(heavy.stdout)).toEqual({ held: 768 });
    },
    240_000,
  );

  it("runs the notes package's service: a note is added, listed, and kept in the private folder", async () => {
    if (!engine.available) throw new Error("unreachable");
    const dataDir = join(dir, "notes-data");
    prepareServiceDataDir(dataDir);
    const notesName = `${name}-notes`;
    const args = serviceRunArgs({
      engine: engine.engine,
      nodeId: "node_test",
      name: notesName,
      packageRoot: NOTES_PACKAGE,
      dataDir,
      entry: "service/server.mjs",
      ...(engine.rootless === true ? { rootless: true } : {}),
    });
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add_note", arguments: { text: "kept across the boundary" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_notes", arguments: {} } },
    ];
    try {
      const output = await new Promise<string>((settle, fail) => {
        const child = execFile(engine.engine, args, { encoding: "utf8", timeout: 120_000 }, (error, stdout, stderr) =>
          error === null ? settle(stdout) : fail(new Error(`${error.message}\n${stderr}`)),
        );
        // The server answers one line per request and exits when its input ends, so the whole exchange is written at once.
        child.stdin?.end(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
      });
      const answers = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: number; result?: { content?: { text: string }[]; isError?: boolean } });
      const added = answers.find((answer) => answer.id === 2)?.result;
      const listed = answers.find((answer) => answer.id === 3)?.result;
      expect(added?.isError).toBeUndefined();
      expect(listed?.content?.[0]?.text).toContain("kept across the boundary");
      expect(JSON.parse(readFileSync(join(dataDir, "notes.json"), "utf8"))).toEqual(["kept across the boundary"]);
      if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() !== 0) {
        expect(statSync(join(dataDir, "notes.json")).uid).toBe(process.getuid());
      }
    } finally {
      await removeServiceContainer(engine.engine, notesName);
    }
  }, 180_000);
});

/**
 * A job that set up rootless Docker for this suite says so, and then the suite must have found it rather than skipped:
 * a runner where the setup silently fell back to the rootful daemon would otherwise pass without checking anything new.
 */
describe.runIf(process.env.CC_EXPECT_ROOTLESS_DOCKER === "1")("the rootless Docker this job set up", () => {
  it("is the engine a service runs on", () => {
    expect(engine).toMatchObject({ available: true, engine: "docker", rootless: true });
  });
});

/**
 * The same for a job that set up rootless Podman: a Docker daemon still answering would otherwise be found first. It
 * must also enforce limits, read the way the limit tests above are gated, or those two would skip and the job stay green.
 */
describe.runIf(process.env.CC_EXPECT_ROOTLESS_PODMAN === "1")("the rootless Podman this job set up", () => {
  it("is the engine a service runs on, runs rootless, and enforces a profile's limits", async () => {
    expect(engine).toMatchObject({ available: true, engine: "podman" });
    const answer = await runEngine("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], 30_000);
    expect(answer.status, answer.stderr).toBe(0);
    expect(answer.stdout.trim()).toBe("true");
    expect(capacity).toMatchObject({ enforcesLimits: true });
  });
});

/**
 * The reference media render package's real service, run in a real container by a real host, started as a job the way
 * a widget press starts it. The clip reaches the service only through the host's reads over standard streams; the
 * container has no network, and what comes back is exactly the render of the clip that was picked.
 */
describe.skipIf(!engine.available)("the media render package's service on a real engine", () => {
  const PACKAGE = "com.clarkcant.reference.media-render";
  const GENERATION = `${PACKAGE}@1.0.0:code_1`;
  const RENDER = "com.clarkcant.reference.media-render.render@1" as CapabilityRef;
  const MEDIA = fileURLToPath(new URL("../../../examples/reference-apps/media-render/", import.meta.url));
  const NODE_ID = `node_media_${String(Date.now())}`;
  const PRINCIPAL = "prin_owner";
  const CONVERSATION = "conv_render";
  const INSTANCE = "winst_render";
  const BINDING = "binding_media_render";
  const NETWORK_PROBE = `fetch("http://1.1.1.1", { signal: AbortSignal.timeout(3000) }).then(
  () => process.stdout.write("allowed"),
  (error) => process.stdout.write("refused " + String(error.cause?.code ?? error.name)),
);`;

  it("renders a picked clip streamed into a container with no network, and refuses a file the widget holds no grant on", async () => {
    if (!engine.available) throw new Error("unreachable");
    const work = mkdtempSync(join(tmpdir(), "cc-service-media-"));
    const packageRoot = join(work, "media-render");
    cpSync(MEDIA, packageRoot, { recursive: true, filter: (source) => !source.includes(join(MEDIA, "test")) });
    const db = openDatabase({ path: ":memory:" });
    migrate(db);
    let counter = 0;
    const newId = (prefix: string): string => `${prefix}_${String(++counter)}`;
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO package_generations
         (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      GENERATION,
      PACKAGE,
      "1.0.0",
      "sha256:media-render-digest",
      NODE_ID,
      "code_1",
      at,
      JSON.stringify({ generationId: GENERATION, packageId: PACKAGE, version: "1.0.0", digest: "sha256:media-render-digest", nodeId: NODE_ID, codeGeneration: "code_1", activatedAt: at, uiOnlyFacets: [], grantedCapabilities: [] }),
    );
    // The widget a person presses is one this conversation holds, pinned there.
    createConversation(db, { conversationId: CONVERSATION, homeNodeId: NODE_ID, at: at as never });
    db.prepare(
      `INSERT INTO widget_instances
         (instance_id, definition_id, definition_version, package_digest, owner_node_id, owner_principal_id,
          revision, presentation_revision, data_revision, action_binding_revision, lifecycle, document, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(INSTANCE, "media.render@1", "1.0.0", "sha256:fixture", NODE_ID, PRINCIPAL, 1, 1, 1, 1, "active", "{}", at);
    createPin(db, { pinId: "pin_render", conversationId: CONVERSATION, instanceId: INSTANCE, displayMode: "expanded", position: 0, refreshPolicy: "manual", createdAt: at } as never);

    const broker: ArtifactBrokerDeps = { db, dataDir: work, nodeId: NODE_ID, newId, now: () => new Date() };
    const supervisor = createWorkSupervisor();
    const jobs = createPackageJobHost({ db, nodeId: NODE_ID, nodeBootId: "boot_1", newId, supervisor, artifactBroker: broker });
    const names: string[] = [];
    const logs: string[] = [];
    const host = createServiceHost({
      registry: { db, nodeId: NODE_ID },
      dataDir: work,
      engine: async () => engine,
      packageRoot: (generation) => (generation.packageId === PACKAGE ? packageRoot : undefined),
      launcher: (spec) => {
        names.push(spec.name);
        return containerLauncher(spec);
      },
      containers: engineContainers,
      log: (line) => logs.push(line),
    });
    const pick = (bytes: Uint8Array, instanceId: string) => {
      const stored = storePickedArtifact(broker, { principalId: PRINCIPAL, conversationId: CONVERSATION, instanceId, name: "clip.wav", mimeType: "audio/wav", bytes, accept: ["audio/wav"] });
      if (!stored.ok) throw new Error(stored.message);
      return stored.ref;
    };
    const press = (args: Record<string, unknown>) =>
      invokeCapability(
        { db, nodeId: NODE_ID, principalId: PRINCIPAL, newId, serviceHost: host, packageJobs: jobs, dataDir: work },
        { ref: RENDER, args, source: "widget", conversationId: CONVERSATION, bindingGeneration: GENERATION, jobOrigin: { instanceId: INSTANCE, actionBindingId: BINDING } },
      );
    const owner = { ownerPrincipalId: PRINCIPAL, instanceId: INSTANCE, actionBindingId: BINDING, packageGeneration: GENERATION };

    try {
      await host.reconcile();
      const started = Date.now();
      while (!host.status().some((entry) => entry.state === "running")) {
        if (Date.now() - started > 240_000) throw new Error(`the service did not start: ${logs.join(" | ")}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Larger than one 256 KiB chunk, so the service has to ask for it a range at a time.
      const clip = fixtureClip({ seconds: 24 });
      expect(clip.byteLength).toBeGreaterThan(262_144);
      const parameters = { gainDb: -6, trimStartMs: 250, trimEndMs: 250 };
      const outcome = await press({ source: pick(clip, INSTANCE).artifactId, ...parameters });
      if (outcome.kind !== "job") throw new Error(`expected a job, got ${JSON.stringify(outcome)}; log: ${logs.join(" | ")}`);
      const ended = await (async () => {
        const waited = Date.now();
        for (;;) {
          const job = jobs.get(outcome.job.jobId, owner);
          if (job !== undefined && job.status !== "running" && job.status !== "queued") return job;
          if (Date.now() - waited > 120_000) throw new Error(`the render did not end; log: ${logs.join(" | ")}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      })();
      expect(ended.status, JSON.stringify(ended)).toBe("completed");
      const result = ended.resultRefs[0];
      if (result === undefined) throw new Error("no result");

      // What the widget is given is exactly the render of the clip it picked, computed here from the transform alone.
      const header = parseWavHeader(clip.subarray(0, WAV_HEADER_BYTES), clip.byteLength);
      if (!header.ok) throw new Error(header.reason);
      const plan = renderPlan(header, parameters);
      if (!plan.ok) throw new Error(plan.reason);
      const expected = new Uint8Array(44 + plan.end - plan.start);
      expected.set(wavHeader(header.format, plan.end - plan.start), 0);
      expected.set(applyGain(clip.subarray(plan.start, plan.end), plan.gain), 44);
      const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
      expect(result.sizeBytes).toBe(expected.byteLength);
      expect(result.digest).toBe(`sha256:${digest(expected)}`);
      const kept = new Uint8Array(result.sizeBytes);
      for (let offset = 0; offset < result.sizeBytes; offset += 262_144) {
        const read = readArtifactRange(broker, { principalId: PRINCIPAL, instanceId: INSTANCE, artifactId: result.artifactId, offset, length: 262_144 });
        if (!read.ok) throw new Error(read.message);
        kept.set(read.bytes, offset);
      }
      expect(digest(kept)).toBe(digest(expected));

      // The container that rendered it has no network, as the engine records it and as a request from inside finds.
      const name = names.at(-1) ?? "";
      const engineSays = (args: string[]): Promise<string> =>
        new Promise((settle, fail) => {
          execFile(engine.engine, args, { encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) =>
            error === null ? settle(stdout.trim()) : fail(new Error(`${error.message}\n${stderr}`)),
          );
        });
      expect(await engineSays(["inspect", "--format", "{{.HostConfig.NetworkMode}}", name])).toBe("none");
      // What it wrote to its standard output, the rendered clip's bytes included, is in no log the engine keeps.
      expect(await engineSays(["inspect", "--format", "{{.HostConfig.LogConfig.Type}}", name])).toBe("none");
      // Asked for the refusal itself, so a probe that printed nothing cannot pass.
      expect(await engineSays(["exec", name, "node", "-e", NETWORK_PROBE])).toMatch(/^refused (ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EAI_AGAIN|TimeoutError)$/);

      // The clip was streamed, not handed over: no copy of it is in the service's private folder.
      const sample = Buffer.from(clip.subarray(WAV_HEADER_BYTES, WAV_HEADER_BYTES + 4096));
      const holding = (folder: string): string[] =>
        readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
          const file = join(folder, entry.name);
          if (entry.isDirectory()) return holding(file);
          return readFileSync(file).includes(sample) ? [file] : [];
        });
      expect(holding(join(work, "services"))).toEqual([]);

      // A file the pressing widget holds no grant on is refused before anything starts.
      const theirs = pick(fixtureClip({ seconds: 1 }), "winst_someone_else");
      expect(await press({ source: theirs.artifactId, gainDb: 0 })).toMatchObject({ kind: "refused", status: 403, code: "ARTIFACT_INPUT_REFUSED" });
    } finally {
      try {
        jobs.stopAll();
        await host.stopAll();
      } finally {
        db.close();
        rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }, 600_000);
});

/**
 * A service that reaches a provider, in a real container, through a real host: the key it is given is used on the
 * wire to the provider and is nowhere the service's own code could read it.
 *
 * What is searched, after the provider was called with the key: the environment and command line of the service's
 * process, everything it can write (`/data`, `/tmp`) and the package it runs, the engine's record of the container, the
 * service's stderr as the host keeps it, the host's log, and the service's private folder on this machine. The rest
 * of the container's filesystem is read-only, so nothing can have been written there.
 */
const SCAN = `
const fs = require("node:fs");
const path = require("node:path");
let needle = "";
process.stdin.on("data", (chunk) => (needle += chunk)).on("end", () => {
  const found = [];
  const has = (file) => fs.readFileSync(file).includes(needle);
  for (const file of ["/proc/1/environ", "/proc/1/cmdline"]) {
    try { if (has(file)) found.push(file); } catch (error) { found.push(file + " unreadable: " + error.code); }
  }
  const walk = (folder) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) { try { if (has(file)) found.push(file); } catch {} }
    }
  };
  for (const root of ["/data", "/tmp", "/pkg"]) walk(root);
  process.stdout.write(JSON.stringify(found));
});
`;

describe.skipIf(!engine.available)("a service's provider key on a real engine", () => {
  const LOOKUP = "com.example.lookup";
  const LOOKUP_FIXTURE = fileURLToPath(new URL("../../web/e2e/fixtures/egress-service/", import.meta.url));
  const NODE_ID = `node_egress_${String(Date.now())}`;

  it("is sent to the provider and is in none of the container's environment, files or output", async () => {
    if (!engine.available) throw new Error("unreachable");
    const work = mkdtempSync(join(tmpdir(), "cc-service-egress-"));
    const db = openDatabase({ path: ":memory:" });
    migrate(db);
    // Generated here, so nothing in this file could be mistaken for a real key.
    const secret = `fake-${randomBytes(16).toString("hex")}`;
    const seen: string[] = [];
    const provider = createServer((request, response) => {
      seen.push(String(request.headers.authorization ?? ""));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ definition: "a sphere", youSent: request.headers.authorization ?? null }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const port = (provider.address() as AddressInfo).port;

    const packageRoot = join(work, "lookup");
    cpSync(LOOKUP_FIXTURE, packageRoot, { recursive: true });
    const manifestPath = join(packageRoot, "clarkcant.json");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("http://127.0.0.1:8879", `http://127.0.0.1:${String(port)}`));
    const generationId = `${LOOKUP}@1.0.0:code_1`;
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO package_generations
         (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      generationId,
      LOOKUP,
      "1.0.0",
      "sha256:lookup-digest",
      NODE_ID,
      "code_1",
      at,
      JSON.stringify({ generationId, packageId: LOOKUP, version: "1.0.0", digest: "sha256:lookup-digest", nodeId: NODE_ID, codeGeneration: "code_1", activatedAt: at, uiOnlyFacets: [], grantedCapabilities: [] }),
    );
    const stored = storeCredentialFields(
      { db, ownerPrincipalId: "owner_1", nodeId: NODE_ID, newId: (prefix) => `${prefix}_${randomBytes(4).toString("hex")}` },
      [{ name: "LOOKUP_API_KEY", value: secret, kind: "token", consumer: `package:${LOOKUP}` }],
    );
    expect(stored.ok).toBe(true);

    const names: string[] = [];
    const logs: string[] = [];
    let connection: StdioMcpTransport | undefined;
    const dataDir = join(work, "node-data");
    const host = createServiceHost({
      registry: { db, nodeId: NODE_ID },
      dataDir,
      engine: async () => engine,
      packageRoot: (generation) => (generation.packageId === LOOKUP ? packageRoot : undefined),
      launcher: (spec) => {
        names.push(spec.name);
        return containerLauncher(spec);
      },
      connect: async (options) => {
        const transport = new StdioMcpTransport(options);
        await transport.start();
        connection = transport;
        return transport;
      },
      containers: engineContainers,
      log: (line) => logs.push(line),
      egress: {
        secrets: createSecretBroker({ db, principalId: "owner_1", now: () => new Date().toISOString() as Instant }),
        secretProblem: (packageId, name) => egressSecretProblem({ db, principalId: "owner_1" }, packageId, name),
        // The fake provider is on loopback, which a node reaches for services only when it is started saying so.
        allowPrivateNetwork: true,
      },
    });
    try {
      await host.reconcile();
      const started = Date.now();
      while (!host.status().some((entry) => entry.state === "running")) {
        if (Date.now() - started > 240_000) throw new Error(`the service did not start: ${logs.join(" | ")}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const result = await host.call("com.example.lookup.define@1" as CapabilityRef, { word: "orb" });

      // Used where it belongs: on the wire to the provider.
      expect(seen).toEqual([`Bearer ${secret}`]);
      expect(result.content).toBe('Provider answer: {"definition":"a sphere","youSent":"[redacted]"}');

      const name = names.at(-1) ?? "";
      const scanFor = (needle: string): Promise<string[]> =>
        new Promise((settle, fail) => {
          // The needle reaches the scan on its standard input, so not even the scan's own command line holds it.
          const child = execFile(engine.engine, ["exec", "-i", name, "node", "-e", SCAN], { encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) =>
            error === null ? settle(JSON.parse(stdout) as string[]) : fail(new Error(`${error.message}\n${stderr}`)),
          );
          child.stdin?.end(needle);
        });
      // The scan finds what is there: the service's own environment, and the secret's name in the package's manifest.
      expect(await scanFor("NODE_ENV=production")).toEqual(["/proc/1/environ"]);
      expect(await scanFor("LOOKUP_API_KEY")).toEqual(["/pkg/clarkcant.json"]);
      expect(await scanFor(secret)).toEqual([]);
      const inspected = await new Promise<string>((settle, fail) => {
        execFile(engine.engine, ["inspect", "--format", "{{json .Config}}", name], { encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) =>
          error === null ? settle(stdout) : fail(new Error(`${error.message}\n${stderr}`)),
        );
      });
      expect(inspected).not.toContain(secret);
      expect(inspected).not.toContain("LOOKUP_API_KEY");
      expect(connection?.stderrTail ?? "").not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
      const onDisk = (folder: string): string[] =>
        readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
          const file = join(folder, entry.name);
          if (entry.isDirectory()) return onDisk(file);
          return readFileSync(file).includes(secret) ? [file] : [];
        });
      expect(onDisk(dataDir)).toEqual([]);
    } finally {
      await host.stopAll();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      db.close();
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 600_000);
});
