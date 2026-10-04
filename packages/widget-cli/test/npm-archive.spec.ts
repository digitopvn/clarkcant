import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { directoryEntrySchema } from "@clarkcant/contracts";
import { digestOfDirectory, fetchNpmArtifact, inspectNpmTarball } from "@clarkcant/core";
import { buildNpmTarballFromFiles, startFakeNpmRegistry } from "@clarkcant/core/test-support/fake-npm-registry";

import { runCli } from "../src/cli.ts";
import { credentialShaped } from "../src/npm-package.ts";

/**
 * The npm archive `clark widget pack` builds, held to the one contract that matters: a node that fetches the
 * published version from a registry computes the very digest the prepared directory entry names, with the registry's
 * integrity and the runtime's digest checks both on.
 *
 * The archive is a real `pnpm pack` and the registry is a local HTTP server answering like npm's, so what is proven is
 * the author flow and the runtime fetch agreeing — not a digest compared with itself.
 */

const created: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function quiet(): { err: () => string; out: () => string } {
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return {
    err: () => err.mock.calls.map((call) => String(call[0])).join(""),
    out: () => out.mock.calls.map((call) => String(call[0])).join(""),
  };
}

async function scaffold(template = "blank"): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "clark-npm-"));
  created.push(parent);
  const root = join(parent, "quick-notes");
  expect(await runCli(["widget", "init", root, "--template", template])).toBe(0);
  return root;
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

