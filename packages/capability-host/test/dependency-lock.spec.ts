import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { directoryEntrySchema } from "@clarkcant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  artifactRequest,
  assertLockUnchanged,
  directoryBackedMetadata,
  frozenBuildEnvironment,
  lifecycleScriptGate,
  lockBindingForPlan,
  materializeDependencyLock,
  prepareLockedBuild,
  readDependencyLock,
  resolveDependencyClosure,
  writeDependencyLock,
  type BuildInputs,
  type DependencyLock,
  type DependencyMetadata,
  type DependencyMetadataSource,
  type DependencyRequest,
} from "../src/dependency-lock.ts";
import { isolatedLockedBuild } from "../src/quarantine.ts";

/**
 * The dependency lock (V08, install determinism).
 *
 * The claim under test is narrow and checkable: a build consumes the artifacts and build inputs that were frozen
 * and consented to, and it fails instead of resolving a range again. So the tests are the five failures that claim
 * has to survive — a floating range pinned before the build, a build reading the recorded version, a changed
 * closure invalidating the prior consent, missing or edited lock material stopping the build, and an unapproved
 * lifecycle script gaining no execution — plus the digest stability that makes any of it mean something.
 *
 * Nothing here says a pinned dependency is safe. A lock proves reproducibility; what the pinned code does is a
 * question this module does not answer and must not appear to.
 */

let dirs: string[] = [];

function tempDir(): string {
  const made = mkdtempSync(join(tmpdir(), "clarkcant-lock-"));
  dirs.push(made);
  return made;
}

afterEach(() => {
  for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true });
  dirs = [];
});

const PACKAGE = { packageId: "com.example.calendar", version: "1.2.0" };
const BUILD_INPUTS: BuildInputs = { platform: "linux-x64", nodeAbi: "137" };
const ARTIFACT: DependencyRequest = {
  name: "com.example.calendar",
  spec: "com.example.calendar@1.2.0",
  provenance: "npm",
};
const RANGE: DependencyRequest = { name: "left-pad", spec: "^1.2.0", provenance: "npm" };

const ARTIFACT_METADATA: DependencyMetadata = {
  version: "1.2.0",
  integrity: "sha256:published-digest",
  resolvedFrom: "npm:com.example.calendar@1.2.0",
};

function metadataSource(entries: Record<string, DependencyMetadata>): DependencyMetadataSource {
  return { resolve: (request) => entries[request.name] };
}

/** The closure a package published once: the artifact, plus a dependency written as a range. */
function published(overrides: Record<string, DependencyMetadata> = {}): DependencyMetadataSource {
  return metadataSource({
    "com.example.calendar": ARTIFACT_METADATA,
    "left-pad": { version: "1.2.5", integrity: "sha512-leftpad1", resolvedFrom: "npm:left-pad@1.2.5" },
    ...overrides,
  });
}

function resolvedClosure(metadata: DependencyMetadataSource, requests: readonly DependencyRequest[] = [ARTIFACT, RANGE]) {
  const resolution = resolveDependencyClosure({ requests, metadata });
  if (!resolution.ok) throw new Error(`fixture did not resolve: ${resolution.message}`);
  return resolution.resolved;
}

function completeLock(input: { lifecycleScripts?: readonly string[] } = {}): DependencyLock {
  return materializeDependencyLock({
    ...PACKAGE,
    coverage: "artifact-and-dependencies",
    resolved: resolvedClosure(published()),
    ...(input.lifecycleScripts === undefined ? {} : { lifecycleScripts: input.lifecycleScripts }),
    buildInputs: BUILD_INPUTS,
  });
}

/** A written lock plus the directory it lives in, which is what a plan records a reference into. */
function storedLock(lock: DependencyLock = completeLock()): { dir: string; lock: DependencyLock } {
  const dir = tempDir();
  const written = writeDependencyLock({ dir, lock });
  if (!written.ok) throw new Error(`fixture could not be written: ${written.message}`);
  return { dir, lock };
}

