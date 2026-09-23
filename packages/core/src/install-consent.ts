import type { CapabilityRef, EffectCategory, ExecutionPolicyConfig, RiskLane } from "@clarkcant/contracts";

import { decideExecution } from "./execution-policy.ts";

/**
 * Deriving what a package install actually grants.
 *
 * A manifest's `requestedCapabilities` is a request, never an authority (`packages/core/src/widget-package.ts`).
 * This is the one place that turns a request into a grant, and it does so by asking the execution policy that
 * already governs every other effect on this node — the same `decideExecution` the route uses for the install
 * itself — rather than inventing a second consent surface. There is no ad-hoc dialog here: a capability that the
 * policy would ask about is left out of the granted set rather than answered on the caller's behalf, and a
 * capability the policy denies is refused the same way.
 *
 * The risk split is the package's own isolation lane, the same one `riskLaneFor` computes and the directory shows
 * as `riskTier`. A `declarative` or `isolated-ui` facet cannot reach past its sandbox, so the capabilities it asks
 * for are the ordinary case Autonomous mode exists to grant without a second question once the user's "install X"
 * is the explicit intent that triggered this install. A `service` or `trusted-native` facet can reach further —
 * a broker connection or full worker privileges — so its capabilities are treated as the risky effect category the
 * policy already reserves for exactly that (`destructive`), and only granted when the policy would execute that
 * category outright.
 */

const HIGH_RISK_LANES: ReadonlySet<RiskLane> = new Set<RiskLane>(["service", "trusted-native"]);

function effectCategoryForLane(lane: RiskLane): EffectCategory {
  return HIGH_RISK_LANES.has(lane) ? "destructive" : "local-write";
}

export interface DeriveGrantedCapabilitiesInput {
  requested: readonly CapabilityRef[];
  /** The package's strongest facet lane — `riskLaneFor(entry.isolations)` or `entry.riskTier`. */
  riskTier: RiskLane;
  policy: ExecutionPolicyConfig;
  /** True for an install the user explicitly asked for, e.g. "install X" — false for one a task decided on its own. */
  explicitUserIntent: boolean;
  /** Binds each capability's decision to the artifact it would run, same as the install's own approval. */
  artifactDigest: string;
}

export interface DerivedGrant {
  granted: readonly CapabilityRef[];
  /** Requested but not granted because the policy would ask before allowing it. */
  needsApproval: readonly CapabilityRef[];
  /** Requested but not granted because a rule or the node-wide prohibition refuses it. */
  denied: readonly CapabilityRef[];
}

/**
 * Derive the real granted set from what a package requested.
 *
 * Each requested capability is decided independently, in the risk category its lane implies, rather than all at
 * once — so a mixed package (a `declarative` theme facet plus a `service` connector facet, say) does not have its
 * quiet capabilities held back by its risky one, or its risky one waved through by its quiet one.
 */
export function deriveGrantedCapabilities(input: DeriveGrantedCapabilitiesInput): DerivedGrant {
  const category = effectCategoryForLane(input.riskTier);
  const granted: CapabilityRef[] = [];
  const needsApproval: CapabilityRef[] = [];
  const denied: CapabilityRef[] = [];

  for (const ref of input.requested) {
    const decision = decideExecution({
      policy: input.policy,
      action: { kind: "effect", category, operationDigest: `${input.artifactDigest}:${ref}` },
      explicitUserIntent: input.explicitUserIntent,
    });
    if (decision.kind === "execute") {
      granted.push(ref);
    } else if (decision.kind === "ask") {
      needsApproval.push(ref);
    } else {
      denied.push(ref);
    }
  }

  return { granted, needsApproval, denied };
}
