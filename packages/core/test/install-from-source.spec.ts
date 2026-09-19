import { instantSchema, type DirectoryEntry } from "@clarkcant/contracts";
import { migrate, openDatabase } from "@clarkcant/storage";
import { beforeEach, describe, expect, it } from "vitest";

import { installFromSource, type InstallFromSourceInput } from "../src/install-from-source.ts";
import { activeGeneration, getPlan } from "../src/install-lifecycle.ts";
import { listInstalledPackages } from "../src/installed-packages.ts";

/**
 * Installing from a source.
 *
 * The claim is that a marketplace is a source resolver and nothing more: everything after resolution is the install
 * supervisor that already existed. So the tests are about the supervisor's guarantees holding through this entry
 * point — no plan without consent, no `active` without a healthcheck, a digest that has to match, and a rollback
 * that is reported as refused rather than claimed when it comes too late.
 */

const AT = instantSchema.parse("2026-09-20T02:00:00.000Z");
const EXPIRES = instantSchema.parse("2026-09-20T03:00:00.000Z");
const DIGEST = "sha256:published-digest";

const ENTRY: DirectoryEntry = {
  packageId: "com.example.calendar",
  version: "1.2.0",
  displayName: "Calendar Plus",
  description: "A compact agenda and week view.",
  publisher: { id: "example", sourceUrl: "https://github.com/example/calendar-plus", license: "MIT" },
  preview: {},
  facets: ["ui"],
  platforms: ["linux-x64"],
  hostApi: { min: 1, max: 2 },
  permissionsSummary: [],
  riskTier: "isolated-ui",
  sizeBytes: 40_960,
  digest: DIGEST,
};

let counter = 0;

function makeDeps() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  return {
    db,
    nodeId: "node_a",
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  };
}

let deps: ReturnType<typeof makeDeps>;

beforeEach(() => {
  deps = makeDeps();
});