function editJson(path: string, edit: (value: Record<string, unknown>) => void): void {
  const value = readJson(path);
  edit(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

interface Artifact {
  schemaVersion: number;
  authorDigest: string;
  npm: { name: string; version: string; tarball: string; integrity: string; contentDigest: string; fileCount: number };
}

describe("clark widget init scaffolds an npm package", () => {
  it("writes a package.json whose identity, version, keywords and file list pack checks", async () => {
    quiet();
    const root = await scaffold();
    const pkg = readJson(join(root, "package.json"));
    expect(pkg["name"]).toBe("quick-notes");
    expect(pkg["version"]).toBe(readJson(join(root, "clarkcant.json"))["version"]);
    expect(pkg["keywords"]).toEqual(["clarkcant", "clarkcant-widget"]);
    expect(pkg["files"]).toEqual(["clarkcant.json", "widgets/", "fixtures/", "previews/"]);
    expect(pkg).not.toHaveProperty("dependencies");
  });

  it("gives a reference copy a package.json naming its own runtime files, not its tests", async () => {
    quiet();
    const root = await scaffold("pure-ui");
    const pkg = readJson(join(root, "package.json"));
    expect(pkg["files"]).toContain("clarkcant.json");
    expect(pkg["files"]).toContain("widgets/");
    expect(pkg["files"]).not.toContain("test/");
    expect(await runCli(["widget", "pack", root])).toBe(0);
  });
});

describe("clark widget pack builds the npm archive", () => {
  it("records three distinct digests, each the one its checker computes", async () => {
    quiet();
    const root = await scaffold();
    expect(await runCli(["widget", "pack", root])).toBe(0);

    const artifact = readJson(join(root, "dist", "artifact.json")) as unknown as Artifact;
    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.npm.tarball).toBe("quick-notes-0.1.0.tgz");
    const bytes = readFileSync(join(root, "dist", artifact.npm.tarball));

    const inspected = inspectNpmTarball(bytes, join(root, "..", "scratch"));
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(artifact.npm.integrity).toBe(inspected.facts.integrity);
    expect(artifact.npm.contentDigest).toBe(inspected.facts.contentDigest);
    expect(artifact.npm.fileCount).toBe(inspected.facts.files.length);
    // The archive holds the runtime assets and the package's own metadata, and nothing from dist or tests.
    expect(inspected.facts.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["clarkcant.json", "package.json", "widgets/main/index.html", "widgets/main/widget.json", "fixtures/default.json"]),
    );
    expect(inspected.facts.files.some((file) => file.path.startsWith("dist/") || file.path.startsWith("test/"))).toBe(false);

    // Three answers to three questions, so none can stand in for another.
    expect(new Set([artifact.authorDigest, artifact.npm.contentDigest, artifact.npm.integrity]).size).toBe(3);
  });

  it("is reproducible: packing the same files again writes the same archive bytes", async () => {
    quiet();
    const root = await scaffold();
    expect(await runCli(["widget", "pack", root])).toBe(0);
    const first = readJson(join(root, "dist", "artifact.json")) as unknown as Artifact;
    expect(await runCli(["widget", "pack", root])).toBe(0);
    const second = readJson(join(root, "dist", "artifact.json")) as unknown as Artifact;
    expect(second.npm.integrity).toBe(first.npm.integrity);
  });

  it("refuses to repack a version whose archived contents changed", async () => {
    const io = quiet();
    const root = await scaffold();
    expect(await runCli(["widget", "pack", root])).toBe(0);
    writeFileSync(join(root, "fixtures", "default.json"), `${JSON.stringify({ title: "Đổi rồi" }, null, 2)}\n`);
    expect(await runCli(["widget", "pack", root])).toBe(1);
    expect(io.err()).toContain("bump the version");
  });

  it.each([
    ["a version that disagrees with clarkcant.json", (pkg: Record<string, unknown>) => (pkg["version"] = "9.9.9"), "set both to the same version"],
    ["a missing discovery keyword", (pkg: Record<string, unknown>) => (pkg["keywords"] = ["widget"]), '"clarkcant", "clarkcant-widget"'],
    ["no explicit files list", (pkg: Record<string, unknown>) => delete pkg["files"], 'explicit "files" list'],
    ["a runtime dependency", (pkg: Record<string, unknown>) => (pkg["dependencies"] = { lodash: "4.17.21" }), '"dependencies"'],
    ["an install script", (pkg: Record<string, unknown>) => (pkg["scripts"] = { postinstall: "node x.js" }), '"postinstall"'],
    ["a script that runs while packing", (pkg: Record<string, unknown>) => (pkg["scripts"] = { prepack: "node gen.js" }), '"prepack"'],
    ["an invalid npm name", (pkg: Record<string, unknown>) => (pkg["name"] = "Quick Notes"), "valid npm package name"],
  ])("refuses %s, and says what to change", async (_label, edit, message) => {
    const io = quiet();
    const root = await scaffold();
    editJson(join(root, "package.json"), edit);
    expect(await runCli(["widget", "pack", root])).toBe(1);
    expect(io.err()).toContain(message);
    expect(existsSync(join(root, "dist", "artifact.json"))).toBe(false);
  });

  it("refuses an archive that would publish a credential-shaped file, even one the file list names", async () => {
    const io = quiet();
    const root = await scaffold();
    writeFileSync(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=not-a-real-token\n");
    editJson(join(root, "package.json"), (pkg) => {
      pkg["files"] = [...(pkg["files"] as string[]), ".npmrc"];
    });
    expect(await runCli(["widget", "pack", root])).toBe(1);
    expect(io.err()).toContain(".npmrc");
    expect(existsSync(join(root, "dist", "artifact.json"))).toBe(false);
  });

  it("names every credential-shaped path it refuses, not only the common ones", () => {
    for (const path of [".npmrc", ".env", ".env.local", ".envrc", ".env-local", ".git-credentials", ".pypirc", ".dev.vars",
      "keys/id_ecdsa", "keys/id_dsa.pub", "id_ed25519", "certs/server.pem", "node_modules/x/index.js", ".git/config"]) {
      expect(credentialShaped(path), path).toBe(true);
    }
    for (const path of ["clarkcant.json", "widgets/main/index.html", "fixtures/environment.json", "previews/id_card.png"]) {
      expect(credentialShaped(path), path).toBe(false);
    }
  });

  it("repacks over a schemaVersion 1 artifact, reading its digest as the author digest", async () => {
    const io = quiet();
    const root = await scaffold();
    expect(await runCli(["widget", "pack", root])).toBe(0);
    const current = readJson(join(root, "dist", "artifact.json")) as unknown as Artifact;
    // What pack wrote before this artifact had an npm block: the same version under the old field name.
    const v1 = { schemaVersion: 1, id: "x", version: "0.1.0", digest: current.authorDigest, files: [] };
    writeFileSync(join(root, "dist", "artifact.json"), JSON.stringify(v1));
    expect(await runCli(["widget", "pack", root])).toBe(0);
    writeFileSync(join(root, "dist", "artifact.json"), JSON.stringify({ ...v1, digest: "sha256:0" }));
    expect(await runCli(["widget", "pack", root])).toBe(1);
    expect(io.err()).toContain("bump the version");
  });

  it("refuses an archive that leaves out a file the package needs, by running the suite on the archive itself", async () => {
    const io = quiet();
    const root = await scaffold();
    editJson(join(root, "package.json"), (pkg) => {
      pkg["files"] = ["clarkcant.json", "widgets/"];
    });
    expect(await runCli(["widget", "pack", root])).toBe(1);
    expect(io.err()).toContain("does not pass the conformance suite on its own");
  });

  it("keeps the local workflow for a package without package.json", async () => {
    quiet();
    const root = await scaffold();
    rmSync(join(root, "package.json"));
    expect(await runCli(["widget", "publish", root])).toBe(0);
    const artifact = readJson(join(root, "dist", "artifact.json"));
    expect(artifact).not.toHaveProperty("npm");
    const entry = readJson(join(root, "dist", "directory-entry.json"));
    expect(entry["source"]).toEqual({ kind: "local", path: root });
    expect(entry["digest"]).toBe(artifact["authorDigest"]);
  });
});

describe("the prepared npm entry installs through the runtime's npm fetch", () => {
  it("names the exact npm version and the digest a fetch of the published archive computes", async () => {
    const io = quiet();
    const root = await scaffold();
    expect(await runCli(["widget", "publish", root])).toBe(0);

    const entry = directoryEntrySchema.parse(readJson(join(root, "dist", "directory-entry.json")));
    expect(entry.source).toEqual({ kind: "npm", name: "quick-notes", version: "0.1.0" });
    // Three outcomes, said separately: prepared is not published, and published is not listed.
    expect(io.out()).toContain("prepared:               yes");
    expect(io.out()).toContain("published to npm:       no");
    expect(io.out()).toContain("Marketplace submission: no");

    const artifact = readJson(join(root, "dist", "artifact.json")) as unknown as Artifact;
    const tarball = readFileSync(join(root, "dist", artifact.npm.tarball));
    const registry = await startFakeNpmRegistry({ name: "quick-notes", version: "0.1.0", tarball });
    try {
      const fetched = await fetchNpmArtifact({
        name: "quick-notes",
        version: "0.1.0",
        cacheRoot: join(root, "..", "node-cache"),
        registryUrl: registry.url,
        expectedDigest: entry.digest,
      });
      expect(fetched.ok).toBe(true);
      if (!fetched.ok) return;
      expect(fetched.artifact.digest).toBe(entry.digest);
      // The digest is over what landed on disk, so recomputing it there agrees.
      expect(digestOfDirectory(fetched.artifact.path)).toEqual({ ok: true, digest: entry.digest });
    } finally {
      await registry.close();
    }
  });

  it("refuses a tampered archive served under the published version, before it becomes installable", async () => {
    quiet();
    const root = await scaffold();
    expect(await runCli(["widget", "publish", root])).toBe(0);
    const entry = directoryEntrySchema.parse(readJson(join(root, "dist", "directory-entry.json")));

    // Different bytes under the published name and version, with a registry integrity that vouches for them: only
    // the digest the directory entry published can tell them apart.
    const tampered = buildNpmTarballFromFiles({
      "clarkcant.json": readFileSync(join(root, "clarkcant.json"), "utf8"),
      "package.json": readFileSync(join(root, "package.json"), "utf8"),
      "widgets/main/index.html": `${readFileSync(join(root, "widgets", "main", "index.html"), "utf8")}<script>steal()</script>`,
    });
    const registry = await startFakeNpmRegistry({ name: "quick-notes", version: "0.1.0", tarball: tampered });
    const cacheRoot = join(root, "..", "node-cache");
    try {
      const fetched = await fetchNpmArtifact({ name: "quick-notes", version: "0.1.0", cacheRoot, registryUrl: registry.url, expectedDigest: entry.digest });
      expect(fetched).toMatchObject({ ok: false, code: "ARTIFACT_DIGEST_MISMATCH" });
      expect(existsSync(join(cacheRoot, "npm", "quick-notes-0.1.0"))).toBe(false);
    } finally {
      await registry.close();
    }
  });
});
