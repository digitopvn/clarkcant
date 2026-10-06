import { z } from "zod";

import { packageSourceSchema } from "./directory.ts";
import { capabilityReadinessSchema, capabilityRefSchema } from "./grants.ts";
import { networkOriginProblem, networkOriginSchema } from "./network-origin.ts";
import { capabilityCandidateIdSchema, digestSchema, instantSchema, nodeIdSchema, runtimeIdSchema } from "./primitives.ts";
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
  /** The discovery provider that produced the candidate, by its own id. */
  providerId: z.string().min(1).max(80),
  /** Where the metadata came from: a URL, a directory name, `local`. Said to the person as it is. */
  origin: z.string().min(1).max(500),
  trust: provenanceTrustSchema,
  /** The digest the metadata was checked against, when it was. */
  digest: digestSchema.optional(),
  observedAt: instantSchema,
});
export type CandidateProvenance = z.infer<typeof candidateProvenanceSchema>;

/**
 * An address an acquisition reads from: encrypted unless it is this machine, and with no credentials in it, because the
 * URL is shown to the person and stored with the plan.
 */
export const acquisitionUrlSchema = z
  .url()
  .max(1000)
  .refine(
    (value) => {
      const url = new URL(value);
      return url.username === "" && url.password === "" && networkOriginProblem(url.origin) === undefined;
    },
    { error: "must be https (or http on loopback), with no credentials in it" },
  );

/**
 * The verifiable forms a candidate may be acquired in. There is deliberately no form for a command to run or a script
 * to download: an instruction found somewhere is never an acquisition.
 */
export const acquisitionSourceSchema = z.discriminatedUnion("kind", [
  /** A package from a local path, an exact git revision or an exact registry version. */
  z.strictObject({ kind: z.literal("package"), source: packageSourceSchema }),
  /** A downloadable artifact pinned by digest. */
  z.strictObject({ kind: z.literal("artifact"), url: acquisitionUrlSchema, digest: digestSchema }),
  /** A command-line tool from a package manager, at an exact version. */
  z.strictObject({
    kind: z.literal("cli-package"),
    manager: z.string().min(1).max(40),
    name: z.string().min(1).max(200),
    version: z.string().min(1).max(80),
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
  readonly providerId: string;
  /** The sources this provider's candidates come from. */
  readonly sources: readonly CapabilitySource[];
  inventory(query: CapabilityQuery): Promise<CapabilityCandidate[]>;
  search(query: CapabilityQuery): Promise<CapabilityCandidate[]>;
  inspect(candidateId: CapabilityCandidate["candidateId"]): Promise<CapabilityCandidate | undefined>;
  /** What acquiring a candidate would widen, for a provider that can acquire what it finds. */
  acquisitionPlan?(candidateId: CapabilityCandidate["candidateId"]): Promise<AcquisitionPlan | undefined>;
}
