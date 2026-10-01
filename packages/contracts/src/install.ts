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

/* ------------------------------------------------------------------ *
 * Facets
 * ------------------------------------------------------------------ */

/**
 * A facet's id. It names a widget definition (`com.example.notes.board@1`) or a service, and a service's id also names
 * the folder its private data lives in and the container it runs in, so it is a single path segment that no platform
 * reads as anything else: no separator, no `.` or `..`, no trailing dot, nothing a command line would split on.
 */
export const facetIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?$/, {
    error: "must be letters, digits, '.', '_', '@' or '-', starting and ending with a letter or digit",
  });
/** A path inside the package. Escapes and remote URLs are refused by `manifestProblems`, not by the shape. */
const packagePathSchema = z.string().min(1).max(300);

/**
 * A widget the package draws in its own isolated frame.
 *
 * `id` is the widget definition's id, and `definition` is the file that holds it: two places saying the same thing,
 * which the reader checks agree, because an instance names the id and the frame is served from the entry.
 */
export const uiFacetSchema = z.strictObject({
  kind: z.literal("ui"),
  id: facetIdSchema,
  entry: packagePathSchema,
  definition: packagePathSchema,
  isolation: z.literal("isolated-ui"),
});

/**
 * One capability a service facet says it provides.
 *
 * Declared in the manifest rather than discovered from the running service, because consent has to show what a
 * package will be able to do *before* any of its code runs. The service is held to this list when it starts: a tool
 * it advertises that is not declared here is not registered, and a declared one it does not advertise is not ready.
 */
export const serviceCapabilityDeclarationSchema = z.strictObject({
  /** The name the service answers to on its own protocol. */
  tool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, { error: "must be a tool name of letters, digits, _ . or -" }),
  /** The capability it becomes. Must live under the package's own id, which `manifestProblems` checks. */
  ref: capabilityRefSchema,
  summary: z.string().min(1).max(400),
  effectCategory: effectCategorySchema,
  /** Absent means the capability remains an ordinary request/response call. */
  execution: z.strictObject({ kind: z.literal("job"), version: z.literal(1) }).optional(),
});
export type ServiceCapabilityDeclaration = z.infer<typeof serviceCapabilityDeclarationSchema>;

/**
 * Code the package runs as a separate process, reached only through the host.
 *
 * The protocol is named rather than assumed so a later transport is a new literal, not a reinterpretation of an old
 * manifest. Today there is one: the Model Context Protocol over the process's standard streams, which opens no port,
 * so nothing on the machine — a widget frame included — can reach the service except through its host.
 */
export const toolsFacetSchema = z.strictObject({
  kind: z.literal("tools"),
  id: facetIdSchema,
  entry: packagePathSchema,
  isolation: z.literal("service"),
  protocol: z.literal("mcp-stdio"),
  capabilities: z.array(serviceCapabilityDeclarationSchema).min(1).max(64),
});
export type ToolsFacet = z.infer<typeof toolsFacetSchema>;

/**
 * A data-only facet: text or configuration a host reads, never runs.
 *
 * Skills and prompts reach the agent as resources, a theme reaches the renderer as tokens, and setup is a declarative
 * flow description. None of them has an executable payload, which is what `declarative` means.
 */
export const declarativeFacetSchema = z.strictObject({
  kind: z.enum(["skills", "prompts", "themes", "setup"]),
  id: facetIdSchema,
  entry: packagePathSchema,
  isolation: z.literal("declarative"),
});

/**
 * Drivers and voice engines.
 *
 * Part of the vocabulary so a manifest can describe them and a listing can show their lane, but no host runs one from
 * a package yet: the reader reports such a facet as declared-but-not-run rather than dropping it or pretending.
 */
export const nativeFacetSchema = z.strictObject({
  kind: z.enum(["driver", "voice"]),
  id: facetIdSchema,
  entry: packagePathSchema,
  isolation: z.enum(["service", "trusted-native"]),
});

export const facetDeclarationSchema = z.discriminatedUnion("kind", [
  uiFacetSchema,
  toolsFacetSchema,
  declarativeFacetSchema,
  nativeFacetSchema,
]);
export type FacetDeclaration = z.infer<typeof facetDeclarationSchema>;

/**
 * Why a declared network origin is not one a package may reach, or `undefined` when it is.
 *
 * A declared origin ends up verbatim in the widget document's `connect-src`, so anything that is not exactly one
 * origin is a way to rewrite the policy: `https://a *` widens it to everything, `https://a; report-uri …` adds a
 * directive, and `https://*.a` is a wildcard by another name. The shape check comes first and is deliberately
 * narrower than a URL parser, because `URL` accepts `;` inside a host and the policy separator is exactly `;`.
 *
 * Plain `http:` and `ws:` are refused except on loopback: a widget talking to a remote host in clear text is a
 * request nobody should have to consent to.
 */
