import { z } from "zod";

import { capabilityReadinessSchema, capabilityRefSchema } from "./grants.ts";
import { absoluteHostPathSchema } from "./host-path.ts";
import { networkOriginProblem, networkOriginSchema } from "./network-origin.ts";
import {
  capabilityCandidateIdSchema,
  digestSchema,
  discoveryProviderIdSchema,
  instantSchema,
  nodeIdSchema,
  runtimeIdSchema,
  semverSchema,
} from "./primitives.ts";
import type { AcquisitionPlan } from "./reach-expansion.ts";

/**
 * What discovery finds: candidates that might close a capability gap, from wherever they were found.
 *
 * One shape for every source — this node, an agent runtime installed beside it, a paired node, an installed package,
 * a directory, a known endpoint, the Internet — so the Main agent asks one question ("what could help with X?") rather
 * than one per provider. A provider is replaceable: the contract assumes no particular directory, protocol or format is
 * the last one.
 *
 * A candidate is information, never authority. Nothing in it grants, enables or installs anything, and it carries no
 * field that could: what a candidate would need is said in its requirements and, when acquiring it is possible, in an
 * acquisition plan the person consents to. How it may be acquired is restricted to forms the host can verify — exact
 * package coordinates, a pinned revision, a digested artifact, a known endpoint — so a page that says
 * `curl … | sudo bash` has no way to become a candidate's acquisition.
 */

/** The version of the candidate and the query. */
export const CAPABILITY_DISCOVERY_VERSION = 1;

/**
 * Where a candidate was found, in the order a gap is resolved: what is already granted first, the open Internet last.
 * The order is the default preference for least new reach; a ranking strategy may weigh more than this.
 */
export const CAPABILITY_SOURCES = [
  "granted",
  "local",
  "runtime",
  "peer",
  "package",
  "directory",
  "known-endpoint",
  "internet",
] as const;
export const capabilitySourceSchema = z.enum(CAPABILITY_SOURCES);
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;

/** What kind of thing the candidate is. */
export const capabilityFormSchema = z.enum([
  "capability",
  "package",
  "skill",
  "extension",
  "mcp-server",
  "webmcp",
  "api",
  "cli",
  "runtime",
  "browser",
  "computer",
]);
export type CapabilityForm = z.infer<typeof capabilityFormSchema>;

/**
 * How much the metadata is worth. `verified`: the host checked it against bytes or a live endpoint itself.
 * `publisher-claimed`: a directory or registry says so on the publisher's behalf. `unverified`: nobody vouches for it.
 */
export const provenanceTrustSchema = z.enum(["verified", "publisher-claimed", "unverified"]);
export type ProvenanceTrust = z.infer<typeof provenanceTrustSchema>;

export const candidateProvenanceSchema = z.strictObject({
  /** The discovery provider that produced the candidate. */
  providerId: discoveryProviderIdSchema,
  /** Where the metadata came from: a URL, a directory name, `local`. Said to the person as it is. */
  origin: z.string().min(1).max(500),
  trust: provenanceTrustSchema,
  /** The digest the metadata was checked against, when it was. */
  digest: digestSchema.optional(),
  observedAt: instantSchema,
});
export type CandidateProvenance = z.infer<typeof candidateProvenanceSchema>;

/**
 * Why an address is not one an acquisition may read from, or `undefined` when it is: encrypted unless it is this
 * machine, and with no credentials in it, because the URL is shown to the person and stored with the plan. Never
 * throws: what discovery found is untrusted, and a malformed address is a refusal, not an exception.
 */
export function acquisitionUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.username !== "" || url.password !== "") return "must not carry credentials";
  const origin = networkOriginProblem(url.origin);
  return origin === undefined ? undefined : `has an origin that ${origin}`;
}

export const acquisitionUrlSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => acquisitionUrlProblem(value) === undefined, {
    error: (issue) => `address ${JSON.stringify(issue.input)} ${acquisitionUrlProblem(String(issue.input)) ?? "is invalid"}`,
  });

/** An npm package name: optional scope, lower case, no path tricks, at most 214 characters as npm allows. */
export const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** A full git commit id (SHA-1 or SHA-256). A branch or tag names a moving target; a commit does not. */
export const GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A package in a form that names exactly one set of bytes: an absolute local path, an https git repository at a full
 * commit id, or an npm package at an exact version. A subset of `PackageSource`, so an acquisition goes through the
 * existing install path unchanged.
 *
 * A tag, a branch or a version range is refused rather than resolved: turning a tag into its commit is the resolver's
 * job (external discovery providers), and it does so before the candidate is offered, so the plan a person consents to
 * names the commit.
 */
