import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  detectServiceEngine,
  ensureServiceImage,
  prepareServiceDataDir,
  removeServiceContainer,
  serviceContainerName,
  serviceRunArgs,
} from "../src/service-container.ts";

/**
 * The container boundary, checked from inside a real container.
 *
 * `service-container.spec.ts` reads the command line; this runs it. A probe in place of a service tries each thing the
 * boundary exists to refuse and reports what happened, so a flag an engine ignores is caught here rather than trusted.
 *
 * Needs an engine that runs Linux containers. The Linux CI runners have Docker; a machine without one (the macOS
 * runner, Windows in Windows-containers mode) has nothing this can check, and the suite says so by skipping.
 */

const engine = await detectServiceEngine({ timeoutMs: 10_000 });

const NOTES_PACKAGE = fileURLToPath(new URL("../../web/e2e/fixtures/notes-service/", import.meta.url));

const PROBE = `
import { writeFileSync } from "node:fs";
const tried = {};
async function attempt(name, work) {
  try { await work(); tried[name] = "allowed"; } catch (error) { tried[name] = error.code ?? error.cause?.code ?? error.name; }
}
await attempt("network", () => fetch("http://1.1.1.1", { signal: AbortSignal.timeout(3000) }));
await attempt("writePackage", () => writeFileSync("/pkg/escaped.txt", "x"));
await attempt("writeRoot", () => writeFileSync("/etc/escaped.txt", "x"));
await attempt("writeData", () => writeFileSync("/data/kept.txt", "kept"));
tried.uid = process.getuid();
tried.env = Object.keys(process.env).filter((key) => key.startsWith("CC_") || key.includes("KEY") || key.includes("TOKEN"));
process.stdout.write(JSON.stringify(tried));
`;

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
