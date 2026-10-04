import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { directoryEntrySchema, type DirectoryEntry } from "@clarkcant/contracts";
import { inspectNpmTarball } from "@clarkcant/core";
import { startFakeNpmRegistry } from "@clarkcant/core/test-support/fake-npm-registry";

import { runCli } from "../../../packages/widget-cli/src/cli.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The reference apps as the npm packages they are published as, installed the way a node installs any npm package.
 *
 * Each app is copied out of the repository, packed and prepared with the author's own CLI (`clark widget publish`),
 * and the archive the CLI wrote is served by a local server answering like npm's. The node then installs it through
 * the canonical `/packages/install` route from a directory entry the CLI prepared, so what passes is the archive an
 * author would `npm publish` agreeing with the digest a node computes. The copy matters: pack refuses to repack a
 * version whose bytes changed, and the repository's own tree must never hold a packed artifact.
 */

const AT = "2026-10-05T05:00:00.000Z";
const REFERENCE_APPS = fileURLToPath(new URL("../../../examples/reference-apps/", import.meta.url));

interface ReferencePackage {
  dir: string;
  npmName: string;
  packageId: string;
  publisherId: string;
  /** Files beyond the common ones the archive must ship, such as a translated README. */
  extraFiles: readonly string[];
  /** Why the packed LICENSE text cannot be checked against the declared licence yet, when it cannot. */
  licencePending?: string;
}

/*
 * Media Converter installs here too: installing a package with a service facet registers the service but starts no
 * container, so the install itself needs no container engine. Running a render does, and that is the browser journey's.
 */
const PACKAGES: readonly ReferencePackage[] = [
  {
    dir: "text-editor",
    npmName: "@clarkcant/quick-notes",
    packageId: "com.clarkcant.reference.text-editor",
    publisherId: "clarkcant",
    extraFiles: [],
  },
  {
    dir: "spreadsheet",
    npmName: "@clarkcant/csv-explorer",
    packageId: "com.example.spreadsheet",
    publisherId: "example",
    extraFiles: ["README.vi.md"],
    licencePending:
      "its LICENSE file is MIT while package.json and clarkcant.json declare Apache-2.0; the maintainer decides which licence applies",
  },
  {
    dir: "media-render",
    npmName: "@clarkcant/media-converter",
    packageId: "com.clarkcant.reference.media-render",
    publisherId: "clarkcant",
    extraFiles: ["README.vi.md"],
  },
];

/** The heading every copy of the licence's standard text opens with, keyed by SPDX id. */
const LICENCE_TEXT_HEADING: Readonly<Record<string, RegExp>> = {
  "Apache-2.0": /^\s*Apache License\s+Version 2\.0,/,
  MIT: /^\s*MIT License\s/,
};

interface Authored {
  entry: DirectoryEntry;
  tarball: Buffer;
  tarballName: string;
}

let authorRoot: string;
const authored = new Map<string, Authored>();