export function networkOriginProblem(value: string): string | undefined {
  const label = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
  const shape = new RegExp(`^(?:https|wss|http|ws)://(?:\\[[0-9a-f:.]+\\]|${label}(?:\\.${label})*)(?::[0-9]{1,5})?$`);
  if (!shape.test(value)) {
    return "must be exactly scheme://host[:port]: no wildcard, path, query, credentials, whitespace or separators";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.origin !== value) return `must be written in its canonical form, ${url.origin}`;
  const encrypted = url.protocol === "https:" || url.protocol === "wss:";
  if (!encrypted && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return "must use https or wss unless it is a loopback address";
  }
  return undefined;
}

/** One origin a package may reach, in the exact form a CSP source expression takes. */
export const networkOriginSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => networkOriginProblem(value) === undefined, {
    error: (issue) => `network origin ${JSON.stringify(issue.input)} ${networkOriginProblem(String(issue.input)) ?? "is invalid"}`,
  });

/**
 * The version of the manifest format this file describes.
 *
 * `1` was the widget-only manifest `clark widget` scaffolded before a package could carry anything but widgets. It is
 * still read — a package installed under it keeps working — but only by `normalizeWidgetManifestV1` in core, which
 * presents it in this shape. Nothing writes `1` any more.
 */
export const PACKAGE_MANIFEST_SCHEMA_VERSION = 2;

/** The most facets one package manifest may declare. */
export const MAX_PACKAGE_FACETS = 64;

/**
 * The one manifest a ClarkCant package has, at its root as `clarkcant.json`.
 *
 * One identity, one version, one digest for the whole package, while each facet keeps its own execution lane and
 * lifecycle: a UI facet updates without touching a service, a skill reloads without restarting a worker.
 */
export const packageManifestSchema = z.strictObject({
  schemaVersion: z.literal(PACKAGE_MANIFEST_SCHEMA_VERSION),
  id: z.string().min(1).max(160),
  version: semverSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().min(1).max(600),
  /** Host API range the package was built against. */
  hostApi: z
    .strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() })
    .refine((range) => range.min <= range.max, { error: "hostApi.min must not exceed hostApi.max" }),
  facets: z.array(facetDeclarationSchema).min(1).max(MAX_PACKAGE_FACETS),
  /**
   * What the package would like to be allowed to do. These are requests.
   * The install record stores what was actually granted, which may be narrower.
   */
  requestedCapabilities: z.array(capabilityRefSchema).max(128),
  permissions: z.strictObject({
    /** Exact origins the package may reach. Empty means no network egress. */
    networkOrigins: z.array(networkOriginSchema).max(64),
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
    .max(256)
    .default([]),
});
export type PackageManifest = z.infer<typeof packageManifestSchema>;

/**
 * What the shape cannot say about a manifest: rules that relate one field to another.
 *
 * Kept apart from the schema so a reader can report every problem at once, with the field named, rather than stop at
 * the first refinement that failed. Empty means the manifest is coherent; it still grants nothing.
 */
/** The first segments of the capability refs the node registers itself; a package's capabilities never start with one. */
export const RESERVED_CAPABILITY_NAMESPACES: readonly string[] = ["canvas", "clarkcant", "dev", "mcp", "project"];

/** The shape of a package id its capability refs can be named under: the ref pattern without the `name@n` tail. */
const CAPABILITY_NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;

export function manifestProblems(manifest: PackageManifest): string[] {
  const problems: string[] = [];

  const ids = manifest.facets.map((facet) => facet.id);
  for (const id of new Set(ids)) {
    if (ids.filter((candidate) => candidate === id).length > 1) problems.push(`facets: id "${id}" is declared twice`);
  }

  for (const facet of manifest.facets) {
    const paths = facet.kind === "ui" ? [facet.entry, facet.definition] : [facet.entry];
    for (const path of paths) {
      // A drive letter is checked before the URL shape, which `C:` also matches.
      if (/^[a-z]:/i.test(path) || path.startsWith("/") || path.startsWith("\\") || path.split(/[\\/]/).includes("..")) {
        problems.push(`facet ${facet.id}: ${path} escapes the package root`);
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
        problems.push(`facet ${facet.id}: ${path} is a URL; a facet's files must be inside the package`);
      }
    }
  }

  /*
   * A package that provides capabilities names them under its own id, so the id has to be one that cannot collide with
   * a name the node already gives out: a reverse-DNS id of at least two segments, outside the namespaces the node's own
   * capabilities use. Without that, a package with the id `project` could declare `project.code.change@1`.
   */
  if (manifest.facets.some((facet) => facet.kind === "tools")) {
    if (!CAPABILITY_NAMESPACE_PATTERN.test(manifest.id)) {
      problems.push(
        `id: ${manifest.id} must be a reverse-DNS name of at least two lowercase segments, such as com.example.notes, to provide capabilities`,
      );
    } else if (RESERVED_CAPABILITY_NAMESPACES.includes(manifest.id.split(".")[0] ?? "")) {
      problems.push(`id: ${manifest.id} is under ${manifest.id.split(".")[0] ?? ""}, which the node's own capabilities use`);
    }
  }

  const refs = new Set<string>();
  for (const facet of manifest.facets) {
    if (facet.kind !== "tools") continue;
    const tools = new Set<string>();
    for (const capability of facet.capabilities) {
      /*
       * A package names capabilities in its own namespace only. Without this, a package could declare
       * `google.calendar.events.delete@1` and sit in the registry under a name users and policies already trust.
       */
      if (!capability.ref.startsWith(`${manifest.id}.`)) {
        problems.push(`facet ${facet.id}: capability ${capability.ref} must be named under the package id, as ${manifest.id}.<name>@<n>`);
      }
      if (refs.has(capability.ref)) problems.push(`facet ${facet.id}: capability ${capability.ref} is declared twice`);
      refs.add(capability.ref);
      if (tools.has(capability.tool)) problems.push(`facet ${facet.id}: tool ${capability.tool} is declared twice`);
      tools.add(capability.tool);
    }
  }

  return problems;
}

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
 * Grouped by name and compared version by version inside the name, because one pin per name is not what the
 * comparison is about: keyed by name alone, a consent that covered `[left-pad@1.2.5, left-pad@1.3.0]` and a
 * closure holding only `[left-pad@1.3.0]` collapsed to one entry each and compared equal.
 *
 * "the lock changed" is not actionable; "left-pad resolved to 1.3.0 (sha256:…) but consent covered 1.2.0
 * (sha256:…)" is, and it is the sentence somebody has to act on when a build refuses to start.
 */
