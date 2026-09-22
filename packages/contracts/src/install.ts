import { z } from "zod";

import { effectCategorySchema, instantSchema, platformSchema, principalIdSchema, semverSchema } from "./primitives.ts";
import { capabilityRefSchema } from "./grants.ts";

/**
 * Capability packages and their install lifecycle.
 *
 * The central rule: a package README is untrusted input. Everything a package
 * asks for is a *request* that the install supervisor validates against policy
 * and the user approves by digest. Nothing in a manifest can create authority.
 */

/** Facets let an update touch one part of the app without restarting everything. */
export const facetKindSchema = z.enum([
  "tools",
  "ui",
  "skills",
  "prompts",
  "themes",
  "setup",
  "driver",
  "voice",
]);
export type FacetKind = z.infer<typeof facetKindSchema>;

/**
 * How a facet's code will be executed. This is the classification that decides
 * whether untrusted code may run at all, so it is never inferred from the
 * package's own claims — it is declared, validated, and shown at consent time.
 */
export const isolationClassSchema = z.enum([
  /** Declarative resource: data only, no executable payload. */
  "declarative",
  /** Runs in a separate service process with brokered data and connection refs. */
  "service",
  /** Isolated origin; no Node, no filesystem, no host cookies. */
  "isolated-ui",
  /** Arbitrary code with full worker privileges. Requires explicit trusted mode. */
  "trusted-native",
]);
export type IsolationClass = z.infer<typeof isolationClassSchema>;

export const facetDeclarationSchema = z.strictObject({
  kind: facetKindSchema,
  entry: z.string().min(1).max(300),
  isolation: isolationClassSchema,
  /** Only meaningful for `ui` facets. */
  widgetId: z.string().min(1).max(160).optional(),
  renderer: z.enum(["catalog", "isolated-app", "mcp-app"]).optional(),
});

export const packageManifestSchema = z.strictObject({
  id: z.string().min(1).max(160),
  version: semverSchema,
  /** Host API range the package was built against. */
  hostApi: z
    .strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() })
    .refine((range) => range.min <= range.max, { error: "hostApi.min must not exceed hostApi.max" }),
  facets: z.array(facetDeclarationSchema).min(1).max(64),
  /**
   * What the package would like to be allowed to do. These are requests.
   * The install record stores what was actually granted, which may be narrower.
   */
  requestedCapabilities: z.array(capabilityRefSchema).max(128),
  permissions: z.strictObject({
    /** Exact origins the package may reach. Empty means no network egress. */
    networkOrigins: z.array(z.string().min(1).max(300)).max(64),
    filesystem: z
      .array(
        z.strictObject({
          /** Manifest paths are relative and are resolved under a package-private root. */
          path: z.string().min(1).max(300),
          access: z.enum(["read", "write"]),
        }),
      )
      .max(64),
    microphone: z.boolean(),
    camera: z.boolean(),
    /** Declares that load-time code runs. Never auto-approved. */
    lifecycleScripts: z.array(z.string().min(1).max(300)).max(32),
  }),
  platforms: z.array(platformSchema).min(1),
  /** Declared by the publisher; verified against the actual artifact, never trusted alone. */
  publisher: z
    .strictObject({
      id: z.string().min(1).max(200),
      sourceUrl: z.string().min(1).max(500),
      license: z.string().min(1).max(120),
      signature: z.string().min(1).max(400).optional(),
    })
    .optional(),
  dependencies: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(160),
        /** Exact version. A range would make the install unreproducible. */
        version: semverSchema,
      }),
    )
    .max(256),
});
export type PackageManifest = z.infer<typeof packageManifestSchema>;

/* ------------------------------------------------------------------ *
 * Install plan
 * ------------------------------------------------------------------ */

