import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { directoryEntrySchema, type DirectoryEntry } from "@clarkcant/contracts";
import { startFakeNpmRegistry } from "@clarkcant/core/test-support/fake-npm-registry";

import { runCli } from "../../../packages/widget-cli/src/cli.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The author flow and the install route, end to end, with nothing between them but an npm registry.
 *
 * `clark widget init` → `pack` → `publish` produce the archive and the directory entry. A local server answering like
 * npm's serves that exact archive, and the entry is listed in this node's directory. The install then goes through
 * the route the marketplace reaches — fetch, integrity check, extract, digest check — so what passes here is the
 * digest an author's machine wrote agreeing with the digest a node computes, not either compared with itself.
 */

const AT = "2026-10-05T05:00:00.000Z";

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
const restoreEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string): void {
  if (!(name in restoreEnv)) restoreEnv[name] = process.env[name];
  process.env[name] = value;
}

/** Author a package through the CLI, exactly as an author outside this repository would. */
async function authorPackage(): Promise<{ entry: DirectoryEntry; tarball: Buffer }> {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const root = join(dir, "author", "quick-notes");
  expect(await runCli(["widget", "init", root])).toBe(0);
  expect(await runCli(["widget", "publish", root])).toBe(0);
  vi.restoreAllMocks();
  const entry = directoryEntrySchema.parse(JSON.parse(readFileSync(join(root, "dist", "directory-entry.json"), "utf8")));
  const artifact = JSON.parse(readFileSync(join(root, "dist", "artifact.json"), "utf8")) as { npm: { tarball: string } };
  return { entry, tarball: readFileSync(join(root, "dist", artifact.npm.tarball)) };
}

async function install(entry: DirectoryEntry): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method: "POST",
    path: "/packages/install",
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: JSON.stringify({ packageId: entry.packageId, version: entry.version }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-npm-install-"));
  services = bootNodeServices({ dataDir: join(dir, "node"), label: "npm archive install test node" });
  deps = { services, now: () => AT as never };
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(restoreEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete restoreEnv[name];
  }
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("installing an archive the CLI packed, from an npm registry", () => {
  it("installs the published version through the canonical route", async () => {
    const { entry, tarball } = await authorPackage();
    expect(entry.source).toEqual({ kind: "npm", name: "quick-notes", version: entry.version });
    const registry = await startFakeNpmRegistry({ name: "quick-notes", version: entry.version, tarball });
    try {
      const indexPath = join(dir, "directory.json");
      writeFileSync(indexPath, JSON.stringify([entry]));
      setEnv("CC_DIRECTORY_INDEX", indexPath);
      setEnv("CC_NPM_REGISTRY_URL", registry.url);

      const response = await install(entry);

      expect(response.status).toBe(200);
      const body = response.body as Record<string, unknown>;
      expect((body["installed"] as Record<string, unknown>)["packageId"]).toBe(entry.packageId);
      expect(body["state"]).toBe("active");
    } finally {
      await registry.close();
    }
  });

  it("refuses an entry whose digest is not the archive's, and installs nothing", async () => {
    const { entry, tarball } = await authorPackage();
    const registry = await startFakeNpmRegistry({ name: "quick-notes", version: entry.version, tarball });
    try {
      // The author digest names the same version, but it is not what a node computes from the npm archive: an entry
      // carrying it must not install, or "verified" would mean nothing.
      const artifact = JSON.parse(readFileSync(join(dir, "author", "quick-notes", "dist", "artifact.json"), "utf8")) as {
        authorDigest: string;
      };
      const wrong = { ...entry, digest: artifact.authorDigest };
      const indexPath = join(dir, "directory.json");
      writeFileSync(indexPath, JSON.stringify([wrong]));
      setEnv("CC_DIRECTORY_INDEX", indexPath);
      setEnv("CC_NPM_REGISTRY_URL", registry.url);

      const response = await install(wrong);

      expect(response.status).toBe(409);
      expect((response.body as Record<string, unknown>)["code"]).toBe("DIGEST_MISMATCH");
      expect(JSON.stringify(response.body)).not.toContain("generationId");
    } finally {
      await registry.close();
    }
  });

  it("refuses an archive whose bytes are not the ones the registry vouches for", async () => {
    const { entry, tarball } = await authorPackage();
    const registry = await startFakeNpmRegistry({ name: "quick-notes", version: entry.version, tarball, wrongIntegrity: true });
    try {
      const indexPath = join(dir, "directory.json");
      writeFileSync(indexPath, JSON.stringify([entry]));
      setEnv("CC_DIRECTORY_INDEX", indexPath);
      setEnv("CC_NPM_REGISTRY_URL", registry.url);

      const response = await install(entry);

      expect(response.status).toBe(400);
      expect((response.body as Record<string, unknown>)["code"]).toBe("NPM_INTEGRITY_MISMATCH");
      expect(JSON.stringify(response.body)).not.toContain("generationId");
    } finally {
      await registry.close();
    }
  });
});
