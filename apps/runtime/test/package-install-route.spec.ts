import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { platformForHost, DEFAULT_EXECUTION_POLICY_CONFIG, directoryEntrySchema } from "@clarkcant/contracts";
import { directoryBackedMetadata, isolatedLockedBuild, readDependencyLock } from "@clarkcant/capability-host";
import { EXECUTION_POLICY_PREFERENCE_KEY, digestOfDirectory, writeRegisteredPreference } from "@clarkcant/core";

import { freezeInstallClosure } from "../src/application/package-install.ts";
import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Installing from the directory.
 *
 * The route the marketplace reaches, and the reason it is worth testing at this level rather than only in the
 * supervisor it calls: every refusal below has to arrive with the code the resolver already uses, because a caller
 * that has to interpret a second vocabulary is how a marketplace becomes a second install path.
 *
 * The refusals are tested as carefully as the success. A route that installs is only half of what this has to be;
 * the other half is that the four ways a package can be wrong — the wrong platform, no digest, a host API the
 * package does not support, an entry the directory does not have — all stop before the policy is even asked,
 * let alone before anything is fetched (`resolvePackageSource` runs as this route's own preflight, ahead of the
 * fetch step `fetchRemoteArtifact` added).
 *
 * The happy-path fixture is a real, one-commit git repository on disk rather than a made-up digest: this node now
 * fetches a git or npm source instead of trusting whatever the directory claims about it, so a fixture that never
 * resolves to real bytes can no longer stand in for "installs". `GIT_SOURCE_URL`/`GIT_SOURCE_REF` are that
 * repository's path and pinned commit, and `GIT_SOURCE_DIGEST` is what this node's own `digestOfDirectory`
 * computes over the checked-out tree — the same function `fetchGitArtifact` uses — so the directory entry
 * publishes exactly the digest a real fetch will produce.
 */

const AT = "2026-09-20T05:00:00.000Z";

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let indexPath: string;
let previousIndex: string | undefined;
let previousAllowLocalGit: string | undefined;
let gitSourceUrl: string;
let gitSourceRef: string;
let gitSourceDigest: string;

/** The platform this test is running on, in the vocabulary packages and hosts share. */
const HOST_PLATFORM = platformForHost(process.platform, process.arch);

/** A one-commit git repository this route can actually fetch, built fresh per test so each run's digest is its own. */
function buildGitSource(root: string): { url: string; ref: string; digest: string } {
  const repo = join(root, "git-source");
  mkdirSync(repo, { recursive: true });
  const run = (...args: string[]): void => {
    const result = spawnSync("git", ["-C", repo, ...args]);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  };
  run("init", "--quiet");
  run("config", "user.email", "fixture@example.com");
  run("config", "user.name", "fixture");
  writeFileSync(join(repo, "widget.json"), JSON.stringify({ id: "com.example.calendar" }));
  run("add", ".");
  run("commit", "--quiet", "-m", "init");
  const ref = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
  const digest = digestOfDirectory(repo, { exclude: [".git"] });
  if (!digest.ok) throw new Error(digest.message);
  return { url: repo, ref, digest: digest.digest };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageId: "com.example.calendar",
    version: "1.2.0",
    displayName: "Calendar Plus",
    description: "A compact agenda and week view.",
    source: { kind: "git", url: gitSourceUrl, ref: gitSourceRef },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    // Whatever this machine is, so the success case is about installing rather than about the test's platform.
    platforms: [HOST_PLATFORM ?? "web"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 40_960,
    digest: gitSourceDigest,
    ...overrides,
  };
}

function writeIndex(entries: readonly Record<string, unknown>[]): void {
  writeFileSync(indexPath, JSON.stringify(entries));
}

async function install(body: Record<string, unknown>): Promise<GatewayResponse> {
  const request: GatewayRequest = {
    method: "POST",
    path: "/packages/install",
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: JSON.stringify(body),
  };
  return handleRequest(deps, request);
}