export const installCandidateSchema = z.strictObject({
  id: z.string().min(1).max(160),
  version: semverSchema,
  /** Where the artifact will come from, resolved to an exact URL. */
  artifactUrl: z.string().min(1).max(1000),
  digest: z.string().min(1).max(120),
  /** Why this candidate was chosen over the others, including the source. */
  rationale: z.string().min(1).max(1000),
  /**
   * Trust tier the resolver assigned. Ordered strongest first, and the UI shows
   * which one applied so "found on the internet" is never dressed up as
   * "first-party".
   */
  sourceTier: z.enum([
    "already-installed",
    "first-party-recipe",
    "curated-registry",
    "public-research",
    "built-in-workspace",
  ]),
});

/* ------------------------------------------------------------------ *
 * Frozen build input
 * ------------------------------------------------------------------ */

/**
 * Which kind of source a pin came from.
 *
 * The three do not resolve the same way and are not interchangeable: an npm version is a registry entry, a git ref
 * is a commit in somebody else's repository, and a local path is bytes on this machine that no registry ever saw.
 */
export const dependencyProvenanceSchema = z.enum(["npm", "git", "local"]);
export type DependencyProvenance = z.infer<typeof dependencyProvenanceSchema>;

/**
 * One artifact, pinned to an exact version and an integrity.
 *
 * `resolvedFrom` is where the bytes come from, in the vocabulary of the source that resolved them:
 * `npm:<name>@<version>`, `git:<url>#<ref>`, `local:<path>`. Recorded rather than derived from the version, because
 * a closure that flattened the three into one version number would make a registry tarball and a checkout on this
 * machine look like the same claim.
 */
export const pinnedArtifactSchema = z.strictObject({
  name: z.string().min(1).max(160),
  version: semverSchema,
  integrity: z.string().min(1).max(120),
  resolvedFrom: z.string().min(1).max(400),
});
export type PinnedArtifact = z.infer<typeof pinnedArtifactSchema>;

/**
 * How much of the build input a lock covers.
 *
 * `artifact-only` exists so that a partial resolution is representable without being mistakable for a frozen tree:
 * a build has to refuse it rather than read it as "the dependencies are pinned".
 */
export const dependencyLockCoverageSchema = z.enum(["artifact-only", "artifact-and-dependencies"]);
export type DependencyLockCoverage = z.infer<typeof dependencyLockCoverageSchema>;

/**
 * The frozen build input a plan and its generation carry.
 *
 * Bound to consent alongside the plan digest, and separate from it: the plan digest answers "is this the plan that
 * was approved", this answers "is this the closure that was approved". A build reads the artifact the reference
 * names and never the package manager's own metadata.
 */
export const dependencyLockBindingSchema = z.strictObject({
  lockRef: z.string().min(1).max(300),
  lockDigest: z.string().min(1).max(120),
  coverage: dependencyLockCoverageSchema,
  dependencies: z.array(pinnedArtifactSchema).max(256),
});
export type DependencyLockBinding = z.infer<typeof dependencyLockBindingSchema>;

/**
 * What moved between two pinned sets, in lines that name the artifact rather than the field.
 *
 * "the lock changed" is not actionable; "left-pad resolved to 1.3.0 (sha256:…) but consent covered 1.2.0
 * (sha256:…)" is, and it is the sentence somebody has to act on when a build refuses to start.
 */
export function dependencyDrift(
  consented: readonly PinnedArtifact[],
  current: readonly PinnedArtifact[],
): string[] {
  const before = new Map(consented.map((pin) => [pin.name, pin]));
  const after = new Map(current.map((pin) => [pin.name, pin]));
  const differences: string[] = [];
  for (const [name, pinned] of before) {
    const now = after.get(name);
    if (now === undefined) {
      differences.push(`dependency "${name}" was pinned at ${pinned.version} and is no longer in the closure`);
      continue;
    }
    if (now.version !== pinned.version || now.integrity !== pinned.integrity) {
      differences.push(
        `dependency "${name}" resolved to ${now.version} (${now.integrity}) but consent covered ${pinned.version} (${pinned.integrity})`,
      );
      continue;
    }
    if (now.resolvedFrom !== pinned.resolvedFrom) {
      differences.push(`dependency "${name}" now comes from ${now.resolvedFrom}, not ${pinned.resolvedFrom}`);
    }
  }
  for (const [name, pinned] of after) {
    if (!before.has(name)) {
      differences.push(`dependency "${name}" resolved to ${pinned.version} and was not in the consented closure`);
    }
  }
  return differences;
}