/** Pack and prepare a copy of the reference app with the CLI, exactly as its author would. */
async function author(reference: ReferencePackage): Promise<Authored> {
  const root = join(authorRoot, reference.dir);
  cpSync(join(REFERENCE_APPS, reference.dir), root, {
    recursive: true,
    filter: (source) => !/[\\/](dist|node_modules)([\\/]|$)/.test(source.slice(REFERENCE_APPS.length)),
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  let code: number;
  let stderr: string;
  try {
    code = await runCli(["widget", "publish", root]);
  } finally {
    // Restored before anything can fail, so a failure's own output is not swallowed by the mocks.
    stderr = err.mock.calls.map((call) => String(call[0])).join("");
    vi.restoreAllMocks();
  }
  expect(code, stderr).toBe(0);
  const entry = directoryEntrySchema.parse(JSON.parse(readFileSync(join(root, "dist", "directory-entry.json"), "utf8")));
  const artifact = JSON.parse(readFileSync(join(root, "dist", "artifact.json"), "utf8")) as { npm: { tarball: string } };
  return { entry, tarball: readFileSync(join(root, "dist", artifact.npm.tarball)), tarballName: artifact.npm.tarball };
}

/** The same archive with one shipped file's bytes changed: still a valid archive, no longer the package listed. */
function tampered(tarball: Buffer): Buffer {
  // Changes the first `</html>` in the uncompressed tar, in whichever shipped HTML file holds it first (every reference
  // app ships at least widgets/main/index.html). The change keeps the file's length, so the archive stays valid.
  const change = { from: "</html>", to: "</HTML>" };
  const tar = gunzipSync(tarball);
  const at = tar.indexOf(change.from);
  expect(at, `the archive holds ${change.from}`).toBeGreaterThan(-1);
  const copy = Buffer.from(tar);
  copy.write(change.to, at, "utf8");
  return gzipSync(copy);
}

beforeAll(async () => {
  authorRoot = mkdtempSync(join(tmpdir(), "clarkcant-reference-npm-author-"));
  for (const reference of PACKAGES) authored.set(reference.dir, await author(reference));
}, 120_000);

afterAll(() => {
  rmSync(authorRoot, { recursive: true, force: true });
});

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
const restoreEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string): void {
  if (!(name in restoreEnv)) restoreEnv[name] = process.env[name];
  process.env[name] = value;
}

function listOnly(entry: DirectoryEntry, registryUrl: string): void {
  const indexPath = join(dir, "directory.json");
  writeFileSync(indexPath, JSON.stringify([entry]));
  setEnv("CC_DIRECTORY_INDEX", indexPath);
  setEnv("CC_NPM_REGISTRY_URL", registryUrl);
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

/** The package ids `GET /packages` reports as installed on the node. */
async function installedPackageIds(): Promise<string[]> {
  const response = await handleRequest(deps, {
    method: "GET",
    path: "/packages",
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: "",
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const packages = (response.body as { packages: { packageId: string }[] }).packages;
  return packages.map((installed) => installed.packageId);
}

function authoredFor(reference: ReferencePackage): Authored {
  const found = authored.get(reference.dir);
  if (found === undefined) throw new Error(`${reference.dir} was not authored`);
  return found;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-reference-npm-install-"));
  services = bootNodeServices({ dataDir: join(dir, "node"), label: "reference npm install test node" });
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

describe.each(PACKAGES)("the $npmName reference package", (reference) => {
  it("packs to its own npm identity with only its runtime files", () => {
    const { entry, tarball, tarballName } = authoredFor(reference);
    expect(entry.packageId).toBe(reference.packageId);
    expect(entry.source).toEqual({ kind: "npm", name: reference.npmName, version: entry.version });
    expect(tarballName).toBe(`${reference.npmName.slice(1).replace("/", "-")}-${entry.version}.tgz`);
    expect(entry.publisher).toEqual({
      id: reference.publisherId,
      sourceUrl: `https://github.com/digitopvn/clarkcant/tree/main/examples/reference-apps/${reference.dir}`,
      license: "Apache-2.0",
    });

    let packedPackageJson: Record<string, unknown> = {};
    const inspected = inspectNpmTarball(tarball, join(dir, "inspect"), (root) => {
      packedPackageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
    });
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    const paths = inspected.facts.files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining(["clarkcant.json", "package.json", "LICENSE", "README.md", "widgets/main/index.html", ...reference.extraFiles]),
    );
    // Tests, dev fixtures and packed artifacts describe this repository's checks, not the package a person installs.
    expect(paths.filter((path) => /^(test|dev|dist)\//.test(path) || path === "fixtures/dev-host-services.json")).toEqual([]);
    expect(inspected.facts.contentDigest).toBe(entry.digest);
    // npm restricts a scoped package by default; `npm publish <tarball>` reads the access from the archive.
    expect(packedPackageJson["publishConfig"]).toEqual({ access: "public" });
  });

  if (reference.licencePending === undefined) {
    it("ships a LICENSE whose text is the licence it declares", () => {
      const { entry, tarball } = authoredFor(reference);
      let licence = "";
      const inspected = inspectNpmTarball(tarball, join(dir, "inspect"), (root) => {
        licence = readFileSync(join(root, "LICENSE"), "utf8");
      });
      expect(inspected.ok).toBe(true);
      const heading = LICENCE_TEXT_HEADING[entry.publisher.license];
      expect(heading, `a known licence heading for ${entry.publisher.license}`).toBeDefined();
      expect(licence).toMatch(heading as RegExp);
    });
  } else {
    // Not a passing test: the archive would ship a licence text that contradicts its metadata until this is decided.
    it.todo(`ships a LICENSE whose text is the licence it declares (pending: ${reference.licencePending})`);
  }

  it("installs the exact published version through the canonical route", async () => {
    const { entry, tarball } = authoredFor(reference);
    const registry = await startFakeNpmRegistry({ name: reference.npmName, version: entry.version, tarball });
    try {
      listOnly(entry, registry.url);

      const response = await install(entry);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const body = response.body as Record<string, unknown>;
      expect((body["installed"] as Record<string, unknown>)["packageId"]).toBe(reference.packageId);
      expect(body["state"]).toBe("active");
      // The listing the refusal cases rely on does report an installed package.
      expect(await installedPackageIds()).toContain(reference.packageId);
    } finally {
      await registry.close();
    }
  });

  it("refuses a tampered archive the registry serves under the same version, and installs nothing", async () => {
    const { entry, tarball } = authoredFor(reference);
    // The registry vouches for the tampered bytes (their integrity is computed fresh), so only the entry's digest,
    // which the author's CLI computed from the real archive, can tell them apart.
    const registry = await startFakeNpmRegistry({ name: reference.npmName, version: entry.version, tarball: tampered(tarball) });
    try {
      listOnly(entry, registry.url);

      const response = await install(entry);

      expect(response.status).toBe(409);
      expect((response.body as Record<string, unknown>)["code"]).toBe("DIGEST_MISMATCH");
      expect(JSON.stringify(response.body)).not.toContain("generationId");
      expect(await installedPackageIds()).not.toContain(reference.packageId);
    } finally {
      await registry.close();
    }
  });

  it("refuses the archive when the registry's integrity does not match its bytes", async () => {
    const { entry, tarball } = authoredFor(reference);
    const registry = await startFakeNpmRegistry({ name: reference.npmName, version: entry.version, tarball, wrongIntegrity: true });
    try {
      listOnly(entry, registry.url);

      const response = await install(entry);

      expect(response.status).toBe(400);
      expect((response.body as Record<string, unknown>)["code"]).toBe("NPM_INTEGRITY_MISMATCH");
      expect(JSON.stringify(response.body)).not.toContain("generationId");
      expect(await installedPackageIds()).not.toContain(reference.packageId);
    } finally {
      await registry.close();
    }
  });
});