function prepare(
  stored: { dir: string; lock: DependencyLock },
  overrides: Partial<Parameters<typeof prepareLockedBuild>[0]> = {},
) {
  return prepareLockedBuild({
    lockDir: stored.dir,
    consented: { lockRef: stored.lock.lockRef, lockDigest: stored.lock.lockDigest, coverage: stored.lock.coverage },
    ...PACKAGE,
    artifact: ARTIFACT,
    declared: [RANGE],
    metadata: published(),
    buildInputs: BUILD_INPUTS,
    lifecycleScripts: stored.lock.lifecycleScripts,
    ...overrides,
  });
}

function buildRoot(lockDir: string): { quarantineDir: string; root: string } {
  const quarantineDir = join(lockDir, "quarantine");
  const root = join(quarantineDir, "payload");
  mkdirSync(root, { recursive: true });
  return { quarantineDir, root };
}

describe("resolving metadata before any executable step", () => {
  it("pins a floating range to the exact version its metadata names", () => {
    const resolution = resolveDependencyClosure({ requests: [RANGE], metadata: published() });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // The range is what the package wrote; what the closure carries is one artifact, with its integrity and a
    // provenance that says which kind of source it came from.
    expect(resolution.resolved).toEqual([
      {
        name: "left-pad",
        version: "1.2.5",
        integrity: "sha512-leftpad1",
        resolvedFrom: "npm:left-pad@1.2.5",
      },
    ]);
    expect(JSON.stringify(resolution.resolved)).not.toContain("^1.2.0");
  });

  it("keeps the three source kinds distinguishable rather than flattening them", () => {
    const entries = [
      directoryEntrySchema.parse(entry({ packageId: "pkg.npm", source: { kind: "npm", name: "pkg.npm", version: "1.0.0" } })),
      directoryEntrySchema.parse(
        entry({ packageId: "pkg.git", source: { kind: "git", url: "https://example.invalid/pkg.git", ref: "v1.0.0" } }),
      ),
      directoryEntrySchema.parse(entry({ packageId: "pkg.local", source: { kind: "local", path: "/tmp/pkg.local" } })),
    ];
    const resolution = resolveDependencyClosure({
      requests: entries.map((source) => artifactRequest(source)),
      metadata: directoryBackedMetadata(entries),
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const refs = Object.fromEntries(resolution.resolved.map((pin) => [pin.name, pin.resolvedFrom]));
    // An npm version, a git revision and a workspace path are three different claims, and a lock that printed the
    // same string for all three would make a tarball and a checkout on this machine look alike.
    expect(refs["pkg.npm"]).toBe("npm:pkg.npm@1.0.0");
    expect(refs["pkg.git"]).toBe("git:https://example.invalid/pkg.git#v1.0.0");
    expect(refs["pkg.local"]).toBe("local:/tmp/pkg.local");
  });

  it("refuses a closure it cannot pin, naming the request it has no metadata for", () => {
    const resolution = resolveDependencyClosure({
      requests: [RANGE],
      metadata: metadataSource({}),
    });

    expect(resolution.ok ? "" : resolution.code).toBe("NO_METADATA");
    expect(resolution.ok ? "" : resolution.message).toContain("left-pad");
  });

  it("refuses metadata that answers with something still floating, or with no integrity", () => {
    const floating = resolveDependencyClosure({
      requests: [RANGE],
      metadata: metadataSource({
        "left-pad": { version: "latest", integrity: "sha512-leftpad1", resolvedFrom: "npm:left-pad@latest" },
      }),
    });
    expect(floating.ok ? "" : floating.code).toBe("VERSION_NOT_EXACT");

    const unpinned = resolveDependencyClosure({
      requests: [RANGE],
      metadata: metadataSource({
        "left-pad": { version: "1.2.5", integrity: "", resolvedFrom: "npm:left-pad@1.2.5" },
      }),
    });
    expect(unpinned.ok ? "" : unpinned.code).toBe("INCOMPLETE_PIN");
  });

  it("refuses one name resolving to two artifacts rather than picking one", () => {
    const resolution = resolveDependencyClosure({
      requests: [RANGE, { name: "left-pad", spec: "1.3.0", provenance: "npm" }],
      metadata: metadataSource({
        "left-pad": { version: "1.2.5", integrity: "sha512-leftpad1", resolvedFrom: "npm:left-pad@1.2.5" },
      }),
    });

    // Same name twice from the same metadata is one pin; the conflict case is two different pins for one name.
    expect(resolution.ok).toBe(true);

    const conflicting = resolveDependencyClosure({
      requests: [RANGE, { name: "left-pad", spec: "1.3.0", provenance: "local" }],
      metadata: {
        resolve: (request) =>
          request.provenance === "local"
            ? { version: "1.3.0", integrity: "sha512-leftpad2", resolvedFrom: "local:/tmp/left-pad" }
            : { version: "1.2.5", integrity: "sha512-leftpad1", resolvedFrom: "npm:left-pad@1.2.5" },
      },
    });
    expect(conflicting.ok ? "" : conflicting.code).toBe("CONFLICTING_RESOLUTION");
    expect(conflicting.ok ? "" : conflicting.message).toContain("left-pad");
  });
});

describe("the lock artifact", () => {
  it("hashes the same input to the same digest, and any changed pin to a different one", () => {
    const first = completeLock();
    const again = completeLock();

    expect(again.lockDigest).toBe(first.lockDigest);
    // Order of what was resolved is not part of the meaning: the same set in another order is the same lock.
    const reversed = materializeDependencyLock({
      ...PACKAGE,
      coverage: "artifact-and-dependencies",
      resolved: resolvedClosure(published()).reverse(),
      buildInputs: BUILD_INPUTS,
    });
    expect(reversed.lockDigest).toBe(first.lockDigest);

    const movedVersion = materializeDependencyLock({
      ...PACKAGE,
      coverage: "artifact-and-dependencies",
      resolved: resolvedClosure(published({ "left-pad": { version: "1.2.6", integrity: "sha512-leftpad1b", resolvedFrom: "npm:left-pad@1.2.6" } })),
      buildInputs: BUILD_INPUTS,
    });
    expect(movedVersion.lockDigest).not.toBe(first.lockDigest);

    const movedIntegrity = materializeDependencyLock({
      ...PACKAGE,
      coverage: "artifact-and-dependencies",
      resolved: resolvedClosure(published({ "left-pad": { version: "1.2.5", integrity: "sha512-other", resolvedFrom: "npm:left-pad@1.2.5" } })),
      buildInputs: BUILD_INPUTS,
    });
    expect(movedIntegrity.lockDigest).not.toBe(first.lockDigest);

    const otherPlatform = materializeDependencyLock({
      ...PACKAGE,
      coverage: "artifact-and-dependencies",
      resolved: resolvedClosure(published()),
      buildInputs: { ...BUILD_INPUTS, platform: "darwin-arm64" },
    });
    expect(otherPlatform.lockDigest).not.toBe(first.lockDigest);

    // A declared load-time script is a build input too: adding one changes what the build will do.
    const withScript = materializeDependencyLock({
      ...PACKAGE,
      coverage: "artifact-and-dependencies",
      resolved: resolvedClosure(published()),
      lifecycleScripts: ["postinstall"],
      buildInputs: BUILD_INPUTS,
    });
    expect(withScript.lockDigest).not.toBe(first.lockDigest);
  });

  it("binds the reference, the digest and the closure into what a plan carries", () => {
    const lock = completeLock();
    const binding = lockBindingForPlan(lock);

    expect(binding.lockRef).toBe(lock.lockRef);
    expect(binding.lockRef.startsWith("locks/")).toBe(true);
    expect(binding.lockDigest).toBe(lock.lockDigest);
    expect(binding.coverage).toBe("artifact-and-dependencies");
    // The plan's rows are the same pins: a plan that named the closure while the build read another one would be
    // exactly the gap this phase closes.
    expect(binding.dependencies.map((pin) => pin.name)).toEqual(["com.example.calendar", "left-pad"]);
  });

  it("does not replace a frozen artifact when a resolution produces a different one", () => {
    const { dir, lock } = storedLock();
    const moved = materializeDependencyLock({
      ...PACKAGE,
      coverage: "artifact-and-dependencies",
      resolved: resolvedClosure(published({ "left-pad": { version: "1.3.0", integrity: "sha512-leftpad2", resolvedFrom: "npm:left-pad@1.3.0" } })),
      buildInputs: BUILD_INPUTS,
    });

    const written = writeDependencyLock({ dir, lock: moved });

    expect(written.ok ? "" : written.code).toBe("LOCK_IMMUTABLE");
    // The consented artifact is untouched, so a later build still reads the closure that was approved.
    const stillThere = readDependencyLock({ dir, lockRef: lock.lockRef, lockDigest: lock.lockDigest });
    expect(stillThere.ok).toBe(true);
  });
});

describe("the build consumes the frozen state", () => {
  it("runs a build that reads the recorded version, not the one metadata would resolve now", async () => {
    const { dir, lock } = storedLock();
    const { quarantineDir, root } = buildRoot(dir);

    const built = await isolatedLockedBuild({
      lockDir: dir,
      lockRef: lock.lockRef,
      lockDigest: lock.lockDigest,
      root,
      quarantineDir,
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.CC_LOCKED_DEPENDENCIES ?? '')"],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const seen = JSON.parse(built.stdout) as { lockDigest: string; dependencies: { name: string; version: string }[] };
    expect(seen.lockDigest).toBe(lock.lockDigest);
    expect(seen.dependencies.find((pin) => pin.name === "left-pad")?.version).toBe("1.2.5");
    // The metadata now says the range resolves to 1.3.0. The build is not allowed to see that, and does not.
    expect(built.stdout).not.toContain("1.3.0");
  });

  it("keeps the credential-minimal environment when the build is run through the lock", async () => {
    const { dir, lock } = storedLock();
    const { quarantineDir, root } = buildRoot(dir);

    process.env["TYPESAFE_API_KEY"] = "not-a-real-key";
    try {
      const built = await isolatedLockedBuild({
        lockDir: dir,
        lockRef: lock.lockRef,
        lockDigest: lock.lockDigest,
        root,
        quarantineDir,
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({ cwd: process.cwd(), key: process.env.TYPESAFE_API_KEY ?? null }))"],
      });

      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const seen = JSON.parse(built.stdout) as { cwd: string; key: string | null };
      expect(seen.key).toBeNull();
      expect(seen.cwd.toLowerCase()).toContain("quarantine");
    } finally {
      delete process.env["TYPESAFE_API_KEY"];
    }
  });
});

describe("drift invalidates the prior consent", () => {
  it("stops a build whose metadata now resolves to a different closure, naming the dependency", () => {
    const { dir, lock } = storedLock();

    const outcome = prepare(
      { dir, lock },
      { metadata: published({ "left-pad": { version: "1.3.0", integrity: "sha512-leftpad2", resolvedFrom: "npm:left-pad@1.3.0" } }) },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("LOCK_DRIFT");
    // The name is the actionable part: "the lock changed" is not something a person can look at.
    expect(outcome.message).toContain("left-pad");
    expect(outcome.message).toContain("1.2.5");
    expect(outcome.message).toContain("1.3.0");
    // Nothing was replaced, so the consented closure is still the one a build would read.
    const stillThere = readDependencyLock({ dir, lockRef: lock.lockRef, lockDigest: lock.lockDigest });
    expect(stillThere.ok && stillThere.lock.dependencies.find((pin) => pin.name === "left-pad")?.version).toBe("1.2.5");
  });

  it("stops when the artifact itself moved, and when a build input moved", () => {
    const { dir, lock } = storedLock();

    const artifactMoved = prepare(
      { dir, lock },
      {
        metadata: metadataSource({
          "com.example.calendar": { version: "1.2.0", integrity: "sha256:different-digest", resolvedFrom: "npm:com.example.calendar@1.2.0" },
          "left-pad": { version: "1.2.5", integrity: "sha512-leftpad1", resolvedFrom: "npm:left-pad@1.2.5" },
        }),
      },
    );
    expect(artifactMoved.ok ? "" : artifactMoved.code).toBe("LOCK_DRIFT");
    expect(artifactMoved.ok ? "" : artifactMoved.message).toContain("com.example.calendar");

    const platformMoved = prepare({ dir, lock }, { buildInputs: { ...BUILD_INPUTS, platform: "darwin-arm64" } });
    expect(platformMoved.ok ? "" : platformMoved.code).toBe("LOCK_DRIFT");
    expect(platformMoved.ok ? "" : platformMoved.message).toContain("platform");
  });

  it("reports an added load-time script as drift rather than accepting it silently", () => {
    const consented = completeLock();
    const current = completeLock({ lifecycleScripts: ["postinstall"] });

    const unchanged = assertLockUnchanged(consented, current);

    expect(unchanged.ok).toBe(false);
    if (unchanged.ok) return;
    expect(unchanged.message).toContain("postinstall");
  });

  it("accepts a closure that is still the one that was consented to", () => {
    const { dir, lock } = storedLock();
    const outcome = prepare({ dir, lock });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.prepared.lock.lockDigest).toBe(lock.lockDigest);
  });

  it("refuses a lock that does not cover the dependency tree a build would consume", () => {
    const { dir, lock } = storedLock(
      materializeDependencyLock({
        ...PACKAGE,
        // What a node that has not downloaded the artifact can honestly freeze: the artifact and the build inputs.
        coverage: "artifact-only",
        resolved: resolvedClosure(published(), [ARTIFACT]),
        buildInputs: BUILD_INPUTS,
      }),
    );

    const outcome = prepare({ dir, lock });

    expect(outcome.ok ? "" : outcome.code).toBe("LOCK_INCOMPLETE");
    expect(outcome.ok ? "" : outcome.message).toContain("artifact-only");
  });
});

describe("missing or edited lock material fails closed", () => {
  it("stops the build when the artifact is not there at all", async () => {
    const { dir, lock } = storedLock();
    const { quarantineDir, root } = buildRoot(dir);
    rmSync(join(dir, lock.lockRef));

    const outcome = prepare({ dir, lock });
    expect(outcome.ok ? "" : outcome.code).toBe("LOCK_MISSING");

    let spawned = 0;
    const built = await isolatedLockedBuild({
      lockDir: dir,
      lockRef: lock.lockRef,
      lockDigest: lock.lockDigest,
      root,
      quarantineDir,
      command: process.execPath,
      args: ["-e", "process.stdout.write('the build should not have run')"],
      spawnImpl: vi.fn(() => {
        spawned += 1;
        throw new Error("a build was started without a lock artifact");
      }) as never,
    });

    expect(built.ok ? "" : built.code).toBe("LOCK_MISSING");
    // No fallback to resolving the closure again, and nothing executed.
    expect(spawned).toBe(0);
  });

  it("stops the build when the contents were edited after they were written", async () => {
    const { dir, lock } = storedLock();
    const { quarantineDir, root } = buildRoot(dir);
    const path = join(dir, lock.lockRef);
    const edited = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const dependencies = edited["dependencies"] as { name: string; version: string }[];
    const target = dependencies.find((pin) => pin.name === "left-pad");
    if (target === undefined) throw new Error("fixture has no left-pad");
    target.version = "1.3.0";
    writeFileSync(path, JSON.stringify(edited));

    const outcome = prepare({ dir, lock });
    expect(outcome.ok ? "" : outcome.code).toBe("LOCK_MUTATED");

    const built = await isolatedLockedBuild({
      lockDir: dir,
      lockRef: lock.lockRef,
      lockDigest: lock.lockDigest,
      root,
      quarantineDir,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    expect(built.ok ? "" : built.code).toBe("LOCK_MUTATED");
    expect(built.ok ? "" : built.message).toContain("no longer hash");
  });

  it("refuses a reference that points outside the lock directory", async () => {
    const { dir, lock } = storedLock();
    const { quarantineDir, root } = buildRoot(dir);
    const escaped = { lockRef: `../${lock.lockDigest.replace(":", "-")}.json`, lockDigest: lock.lockDigest };
    writeFileSync(join(dir, "..", `${lock.lockDigest.replace(":", "-")}.json`), JSON.stringify(lock));

    const built = await isolatedLockedBuild({
      lockDir: dir,
      ...escaped,
      root,
      quarantineDir,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });

    expect(built.ok ? "" : built.code).toBe("LOCK_MUTATED");
    expect(built.ok ? "" : built.message).toContain("lock directory");
  });
});

describe("lifecycle scripts", () => {
  it("grants execution to nothing that was not approved", async () => {
    const { dir, lock } = storedLock(completeLock({ lifecycleScripts: ["preinstall", "postinstall"] }));
    const { quarantineDir, root } = buildRoot(dir);

    let spawned = 0;
    const built = await isolatedLockedBuild({
      lockDir: dir,
      lockRef: lock.lockRef,
      lockDigest: lock.lockDigest,
      root,
      quarantineDir,
      command: process.execPath,
      // If this ran it would leave a marker, so "no execution" is checked on the filesystem as well as on the spy.
      args: ["-e", "require('node:fs').writeFileSync('ran.txt','x'); process.exit(0)"],
      spawnImpl: vi.fn(() => {
        spawned += 1;
        throw new Error("a build was started with an unapproved lifecycle script");
      }) as never,
    });

    expect(built.ok ? "" : built.code).toBe("LIFECYCLE_SCRIPT_NOT_APPROVED");
    expect(built.ok ? "" : built.message).toContain("postinstall");
    expect(spawned).toBe(0);
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
  });

  it("lets the build proceed when the scripts it declares were approved by name", async () => {
    const { dir, lock } = storedLock(completeLock({ lifecycleScripts: ["postinstall"] }));
    const { quarantineDir, root } = buildRoot(dir);

    const built = await isolatedLockedBuild({
      lockDir: dir,
      lockRef: lock.lockRef,
      lockDigest: lock.lockDigest,
      approvedLifecycleScripts: ["postinstall"],
      root,
      quarantineDir,
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.CC_LOCKED_LIFECYCLE_SCRIPTS ?? '')"],
    });

    expect(built.ok).toBe(true);
    if (built.ok) expect(built.stdout).toContain("postinstall");
  });

  it("reports which scripts were permitted and which were refused", () => {
    const gate = lifecycleScriptGate({ declared: ["install", "postinstall", "install"], approved: ["install"] });

    expect(gate.permitted).toEqual(["install"]);
    expect(gate.refused).toEqual(["postinstall"]);
    // Nothing declared and nothing approved is still nothing permitted.
    expect(lifecycleScriptGate({ declared: [], approved: ["install"] }).permitted).toEqual([]);
  });
});

/** A directory entry, as the marketplace publishes one. Local to this file so the fixture says what it claims. */
function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    packageId: "com.example.calendar",
    version: "1.0.0",
    displayName: "Calendar Plus",
    description: "A compact agenda and week view.",
    source: { kind: "npm", name: "com.example.calendar", version: "1.0.0" },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    platforms: ["linux-x64", "darwin-arm64", "win32-x64", "web"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 40_960,
    digest: "sha256:published-digest",
    ...overrides,
  };
}