/** The plan's dependency rows as pins, so the comparison above is one implementation rather than two. */
export function pinnedFromPlan(plan: InstallPlan): PinnedArtifact[] {
  return plan.resolvedDependencies.map((dependency) => ({
    name: dependency.id,
    version: dependency.version,
    integrity: dependency.digest,
    resolvedFrom: dependency.resolvedFrom,
  }));
}

/**
 * Whether a plan already on this node froze the same build input as the one in front of it.
 *
 * Named lines rather than booleans, because the caller has to tell a person which dependency moved. A lock that was
 * present on one side and absent on the other is a difference too: a plan consented with a frozen closure must not
 * be joined by a resolution that froze nothing.
 */
export function lockDriftBetween(consented: InstallPlan, current: InstallPlan): string[] {
  const differences: string[] = [];
  if (consented.lockRef !== current.lockRef) {
    differences.push(
      `the frozen build input was ${consented.lockRef ?? "not resolved"} and is now ${current.lockRef ?? "not resolved"}`,
    );
  }
  if (consented.lockCoverage !== current.lockCoverage) {
    differences.push(
      `the lock covered ${consented.lockCoverage ?? "nothing"} and now covers ${current.lockCoverage ?? "nothing"}`,
    );
  }
  if (consented.lockDigest !== current.lockDigest && consented.lockRef === current.lockRef) {
    differences.push(
      `the lock digest changed from ${consented.lockDigest ?? "none"} to ${current.lockDigest ?? "none"}`,
    );
  }
  differences.push(...dependencyDrift(pinnedFromPlan(consented), pinnedFromPlan(current)));
  return differences;
}

/**
 * Whether a plan was recorded before this node froze a build input.
 *
 * A plan written before that existed carries no reference, no digest and no coverage, because there was nothing to
 * record. Compared with a plan that does carry one it looks like drift — `lockCoverage` moved from "nothing" to a
 * coverage — but nothing moved: the comparison has one side missing. The refusal is the same either way, and this
 * exists so the sentence a person reads can name the real cause instead of sending them to review a closure that
 * was never recorded.
 */
export function planPredatesFrozenBuildInput(plan: InstallPlan): boolean {
  return plan.lockRef === undefined && plan.lockDigest === undefined && plan.lockCoverage === undefined;
}