export const verifiablePackageSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("local"), path: absoluteHostPathSchema }),
  z.strictObject({
    kind: z.literal("git"),
    url: acquisitionUrlSchema.refine((value) => value.startsWith("https://"), { error: "a git repository is read over https" }),
    ref: z.string().regex(GIT_COMMIT_PATTERN, { error: "must be a full commit id, not a branch, tag or short id" }),
  }),
  z.strictObject({
    kind: z.literal("npm"),
    name: z.string().max(214).regex(NPM_PACKAGE_NAME_PATTERN, { error: "must be an npm package name" }),
    version: semverSchema,
  }),
]);
export type VerifiablePackageSource = z.infer<typeof verifiablePackageSourceSchema>;

/** The package managers a command-line tool may be acquired from. One per platform family, plus language registries. */
export const cliPackageManagerSchema = z.enum([
  "npm",
  "pypi",
  "cargo",
  "go",
  "homebrew",
  "winget",
  "scoop",
  "apt",
  "dnf",
  "pacman",
]);
export type CliPackageManager = z.infer<typeof cliPackageManagerSchema>;

/**
 * A package name a manager could hold: an optional leading `@` (an npm scope), then a letter or digit, then only name
 * characters. No whitespace, no leading `-` (which a command line reads as an option), no shell metacharacters, and no
 * `@` after the first character, because `name@ref` (`x@latest`, `github.com/x/y@main`) smuggles a moving version past
 * the exact `version` field. Each manager's own naming rules are the resolver's to check.
 */
export const CLI_PACKAGE_NAME_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._/+-]*$/;

/**
 * An exact version: at least `major.minor`, an optional leading `v` (Go modules) and an optional build or revision
 * suffix (`1.2.3-1`, `1.2.3_1`). Ranges, tags such as `latest` and anything with whitespace are refused.
 */
export const EXACT_VERSION_PATTERN = /^v?\d+(?:\.\d+){1,3}(?:[-+_][0-9A-Za-z.+_-]+)?$/;

/**
 * The verifiable forms a candidate may be acquired in. There is deliberately no form for a command to run or a script
 * to download: an instruction found somewhere is never an acquisition.
 */
export const acquisitionSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("package"), source: verifiablePackageSourceSchema }),
  /** A downloadable artifact pinned by digest. */
  z.strictObject({ kind: z.literal("artifact"), url: acquisitionUrlSchema, digest: digestSchema }),
  /** A command-line tool from a known package manager, at an exact version. */
  z.strictObject({
    kind: z.literal("cli-package"),
    manager: cliPackageManagerSchema,
    name: z.string().max(200).regex(CLI_PACKAGE_NAME_PATTERN, { error: "must be a package name, not an option or a command" }),
    version: z.string().max(80).regex(EXACT_VERSION_PATTERN, { error: "must be an exact version, not a range or a tag" }),
  }),
  z.strictObject({ kind: z.literal("mcp-endpoint"), url: acquisitionUrlSchema }),
  z.strictObject({ kind: z.literal("webmcp"), origin: networkOriginSchema }),
  /** An API described by an OpenAPI document, pinned by digest when the document was read. */
  z.strictObject({ kind: z.literal("openapi"), url: acquisitionUrlSchema, digest: digestSchema.optional() }),
]);
export type AcquisitionSource = z.infer<typeof acquisitionSourceSchema>;

/**
 * How far the candidate is from usable. `available`: usable inside what is already granted. The others each need a
 * step that widens reach, and so a plan the person consents to.
 */
export const candidateAvailabilitySchema = z.enum([
  "available",
  "needs-enable",
  "needs-connection",
  "needs-acquisition",
  "unavailable",
]);
export type CandidateAvailability = z.infer<typeof candidateAvailabilitySchema>;

/** The sources whose candidates are not on this node yet, so cannot already be available. */
const REMOTE_SOURCES: readonly CapabilitySource[] = ["directory", "known-endpoint", "internet"];