export function dependencyDrift(
  consented: readonly PinnedArtifact[],
  current: readonly PinnedArtifact[],
): string[] {
  const differences: string[] = [];
  const names = [...new Set([...consented, ...current].map((pin) => pin.name))].sort();

  for (const name of names) {
    const before = uniquePins(consented.filter((pin) => pin.name === name));
    const after = uniquePins(current.filter((pin) => pin.name === name));

    if (before.length === 0) {
      for (const pin of after) {
        differences.push(`dependency "${name}" resolved to ${pin.version} and was not in the consented closure`);
      }
      continue;
    }
    if (after.length === 0) {
      for (const pin of before) {
        differences.push(`dependency "${name}" was pinned at ${pin.version} and is no longer in the closure`);
      }
      continue;
    }

    const beforeVersions = [...new Set(before.map((pin) => pin.version))].sort();
    const afterVersions = [...new Set(after.map((pin) => pin.version))].sort();
    if (beforeVersions.join(",") !== afterVersions.join(",")) {
      differences.push(
        `dependency "${name}" resolved to ${versionsNamed(after, afterVersions)} but consent covered ${versionsNamed(before, beforeVersions)}`,
      );
    }

    for (const pinned of before) {
      // A version the closure no longer holds is already named by the line above; only one that is still there can
      // be compared further.
      const now = after.find((candidate) => candidate.version === pinned.version);
      if (now === undefined) continue;
      if (now.integrity !== pinned.integrity) {
        differences.push(
          `dependency "${name}" resolved to ${now.version} (${now.integrity}) but consent covered ${pinned.version} (${pinned.integrity})`,
        );
        continue;
      }
      if (now.resolvedFrom !== pinned.resolvedFrom) {
        differences.push(`dependency "${name}" now comes from ${now.resolvedFrom}, not ${pinned.resolvedFrom}`);
      }
    }
  }

  return differences;
}

/** The distinct pins in one name's rows, so a duplicated row is compared once rather than reported twice. */
function uniquePins(pins: readonly PinnedArtifact[]): PinnedArtifact[] {
  const seen = new Map<string, PinnedArtifact>();
  for (const pin of pins) seen.set(`${pin.version}\u0000${pin.integrity}\u0000${pin.resolvedFrom}`, pin);
  return [...seen.values()];
}

/** One version prints with its integrity, because that is what a decision needs; several are listed by version. */
function versionsNamed(pins: readonly PinnedArtifact[], versions: readonly string[]): string {
  if (versions.length === 1) {
    const only = pins.find((pin) => pin.version === versions[0]);
    if (only !== undefined) return `${only.version} (${only.integrity})`;
  }
  return versions.join(", ");
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
  /**
   * The capabilities actually granted to this generation, carried from the consented plan.
   *
   * Requested and granted are recorded as two different facts everywhere else in this file, and a
   * generation is where a widget frame's own broker reads its answer — so the generation carries the
   * narrower one rather than making a caller re-fetch the plan (which may since have been superseded by
   * a different requirement) to find out what was actually approved.
   */
  grantedCapabilities: z.array(capabilityRefSchema).max(128),
  /**
   * The ids of the widgets (`ui` facets) the package declared when this generation was installed.
   *
   * Uninstall and restore find a package's widget instances by these ids, and the package's files are not always on
   * this node by then: a fetched copy can leave the cache, a local folder can move. Recording them here means the
   * answer does not depend on reading those files again. Absent on a generation installed before this was kept.
   *
   * Up to two ids per facet: the facet's own id and, when its definition names a different one (which the reader
   * reports but does not refuse), the definition's, since that is the id an instance records.
   */
  widgetIds: z.array(z.string().min(1).max(160)).max(MAX_PACKAGE_FACETS * 2).optional(),
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
