import {
  type CapabilityRef,
  type FacetKind,
  type InstallState,
  type IsolationClass,
  type PackageManifest,
  requiredRefreshScope,
} from "@clarkcant/contracts";

/**
 * Capability host: discovery, facet generations, and refresh scoping.
 *
 * The single most consequential decision here is which facets a change forces a
 * worker restart for. Restarting Pi to pick up a CSS change is a real cost to the
 * user, and acceptance test T24 asserts it does not happen, so the answer is
 * derived from the facet classification rather than chosen per call site.
 */

/** Discovery order. Cheapest to verify and least privileged comes first. */
export const DISCOVERY_TIERS = [
  "already-installed",
  "first-party-recipe",
  "curated-registry",
  "public-research",
  "built-in-workspace",
] as const;

export interface CandidateSource {
  tier: (typeof DISCOVERY_TIERS)[number];
  id: string;
  version: string;
  /** Publisher-declared origin. Verified against the artifact when downloaded. */
  sourceUrl: string;
  digest: string;
  notes: string;
}

/**
 * Rank candidate implementations.
 *
 * A native adapter that does the job with fewer dependencies beats an MCP wrapper,
 * and an MCP server beats nothing. The ranking is by tier, then by how much the
 * candidate asks for, so "fewer permissions for the same outcome" wins.
 */
export function rankCandidates(
  candidates: readonly (CandidateSource & { requestedCapabilityCount: number })[],
): CandidateSource[] {
  return [...candidates].sort((a, b) => {
    const tier = DISCOVERY_TIERS.indexOf(a.tier) - DISCOVERY_TIERS.indexOf(b.tier);
    if (tier !== 0) return tier;
    return a.requestedCapabilityCount - b.requestedCapabilityCount;
  });
}

/**
 * Validate a manifest's structural claims before it is trusted for anything.
 * Everything a manifest asks for is a request; nothing here grants it.
 */
export function validateManifest(manifest: PackageManifest): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const facetKeys = manifest.facets.map((facet) => `${facet.kind}:${facet.entry}`);
  if (new Set(facetKeys).size !== facetKeys.length) {
    problems.push("two facets declare the same kind and entry");
  }
  for (const facet of manifest.facets) {
    if (facet.isolation === "trusted-native" && manifest.permissions.lifecycleScripts.length > 0) {
      problems.push(
        `facet ${facet.entry} is trusted-native and also declares lifecycle scripts; both are unnecessary risk and must be justified separately`,
      );
    }
    if (facet.entry.includes("..")) {
      problems.push(`facet entry ${facet.entry} escapes the package root`);
    }
    if (/^[a-z]+:\/\//.test(facet.entry)) {
      problems.push(`facet entry ${facet.entry} is a remote URL; entries must be installed artifacts`);
    }
  }
  for (const origin of manifest.permissions.networkOrigins) {
    if (origin === "*" || origin === "https://*") {
      problems.push("a wildcard network origin would make egress policy meaningless");
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/* ------------------------------------------------------------------ *
 * Facet generations
 * ------------------------------------------------------------------ */

export interface FacetGeneration {
  facetKind: FacetKind;
  isolation: IsolationClass;
  generationId: string;
  activeSince: string;
  /** Previous generation kept addressable so rollback is a pointer move. */
  previousGenerationId?: string;
}

export interface FacetHostState {
  facets: Map<FacetKind, FacetGeneration>;
}

export function createFacetHost(): FacetHostState {
  return { facets: new Map() };
}

export type ActivateResult =
  | { ok: true; state: FacetHostState; refreshScope: ReturnType<typeof requiredRefreshScope> }
  | { ok: false; code: "REFRESH_SCOPE_UNSUPPORTED"; message: string };

/**
 * Activate a new generation of a facet.
 *
 * `pi-worker` scope is refused here rather than silently performed: replacing the
 * worker is a handoff with task continuity, and doing it inside a facet
 * activation would drop the running task on the floor.
 */
export function activateFacet(
  state: FacetHostState,
  input: { facetKind: FacetKind; isolation: IsolationClass; generationId: string; at: string },
): ActivateResult {
  const refreshScope = requiredRefreshScope({
    facetKinds: [input.facetKind],
    nativeExtensionChanged: input.isolation === "trusted-native",
    skillOrPromptChanged: input.facetKind === "skills" || input.facetKind === "prompts",
  });

  if (refreshScope === "pi-worker") {
    return {
      ok: false,
      code: "REFRESH_SCOPE_UNSUPPORTED",
      message:
        "this facet requires a new worker generation; use the Pi adapter handoff path so the running task keeps its identity, rather than replacing the facet in place",
    };
  }

  const existing = state.facets.get(input.facetKind);
  const next: FacetHostState = { facets: new Map(state.facets) };
  next.facets.set(input.facetKind, {
    facetKind: input.facetKind,
    isolation: input.isolation,
    generationId: input.generationId,
    activeSince: input.at,
    ...(existing === undefined ? {} : { previousGenerationId: existing.generationId }),
  });
  return { ok: true, state: next, refreshScope };
}

export function activeGenerationId(state: FacetHostState, facetKind: FacetKind): string | undefined {
  return state.facets.get(facetKind)?.generationId;
}

/* ------------------------------------------------------------------ *
 * Required capability resolution
 * ------------------------------------------------------------------ */

export interface CapabilityRequirement {
  capabilityRef: CapabilityRef;
  reason: string;
  /** Optional operations the task would like but can proceed without. */
  optional: boolean;
}

/**
 * Whether an install is even the right answer.
 *
 * If the capability is installed and usable, asking the user to install something
 * would be noise. If it is installed but unauthenticated, the fix is a connection,
 * not an install.
 */
export function decideRequirementAction(input: {
  installed: boolean;
  loaded: boolean;
  authenticated: boolean;
  healthy: boolean;
}): "none" | "connect" | "install" | "repair" {
  if (!input.installed) return "install";
  if (!input.loaded || !input.healthy) return "repair";
  if (!input.authenticated) return "connect";
  return "none";
}

/**
 * Manifest validation, candidate ranking, plan creation and generation activation are implemented and tested.
 *
 * The staged install pipeline now has the two steps that touch code from somewhere else, in `quarantine.ts`:
 * the artifact is downloaded into a directory of its own and hashed before anything may look at it, and the
 * build runs in a process of its own with a working directory inside quarantine and an environment stripped
 * of the node's credentials. The unpack step is guarded against an entry — a symlink included — that resolves
 * outside the root.
 *
 * Not built: dependency locking. A package's own dependency tree is not resolved and pinned, so a build still
 * sees whatever the package manager resolves for it at build time.
 */
export const INSTALL_PIPELINE_STATE: InstallState = "proposed";

export * from "./secrets.ts";
export * from "./quarantine.ts";