export const capabilityCandidateSchema = z
  .strictObject({
    version: z.literal(CAPABILITY_DISCOVERY_VERSION),
    candidateId: capabilityCandidateIdSchema,
    source: capabilitySourceSchema,
    form: capabilityFormSchema,
    title: z.string().min(1).max(120),
    summary: z.string().min(1).max(500),
    /** The capabilities it would provide, when they are known. */
    provides: z.array(capabilityRefSchema).max(16).optional(),
    availability: candidateAvailabilitySchema,
    /** Readiness, for a candidate already on a node. */
    readiness: capabilityReadinessSchema.optional(),
    /** Where it runs, when that is known: a node, or an agent runtime on a node. */
    location: z
      .strictObject({ nodeId: nodeIdSchema, runtimeId: runtimeIdSchema.optional() })
      .optional(),
    /** What using it would need, so candidates can be ordered by least new reach. Facts, not permission. */
    requires: z.strictObject({
      install: z.boolean(),
      credential: z.boolean(),
      networkOrigins: z.array(networkOriginSchema).max(16),
    }),
    acquisition: acquisitionSourceSchema.optional(),
    provenance: candidateProvenanceSchema,
  })
  .superRefine((candidate, ctx) => {
    if (REMOTE_SOURCES.includes(candidate.source) && candidate.availability === "available") {
      ctx.addIssue({
        code: "custom",
        path: ["availability"],
        message: `a candidate found in ${candidate.source} is not on this node, so it cannot already be available`,
      });
    }
    if (candidate.availability === "available" && (candidate.requires.install || candidate.requires.credential)) {
      ctx.addIssue({
        code: "custom",
        path: ["availability"],
        message: "a candidate that still needs an install or a credential is not available yet",
      });
    }
    if (candidate.source === "internet" && candidate.provenance.trust !== "unverified") {
      ctx.addIssue({
        code: "custom",
        path: ["provenance", "trust"],
        message: "what the Internet says about a candidate is unverified until the host checks the thing itself",
      });
    }
    if (candidate.availability === "needs-acquisition" && candidate.acquisition === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["acquisition"],
        message: "a candidate that needs acquiring names the verifiable form it would be acquired in",
      });
    }
  });
export type CapabilityCandidate = z.infer<typeof capabilityCandidateSchema>;

/**
 * The bounds of one search. Discovery starts because something is missing and stops when a satisfactory candidate is
 * found or a bound is reached; it is never a crawler that runs on its own.
 */
export const discoveryBudgetSchema = z.strictObject({
  maxWallClockMs: z.int().positive().max(60 * 60 * 1000),
  maxProviders: z.int().positive().max(32),
  maxCandidates: z.int().positive().max(100),
  maxTokens: z.int().nonnegative().optional(),
  maxCostUsd: z.number().nonnegative().optional(),
  /** The furthest source the search may reach, in `CAPABILITY_SOURCES` order. */
  furthestSource: capabilitySourceSchema,
});
export type DiscoveryBudget = z.infer<typeof discoveryBudgetSchema>;

/** Whether a budget lets a search reach a source. */
export function sourceWithinBudget(source: CapabilitySource, budget: DiscoveryBudget): boolean {
  return CAPABILITY_SOURCES.indexOf(source) <= CAPABILITY_SOURCES.indexOf(budget.furthestSource);
}

/** Why discovery started. A search without one of these reasons is not one the host starts. */
export const discoveryReasonSchema = z.enum([
  "capability-missing",
  "approach-failed",
  "low-confidence",
  "runtime-unavailable",
  "result-insufficient",
  "user-asked",
  "recurring-gap",
  "standing-intent",
]);
export type DiscoveryReason = z.infer<typeof discoveryReasonSchema>;

export const capabilityQuerySchema = z.strictObject({
  version: z.literal(CAPABILITY_DISCOVERY_VERSION),
  /** The capability needed, in a sentence. */
  need: z.string().min(1).max(500),
  /** Capabilities that would satisfy it, when they can be named. */
  capabilityRefs: z.array(capabilityRefSchema).max(16).optional(),
  reason: discoveryReasonSchema,
  budget: discoveryBudgetSchema,
});
export type CapabilityQuery = z.infer<typeof capabilityQuerySchema>;

/**
 * One discovery provider: this node's inventory, an agent runtime's plugins, a paired node's summary, a directory, the
 * Internet. Providers answer questions and never act; acquiring a candidate goes through the reach-expansion plan and
 * the host's own install, connection and policy paths.
 */
export interface CapabilityProvider {
  readonly providerId: CandidateProvenance["providerId"];
  /** The sources this provider's candidates come from. */
  readonly sources: readonly CapabilitySource[];
  inventory(query: CapabilityQuery): Promise<CapabilityCandidate[]>;
  search(query: CapabilityQuery): Promise<CapabilityCandidate[]>;
  inspect(candidateId: CapabilityCandidate["candidateId"]): Promise<CapabilityCandidate | undefined>;
  /** What acquiring a candidate would widen, for a provider that can acquire what it finds. */
  acquisitionPlan?(candidateId: CapabilityCandidate["candidateId"]): Promise<AcquisitionPlan | undefined>;
}
