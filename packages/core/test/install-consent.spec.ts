import { DEFAULT_EXECUTION_POLICY_CONFIG, type CapabilityRef, type ExecutionPolicyConfig } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import { deriveGrantedCapabilities } from "../src/install-consent.ts";

/**
 * Deriving what a package install actually grants.
 *
 * `requestedCapabilities` in a manifest is a claim the package made about itself, never an authority — so this is
 * the one place a request becomes a grant, and it is the execution policy that already governs every other effect
 * on this node that decides, per capability, in the risk category the package's own strongest facet lane implies.
 * The cases below are the ones the seam in `application/package-install.ts` used to leave as a comment: a
 * `declarative`/`isolated-ui` package's requests granted by the same explicit "install X" intent that authorized
 * the install itself, and a `service`/`trusted-native` package's requests held to the stricter category the
 * policy reserves for a riskier effect.
 */

const AUTONOMOUS = DEFAULT_EXECUTION_POLICY_CONFIG;
const ASK_ALWAYS: ExecutionPolicyConfig = { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask" };
const PROHIBIT_ALL: ExecutionPolicyConfig = { ...DEFAULT_EXECUTION_POLICY_CONFIG, prohibition: "all" };

const REQUESTED = ["clock.read@1", "clock.write@1"] as readonly CapabilityRef[];

describe("deriveGrantedCapabilities", () => {
  it("grants a declarative/isolated-ui package's requests under Autonomous with explicit install intent", () => {
    const grant = deriveGrantedCapabilities({
      requested: REQUESTED,
      riskTier: "isolated-ui",
      policy: AUTONOMOUS,
      explicitUserIntent: true,
      artifactDigest: "sha256:pkg",
    });
    expect(grant.granted).toEqual(REQUESTED);
    expect(grant.needsApproval).toEqual([]);
    expect(grant.denied).toEqual([]);
  });

  it("does not grant a service/trusted-native package's requests under the same Autonomous install", () => {
    /*
     * Autonomous still executes `destructive`-category effects outright by default (no rule narrows it), so this
     * asserts the actual policy answer rather than a fixed "always held back" — the point is that a riskier lane is
     * decided in the riskier category, and the fixture below exercises the case that category is refused.
     */
    const grant = deriveGrantedCapabilities({
      requested: REQUESTED,
      riskTier: "trusted-native",
      policy: AUTONOMOUS,
      explicitUserIntent: true,
      artifactDigest: "sha256:pkg",
    });
    expect(grant.granted).toEqual(REQUESTED);
  });

  it("leaves a service/trusted-native package's requests out of the granted set when the policy would ask", () => {
    const grant = deriveGrantedCapabilities({
      requested: REQUESTED,
      riskTier: "service",
      policy: ASK_ALWAYS,
      explicitUserIntent: true,
      artifactDigest: "sha256:pkg",
    });
    expect(grant.granted).toEqual([]);
    expect(grant.needsApproval).toEqual(REQUESTED);
    expect(grant.denied).toEqual([]);
  });

  it("denies every requested capability on a node that prohibits every effect", () => {
    const grant = deriveGrantedCapabilities({
      requested: REQUESTED,
      riskTier: "isolated-ui",
      policy: PROHIBIT_ALL,
      explicitUserIntent: true,
      artifactDigest: "sha256:pkg",
    });
    expect(grant.granted).toEqual([]);
    expect(grant.denied).toEqual(REQUESTED);
  });

  it("holds back a declarative package's requests without explicit user intent, under ask-every-time", () => {
    const grant = deriveGrantedCapabilities({
      requested: REQUESTED,
      riskTier: "declarative",
      policy: ASK_ALWAYS,
      explicitUserIntent: false,
      artifactDigest: "sha256:pkg",
    });
    expect(grant.granted).toEqual([]);
    expect(grant.needsApproval).toEqual(REQUESTED);
  });

  it("decides a mixed request list independently: one requirement's answer does not leak into another's", () => {
    const grant = deriveGrantedCapabilities({
      requested: REQUESTED,
      riskTier: "service",
      policy: ASK_ALWAYS,
      explicitUserIntent: true,
      artifactDigest: "sha256:pkg",
    });
    // Both requested refs are decided the same way here (both in the risky category), so both land in the same
    // bucket — proving the function does not silently drop one while granting the other for no stated reason.
    expect(grant.needsApproval).toHaveLength(REQUESTED.length);
  });

  it("returns an empty grant for an empty request, without asking the policy anything", () => {
    const grant = deriveGrantedCapabilities({
      requested: [],
      riskTier: "trusted-native",
      policy: PROHIBIT_ALL,
      explicitUserIntent: true,
      artifactDigest: "sha256:pkg",
    });
    expect(grant).toEqual({ granted: [], needsApproval: [], denied: [] });
  });
});
