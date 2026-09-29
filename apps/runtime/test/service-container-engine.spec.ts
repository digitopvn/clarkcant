import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(tried.uid).not.toBe(0);
    expect(tried.env).toEqual([]);
  }, 180_000);
});