/** The activity route flattens each event to the fields the Control tab shows. */
async function activity(): Promise<{ effects: { kind?: string; category?: string; description?: string }[] }> {
  const request: GatewayRequest = {
    method: "GET",
    path: "/activity",
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: "",
  };
  const response = await handleRequest(deps, request);
  return response.body as { effects: { kind?: string; category?: string; description?: string }[] };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-install-"));
  const source = buildGitSource(dir);
  gitSourceUrl = source.url;
  gitSourceRef = source.ref;
  gitSourceDigest = source.digest;
  indexPath = join(dir, "directory.json");
  services = bootNodeServices({ dataDir: dir, label: "install route test node" });
  deps = { services, now: () => AT as never };
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
  // The fixture git "remote" is a bare filesystem path, which `fetchGitArtifact` refuses by default (C1: a
  // directory listing is untrusted, and only a test harness or an explicit local-install flow may fetch from a
  // local path). This test IS that explicit opt-in.
  previousAllowLocalGit = process.env["CC_ALLOW_LOCAL_GIT_SOURCES"];
  process.env["CC_ALLOW_LOCAL_GIT_SOURCES"] = "1";
});

afterEach(() => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  if (previousAllowLocalGit === undefined) delete process.env["CC_ALLOW_LOCAL_GIT_SOURCES"];
  else process.env["CC_ALLOW_LOCAL_GIT_SOURCES"] = previousAllowLocalGit;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("installing from the directory", () => {
  it("installs a listed package and says what it verified", async () => {
    writeIndex([entry()]);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect((body["installed"] as Record<string, unknown>)["packageId"]).toBe("com.example.calendar");
    expect(String(body["generationId"])).toContain("com.example.calendar@1.2.0");
    expect(body["state"]).toBe("active");
    /*
     * Named rather than implied. This node does not fetch or run the artifact, so "active" means the plan was bound
     * to a published digest — not that the package is known to work, and a reader should not have to guess which.
     */
    expect(body["verified"]).toBe("digest-only");
  });

  it("records the effect it performed without a card", async () => {
    writeIndex([entry()]);
    await install({ packageId: "com.example.calendar", version: "1.2.0" });

    // Autonomy without a record is the one combination this node refuses, so the record is part of the contract.
    const listed = await activity();
    const installed = listed.effects.filter(
      (effect) => effect.kind === "effect.executed" && effect.description === "install com.example.calendar@1.2.0",
    );
    expect(installed).toHaveLength(1);
    expect(installed[0]?.category).toBe("local-write");
  });

  it("does not let a forged grantedCapabilities in the request body become authority (issue #93, P1)", async () => {
    writeIndex([entry()]);

    const response = await install({
      packageId: "com.example.calendar",
      version: "1.2.0",
      // A client is not this node's consent state. If this survived into the installed plan, a forged
      // request body would grant a capability nobody on this node ever authorised.
      grantedCapabilities: ["project.code.change@1", "some.other.capability@1"],
    });

    expect(response.status).toBe(200);

    const row = services.runtime.db
      .prepare("SELECT document FROM install_plans WHERE requirement_key = ?")
      .get("pkg:com.example.calendar@1.2.0") as { document: string } | undefined;
    expect(row).toBeDefined();
    const plan = JSON.parse(row!.document) as { grantedCapabilities: readonly string[] };
    expect(plan.grantedCapabilities).toEqual([]);
  });

  it("asks first when the policy says to, and installs nothing", async () => {
    writeIndex([entry()]);
    // The canonical policy, written where the node reads it: this route asks the policy, not a row beside it.
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => AT as never },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask" },
        source: "user",
      },
    );
    if (!written.ok) throw new Error(written.message);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    // 202 rather than an error: nothing failed, and the approval is the next step.
    expect(response.status).toBe(202);
    const body = response.body as Record<string, unknown>;
    expect(body["code"]).toBe("APPROVAL_REQUIRED");
    expect(typeof body["approvalId"]).toBe("string");
    // Nothing was installed, and nothing claims it was.
    expect(JSON.stringify(body)).not.toContain("generationId");
  });

  it("refuses on a node that refuses every effect, and installs nothing", async () => {
    writeIndex([entry()]);
    // The third mode the install seam has to agree with the command and widget seams about.
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => AT as never },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, prohibition: "all" },
        source: "user",
      },
    );
    if (!written.ok) throw new Error(written.message);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(response.status).toBe(403);
    expect((response.body as Record<string, unknown>)["code"]).toBe("POLICY_REFUSED");
    expect(JSON.stringify(response.body)).not.toContain("generationId");
  });
});