export const installPlanSchema = z
  .strictObject({
    planId: z.string().min(1).max(128),
  ownerPrincipalId: principalIdSchema,
  /** One plan per (capability, node): two tasks needing the same pack share it. */
  requirementKey: z.string().min(1).max(300),
  requestedCapabilityRefs: z.array(capabilityRefSchema).min(1).max(64),
  candidate: installCandidateSchema,
  resolvedDependencies: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(160),
        version: semverSchema,
        digest: z.string().min(1).max(120),
        /** Where these bytes come from; see `pinnedArtifactSchema` for why the three kinds are kept apart. */
        resolvedFrom: z.string().min(1).max(400),
      }),
    )
    .max(256),
  targetNodeId: z.string().min(1).max(128),
  /** Grants the package will receive if activated. Narrower than requested. */
  grantedCapabilities: z.array(capabilityRefSchema).max(128),
  /** Effects the package may perform, derived from its granted capabilities. */
  effectCategories: z.array(effectCategorySchema).max(16),
  /** Data recipients, so the user can see where data would go. */
  dataRecipients: z.array(z.string().min(1).max(300)).max(64),
  estimatedResources: z
    .strictObject({
      downloadBytes: z.int().nonnegative().optional(),
      diskBytes: z.int().nonnegative().optional(),
      memoryBytes: z.int().nonnegative().optional(),
    })
    .optional(),
  /**
   * SHA-256 over the canonical JSON of the plan body. Consent is bound to this
   * digest, so changing source, version, node, or grants invalidates the
   * approval rather than silently reusing it (acceptance tests T21).
   */
  planDigest: z.string().min(1).max(120),
  /** Isolation the supervisor will actually apply per facet. */
  isolationPlan: z.array(
    z.strictObject({ facetKind: facetKindSchema, isolation: isolationClassSchema }),
  ),
  /**
   * The frozen build input this plan was consented to, when one was resolved.
   *
   * Absent means "no closure was frozen", which is a state a plan may honestly be in and is not the same as an
   * empty closure: a build refuses a plan without the three fields below rather than resolving one itself.
   */
  lockRef: z.string().min(1).max(300).optional(),
  lockDigest: z.string().min(1).max(120).optional(),
  lockCoverage: dependencyLockCoverageSchema.optional(),
  createdAt: instantSchema,
  expiresAt: instantSchema,
})
  /*
   * A lock reference without a digest, or a digest without what it covers, describes nothing a build could check.
   * The three travel together or not at all.
   */
  .refine(
    (plan) =>
      (plan.lockRef === undefined) === (plan.lockDigest === undefined) &&
      (plan.lockRef === undefined) === (plan.lockCoverage === undefined),
    { error: "a plan's lockRef, lockDigest and lockCoverage are present together or absent together" },
  );
export type InstallPlan = z.infer<typeof installPlanSchema>;

/**
 * Facts that, when changed, invalidate a prior consent.
 *
 * Consent to "install version 1.2.0 from this URL on this node with these
 * grants" is meaningless if any one of those moved. Comparing the tuple is
 * cheaper and more auditable than re-deriving it.
 */