function input(overrides: Partial<InstallFromSourceInput> = {}): InstallFromSourceInput {
  return {
    source: { kind: "npm", name: "com.example.calendar", version: "1.2.0" },
    directory: [ENTRY],
    hostApi: 1,
    platform: "linux-x64",
    ownerPrincipalId: "prin_owner",
    requirementKey: "cap:project.code.change@1",
    requestedCapabilityRefs: ["project.code.change@1"],
    grantedCapabilities: ["project.code.change@1"],
    isolationPlan: [{ facetKind: "ui", isolation: "isolated-ui" }],
    codeGeneration: "codegen_1",
    healthcheck: () => true,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

describe("what the install refuses before it plans anything", () => {
  it("refuses a branch, and leaves no plan behind", () => {
    const outcome = installFromSource(
      deps,
      input({ source: { kind: "git", url: "com.example.calendar", ref: "main" } }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("GIT_REF_NOT_EXACT");
    // Nothing planned: a refusal that still wrote a plan would leave a prompt for something nobody may install.
    const plans = deps.db.prepare("SELECT COUNT(*) AS n FROM install_plans").get() as { n: number };
    expect(plans.n).toBe(0);
  });

  it("refuses a directory entry whose digest is missing", () => {
    const outcome = installFromSource(deps, input({ directory: [{ ...ENTRY, digest: " " }] }));

    // "No digest" must never behave like "digest matched".
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("DIGEST_MISMATCH");
  });

  it("refuses a package built for another host API, before download", () => {
    const outcome = installFromSource(deps, input({ directory: [{ ...ENTRY, hostApi: { min: 9, max: 10 } }] }));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("HOST_API_MISMATCH");
  });
});

describe("a successful install", () => {
  it("reaches active with a generation, and records consent by digest", () => {
    const outcome = installFromSource(deps, input());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe("active");
    expect(outcome.generationId).toContain("com.example.calendar@1.2.0");
    expect(outcome.joinedExisting).toBe(false);

    // Consent is bound to the plan digest, so what the user approved is what was installed.
    const record = getPlan(deps, outcome.planId);
    expect(record?.consentedDigest).toBe(record?.plan.planDigest);
    expect(record?.plan.candidate.digest).toBe(DIGEST);
  });

  it("leaves the plan active and the generation current", () => {
    const outcome = installFromSource(deps, input());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const generation = activeGeneration(deps, "com.example.calendar", "node_a");
    expect(generation?.generationId).toBe(outcome.generationId);
  });

  it("joins an existing plan rather than installing the same thing twice", () => {
    const first = installFromSource(deps, input());
    expect(first.ok).toBe(true);

    /*
     * The unique index on (requirement, node) is what makes this safe under concurrency, and it is the reason two
     * tasks needing the same pack produce one prompt rather than two racing installs.
     */
    const second = installFromSource(deps, input());
    expect(second.ok).toBe(true);
    if (second.ok && first.ok) {
      expect(second.planId).toBe(first.planId);
      expect(second.joinedExisting).toBe(true);
    }
  });
});

describe("a failed healthcheck", () => {
  it("reports what actually happened, and never claims a rollback it did not perform", () => {
    // A first install, so there is no previous generation to go back to.
    const first = installFromSource(deps, input());
    expect(first.ok).toBe(true);

    const second = installFromSource(
      deps,
      input({
        requirementKey: "cap:project.code.change@2",
        codeGeneration: "codegen_2",
        healthcheck: () => false,
      }),
    );

    expect(second.ok).toBe(false);
    if (second.ok) return;
    /*
     * Either outcome is honest, and the point is that the function says which. A failure this late may already have
     * replaced the active generation, in which case an automatic rollback is refused and a person is asked to look —
     * reporting "rolled back" there would be the worst answer available.
     */
    expect(["HEALTHCHECK_FAILED", "ROLLBACK_REFUSED"]).toContain(second.code);
    expect(second.message.length).toBeGreaterThan(0);
    if (second.code === "ROLLBACK_REFUSED") expect(second.rolledBack).toBe(false);
  });

  it("does not leave the new generation active when it rolled back", () => {
    const first = installFromSource(deps, input());
    expect(first.ok).toBe(true);

    const second = installFromSource(
      deps,
      input({
        requirementKey: "cap:project.code.change@3",
        codeGeneration: "codegen_3",
        healthcheck: () => false,
      }),
    );

    const current = activeGeneration(deps, "com.example.calendar", "node_a");
    if (!second.ok && second.rolledBack === true) {
      // Rolled back, so the previous generation is the current one again.
      expect(current?.generationId).not.toContain("codegen_3");
    } else {
      // Not rolled back, so the caller was told a person has to look — and the assertion here is only that the
      // function did not claim otherwise.
      expect(second.ok).toBe(false);
    }
  });
});

describe("the plan a source produces", () => {
  it("carries the rationale and the tier, so consent names where it came from", () => {
    const outcome = installFromSource(deps, input());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const record = getPlan(deps, outcome.planId);
    expect(record?.plan.candidate.rationale).toContain("npm com.example.calendar@1.2.0");
    expect(record?.plan.candidate.sourceTier).toBe("curated-registry");
    expect(record?.plan.isolationPlan).toEqual([{ facetKind: "ui", isolation: "isolated-ui" }]);
  });

  it("records the isolation the supervisor will apply, not the publisher's claim", () => {
    const outcome = installFromSource(
      deps,
      input({ isolationPlan: [{ facetKind: "tools", isolation: "trusted-native" }] }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // A native facet is what decides whether this install needs a restart, and it is the supervisor's plan that
    // says so rather than the manifest.
    const record = getPlan(deps, outcome.planId);
    expect(record?.plan.isolationPlan[0]?.isolation).toBe("trusted-native");
  });
});

describe("a local package", () => {
  it("plans against the digest the caller computed, and refuses without one", () => {
    const without = installFromSource(deps, input({ source: { kind: "local", path: "/tmp/widget" } }));
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.code).toBe("LOCAL_DIGEST_REQUIRED");

    const withDigest = installFromSource(
      deps,
      input({ source: { kind: "local", path: "/tmp/widget" }, localDigest: "sha256:local", requirementKey: "cap:local" }),
    );

    /*
     * A local path is first-class: a directory account is not a precondition for running your own widget, and the
     * plan still names the exact bytes because the digest is the identity.
     */
    expect(withDigest.ok).toBe(true);
    if (withDigest.ok) {
      expect(getPlan(deps, withDigest.planId)?.plan.candidate.digest).toBe("sha256:local");
    }
  });
});


describe("what the node reports as installed", () => {
  it("lists the active generation with its source, digest and lane", () => {
    const installed = installFromSource(deps, input());
    expect(installed.ok).toBe(true);

    const packages = listInstalledPackages(deps);

    expect(packages).toHaveLength(1);
    const entry = packages[0];
    /*
     * The four facts the marketplace's UI exists to show. Three of them a user cannot check for themselves, and the
     * digest is the one that ties what is running to what was approved.
     */
    expect(entry?.packageId).toBe("com.example.calendar");
    expect(entry?.version).toBe("1.2.0");
    expect(entry?.digest).toBe(DIGEST);
    expect(entry?.source.rationale).toContain("npm com.example.calendar@1.2.0");
    expect(entry?.lane).toBe("isolated-ui");
  });

  it("takes the lane from the plan's isolation rather than the package's own description", () => {
    const installed = installFromSource(deps, input({ isolationPlan: [{ facetKind: "tools", isolation: "trusted-native" }] }));
    expect(installed.ok).toBe(true);

    // A package is as trusted as its least isolated part; a listing that took the publisher's word for it would make
    // the label decorative.
    expect(listInstalledPackages(deps)[0]?.lane).toBe("trusted-native");
  });

  it("reports nothing when nothing is installed, rather than a placeholder", () => {
    expect(listInstalledPackages(deps)).toEqual([]);
  });
});