describe("what the route refuses, with the code the resolver already uses", () => {
  it("refuses a package built for another platform, naming both sides", async () => {
    // The one platform this host is not, whatever this host is.
    const elsewhere = HOST_PLATFORM === "darwin-arm64" ? "linux-x64" : "darwin-arm64";
    writeIndex([entry({ platforms: [elsewhere] })]);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(response.status).toBe(400);
    const body = response.body as Record<string, unknown>;
    expect(body["code"]).toBe("PLATFORM_MISMATCH");
    // Both facts, so the message reads as "built for another machine" rather than as a malformed package.
    expect(String(body["message"])).toContain(elsewhere);
    expect(String(body["message"])).toContain(HOST_PLATFORM ?? "unknown");
  });

  it("refuses an entry that publishes no digest", async () => {
    // A space passes "at least one character" and is still no digest; "no digest" must never behave like "matched".
    writeIndex([entry({ digest: " " })]);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(response.status).toBe(400);
    expect((response.body as Record<string, unknown>)["code"]).toBe("DIGEST_MISMATCH");
  });

  it("refuses a package needing a host API this node does not implement", async () => {
    writeIndex([entry({ hostApi: { min: 9, max: 10 } })]);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(response.status).toBe(400);
    expect((response.body as Record<string, unknown>)["code"]).toBe("HOST_API_MISMATCH");
  });

  it("refuses a package the directory does not list", async () => {
    writeIndex([entry()]);

    const response = await install({ packageId: "com.example.other", version: "1.2.0" });

    expect(response.status).toBe(404);
    expect((response.body as Record<string, unknown>)["code"]).toBe("NOT_IN_DIRECTORY");
  });

  it("says the directory is unconfigured rather than that the package is missing", async () => {
    delete process.env["CC_DIRECTORY_INDEX"];

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    // Two different truths, and only one of them is the user's to fix.
    expect(response.status).toBe(409);
    const body = response.body as Record<string, unknown>;
    expect(body["code"]).toBe("NO_DIRECTORY");
    expect(String(body["message"])).toContain("CC_DIRECTORY_INDEX");
  });

  it("refuses a request that does not say what to install", async () => {
    writeIndex([entry()]);

    const response = await install({ packageId: "com.example.calendar" });

    expect(response.status).toBe(400);
    expect((response.body as Record<string, unknown>)["code"]).toBe("INVALID_SCHEMA");
  });
});

/** The installed packages the route reports. */
async function packages(): Promise<{ packages: { packageId: string; digest: string; lock?: { ref: string; digest: string; coverage: string } }[] }> {
  const request: GatewayRequest = {
    method: "GET",
    path: "/packages",
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: "",
  };
  const response = await handleRequest(deps, request);
  return response.body as { packages: { packageId: string; digest: string; lock?: { ref: string; digest: string; coverage: string } }[] };
}

describe("the frozen build input the route records", () => {
  it("resolves the closure before installing, and reports what the lock covers", async () => {
    writeIndex([entry()]);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    const lock = body["lock"] as { ref: string; digest: string; coverage: string };
    /*
     * `artifact-only` is the honest answer for a node that has not downloaded the artifact: it pinned what the
     * directory published and the platform it would build for, and the package's own tree is not something it can
     * read from here. A build refuses a lock that does not cover the tree rather than reading this as "pinned".
     */
    expect(lock.coverage).toBe("artifact-only");
    expect(lock.digest.startsWith("sha256:")).toBe(true);

    // The artifact is on the node, under the reference the plan and the generation carry.
    const stored = JSON.parse(readFileSync(join(dir, "locks", lock.ref), "utf8")) as {
      lockDigest: string;
      dependencies: { name: string; version: string; resolvedFrom: string }[];
    };
    expect(stored.lockDigest).toBe(lock.digest);
    expect(stored.dependencies).toEqual([
      {
        name: "com.example.calendar",
        version: "1.2.0",
        integrity: gitSourceDigest,
        resolvedFrom: `git:${gitSourceUrl}#${gitSourceRef}`,
      },
    ]);

    // And the same statement comes back from what is installed: what is running is what was frozen.
    const listed = await packages();
    expect(listed.packages[0]?.lock?.digest).toBe(lock.digest);
    expect(listed.packages[0]?.lock?.ref).toBe(lock.ref);
  });

  it("refuses a second install whose resolution is not the frozen one, naming the artifact", async () => {
    writeIndex([entry()]);
    const first = await install({ packageId: "com.example.calendar", version: "1.2.0" });
    expect(first.status).toBe(200);

    /*
     * The directory now claims different bytes for the same version, but the git repository this node actually
     * fetches from is unchanged. Because a git/npm source is fetched and its digest checked against real bytes
     * now (rather than trusted from the listing), the mismatch this node reports is the fetch's own integrity
     * check — the honest, earlier refusal for "the directory's claim and this node's own fetch disagree" —
     * rather than the plan-comparison `LOCK_DRIFT` that fires only once a fetch would have succeeded.
     */
    writeIndex([entry({ digest: "sha256:published-digest-2" })]);
    const second = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(second.status).toBe(409);
    const body = second.body as Record<string, unknown>;
    expect(body["code"]).toBe("DIGEST_MISMATCH");
    // Nothing was installed a second time, and the first resolution is still the one that is running.
    const listed = await packages();
    expect(listed.packages).toHaveLength(1);
    expect(listed.packages[0]?.digest).toBe(gitSourceDigest);
  });

  it("refuses an entry with no digest before it freezes anything", async () => {
    writeIndex([entry({ digest: " " })]);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    // The installer's own refusal, unchanged: an entry with no digest is that, not "the closure failed to resolve".
    expect(response.status).toBe(400);
    expect((response.body as Record<string, unknown>)["code"]).toBe("DIGEST_MISMATCH");
    // And no lock was written for bytes nobody can check.
    expect(existsSync(join(dir, "locks"))).toBe(false);
  });
});