export function consentStillValid(
  consented: InstallPlan,
  current: InstallPlan,
): { valid: true } | { valid: false; changed: string[]; detail: string[] } {
  const changed: string[] = [];
  if (consented.candidate.artifactUrl !== current.candidate.artifactUrl) changed.push("artifactUrl");
  if (consented.candidate.digest !== current.candidate.digest) changed.push("digest");
  if (consented.candidate.version !== current.candidate.version) changed.push("version");
  if (consented.targetNodeId !== current.targetNodeId) changed.push("targetNodeId");
  if (consented.planDigest !== current.planDigest) changed.push("planDigest");
  if (consented.lockRef !== current.lockRef) changed.push("lockRef");
  if (consented.lockDigest !== current.lockDigest) changed.push("lockDigest");
  if (consented.lockCoverage !== current.lockCoverage) changed.push("lockCoverage");
  if (
    consented.grantedCapabilities.slice().sort().join(",") !==
    current.grantedCapabilities.slice().sort().join(",")
  ) {
    changed.push("grantedCapabilities");
  }
  /*
   * The dependency lines are computed from the pins rather than from a joined string, so the refusal can name the
   * dependency that moved. "resolvedDependencies changed" is a field; "left-pad resolved to 1.3.0 but consent
   * covered 1.2.0" is the sentence somebody can act on.
   */
  const lockLines = lockDriftBetween(consented, current);
  if (lockLines.some((line) => line.startsWith("dependency "))) changed.push("resolvedDependencies");
  return changed.length === 0 ? { valid: true } : { valid: false, changed, detail: lockLines };
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export const installStateSchema = z.enum([
  "discovered",
  "proposed",
  "consented",
  "declined",
  "staging",
  "validating",
  "waiting_auth",
  "ready_to_activate",
  "draining",
  "activating",
  "healthchecking",
  "active",
  "continuation_ready",
  "rolling_back",
  "failed",
  "cancelled",
]);
export type InstallState = z.infer<typeof installStateSchema>;

const INSTALL_TRANSITIONS: Record<InstallState, readonly InstallState[]> = {
  discovered: ["proposed", "cancelled"],
  proposed: ["consented", "declined", "cancelled"],
  consented: ["staging", "cancelled"],
  staging: ["validating", "failed", "cancelled"],
  validating: ["waiting_auth", "ready_to_activate", "failed", "cancelled"],
  waiting_auth: ["validating", "failed", "cancelled"],
  ready_to_activate: ["draining", "cancelled"],
  draining: ["activating", "failed", "cancelled"],
  activating: ["healthchecking", "rolling_back", "failed"],
  healthchecking: ["active", "rolling_back", "failed"],
  active: ["continuation_ready", "rolling_back"],
  continuation_ready: ["rolling_back"],
  rolling_back: ["failed"],
  declined: ["proposed"],
  failed: ["staging"],
  cancelled: [],
};

export function canTransitionInstall(from: InstallState, to: InstallState): boolean {
  return INSTALL_TRANSITIONS[from].includes(to);
}

export function legalInstallTargets(from: InstallState): InstallState[] {
  return [...INSTALL_TRANSITIONS[from]];
}

/**
 * Whether a package that failed at this stage left the previous generation
 * usable. Failure during `staging`/`validating`/`waiting_auth` never touched the
 * active generation, and even `activating`/`healthchecking` must roll back to
 * the generation that was serving before (acceptance test T26).
 */
export function previousGenerationSurvives(failedAt: InstallState): boolean {
  return (
    failedAt === "staging" ||
    failedAt === "validating" ||
    failedAt === "waiting_auth" ||
    failedAt === "draining" ||
    failedAt === "activating" ||
    failedAt === "healthchecking" ||
    failedAt === "rolling_back"
  );
}

/* ------------------------------------------------------------------ *
 * Generations
 * ------------------------------------------------------------------ */

export const packageGenerationSchema = z.strictObject({
  generationId: z.string().min(1).max(200),
  packageId: z.string().min(1).max(160),
  version: semverSchema,
  digest: z.string().min(1).max(120),
  nodeId: z.string().min(1).max(128),
  /**
   * Code generation of the package itself. Bumped whenever facet code changes,
   * which is what forces a worker handoff rather than a resource refresh.
   */
  codeGeneration: z.string().min(1).max(200),
  /**
   * The frozen build input this generation was activated against.
   *
   * Carried on the generation rather than looked up from the plan, because what is running and what was consented to
   * are two different rows: a superseded plan must not be able to change the answer for a live generation.
   */
  lockRef: z.string().min(1).max(300).optional(),
  lockDigest: z.string().min(1).max(120).optional(),
  lockCoverage: dependencyLockCoverageSchema.optional(),
  activatedAt: instantSchema,
  /** A generation stays addressable after replacement so rollback is possible. */
  supersededAt: instantSchema.optional(),
  /** Facets whose refresh scope is limited to the UI — no Pi restart needed. */
  uiOnlyFacets: z.array(z.string().min(1).max(160)).max(64),
});
export type PackageGeneration = z.infer<typeof packageGenerationSchema>;

/**
 * What must be refreshed for a given change, derived from the facet classification
 * rather than from whichever reload path is most convenient.
 *
 * Restarting Pi for a CSS change is the failure this function exists to prevent
 * (acceptance test T24).
 */
export function requiredRefreshScope(change: {
  facetKinds: readonly FacetKind[];
  nativeExtensionChanged: boolean;
  skillOrPromptChanged: boolean;
}): "none" | "ui" | "tool-service" | "pi-resources" | "pi-worker" {
  if (change.nativeExtensionChanged) return "pi-worker";
  if (change.skillOrPromptChanged) return "pi-resources";
  const kinds = new Set(change.facetKinds);
  if (kinds.size === 0) return "none";
  if (kinds.has("driver")) return "tool-service";
  if (kinds.has("tools")) return "tool-service";
  if (kinds.has("voice")) return "tool-service";
  if (kinds.has("ui") || kinds.has("themes")) return "ui";
  if (kinds.has("skills") || kinds.has("prompts") || kinds.has("setup")) return "pi-resources";
  return "none";
}