/**
 * The closure the route consumes, and the path it hands it to.
 *
 * The claim here is narrower than "the route builds": it freezes what it can pin, reads it back through the same
 * reader the locked-build runner uses, and reports what that runner would do with it. A node that has not
 * downloaded the artifact cannot pin the package's tree, so the honest answer is a closure a build refuses — and
 * what must be proven is that the refusal is real and that nothing re-resolves around it.
 */
describe("the frozen closure the install route consumes", () => {
  it("hands back the artifact a build reads, and keeps its coverage claim honest", () => {
    const lockDir = join(dir, "locks");
    const listed = directoryEntrySchema.parse(entry());
    const outcome = freezeInstallClosure({
      lockDir,
      entry: listed,
      metadata: directoryBackedMetadata([listed]),
      buildInputs: { platform: HOST_PLATFORM ?? "web", nodeAbi: process.versions.modules },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const lock = outcome.frozen.lock;
    expect(lock).toBeDefined();
    if (lock === undefined) return;

    /*
     * What comes back is what a build reads under the same reference, not the in-memory copy: the plan is bound to
     * bytes that were persisted and re-hashed, so a plan can never name an artifact no build can read.
     */
    const readBack = readDependencyLock({ dir: lockDir, lockRef: lock.lockRef, lockDigest: lock.lockDigest });
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) return;
    expect(readBack.lock).toEqual(lock);

    // The coverage is stated rather than widened: the package's own tree is not readable from here.
    expect(lock.coverage).toBe("artifact-only");
    expect(outcome.frozen.buildRefusal?.code).toBe("LOCK_INCOMPLETE");
  });

  it("reports that a build would refuse the closure, and the runner really does", async () => {
    writeIndex([entry()]);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(response.status).toBe(200);
    const lock = (response.body as Record<string, unknown>)["lock"] as {
      ref: string;
      digest: string;
      coverage: string;
      buildable: boolean;
      buildRefusal?: string;
    };
    // Stated in the response rather than left to be assumed: this closure is not one a build would run.
    expect(lock.buildable).toBe(false);
    expect(String(lock.buildRefusal)).toContain("artifact-only");

    const quarantineDir = join(dir, "quarantine");
    const root = join(quarantineDir, "payload");
    mkdirSync(root, { recursive: true });
    const built = await isolatedLockedBuild({
      lockDir: join(dir, "locks"),
      lockRef: lock.ref,
      lockDigest: lock.digest,
      root,
      quarantineDir,
      command: process.execPath,
      args: ["-e", "process.stdout.write('built')"],
    });

    // The runner reads the recorded closure and refuses it by name — it never resolves a closure of its own, and a
    // build on a tree nobody pinned does not start.
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe("LOCK_INCOMPLETE");
    expect(built.message).toContain("artifact-only");
  });

  it("refuses a floating range before anything is frozen", async () => {
    writeIndex([entry()]);

    // The same package, asked for as a range. A range names whatever is current, so it names no artifact this node
    // could pin — and the refusal arrives before any closure is resolved.
    const response = await install({ packageId: "com.example.calendar", version: "^1.2.0" });

    expect(response.status).toBe(404);
    expect((response.body as Record<string, unknown>)["code"]).toBe("NOT_IN_DIRECTORY");
    expect(existsSync(join(dir, "locks"))).toBe(false);
  });
});
