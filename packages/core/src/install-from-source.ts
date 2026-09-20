import { createHash } from "node:crypto";

import {
  capabilityRefSchema,
  type CapabilityRef,
  type DirectoryEntry,
  type EffectCategory,
  type FacetKind,
  type InstallPlan,
  type InstallState,
  type Instant,
  type IsolationClass,
  type PackageSource,
  type Platform,
} from "@clarkcant/contracts";

import {
  activateGeneration,
  advanceInstall,
  joinOrCreatePlan,
  recordConsent,
  rollbackGeneration,
  type InstallDeps,
} from "./install-lifecycle.ts";
import { artifactMatchesPlan, resolvePackageSource, type SourceRefusal } from "./package-sources.ts";

/**
 * Installing from a source.
 *
 * This is the phase's whole claim in one function: a marketplace is a **source resolver**, and everything after
 * resolution is the install supervisor that already existed. There is no second install path, no second digest
 * check, and no way to reach `active` without consent, staging, validation, a healthcheck and a generation.
 *
 * The order matters and is the point:
 *
 * 1. Resolve to an exact artifact. A branch, a range, a missing digest or a foreign host API stops here.
 * 2. Plan, and consent to the plan by digest — so what the user approved is the thing that gets installed.
 * 3. Stage, validate, drain, activate, healthcheck. Every step is a state transition the supervisor already
 *    enforces, and an illegal one is reported rather than skipped.
 * 4. On a failed healthcheck, roll back — and if the failure came too late for an automatic rollback, say so
 *    rather than pretending the previous generation is still there.
 */

export interface InstallFromSourceInput {
  source: PackageSource;
  directory?: readonly DirectoryEntry[];
  hostApi: number;
  platform: Platform;
  /** Required for a local source: the digest the caller computed from the package directory. */
  localDigest?: string;
  ownerPrincipalId: string;
  /** One plan per requirement and node, so two tasks needing the same pack share it. */
  requirementKey: string;
  requestedCapabilityRefs: readonly string[];
  grantedCapabilities: readonly string[];
  isolationPlan: readonly { facetKind: FacetKind; isolation: IsolationClass }[];
  effectCategories?: readonly EffectCategory[];
  dataRecipients?: readonly string[];
  /** Distinguishes one code generation from the next; the caller owns what it means. */
  codeGeneration: string;
  /** Run after activation is staged, and before the generation becomes active. */
  healthcheck: () => boolean;
  expiresAt: Instant;
}

export type InstallOutcome =
  | {
      ok: true;
      planId: string;
      state: InstallState;
      generationId: string;
      /** True when the plan already existed and this call joined it rather than installing again. */
      joinedExisting: boolean;
    }
  | {
      ok: false;
      code:
        | SourceRefusal
        | "ILLEGAL_TRANSITION"
        | "CONSENT_STALE"
        | "CONSENT_MISSING"
        | "HEALTHCHECK_FAILED"
        | "ROLLBACK_REFUSED";
      message: string;
      /** Set when a healthcheck failure was followed by a rollback attempt. */
      rolledBack?: boolean;
    };

/** The digest consent is bound to. Canonical JSON over the plan body, so any change invalidates the approval. */
function digestOf(body: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

export function installFromSource(deps: InstallDeps, input: InstallFromSourceInput): InstallOutcome {
  const resolved = resolvePackageSource({
    source: input.source,
    ...(input.directory === undefined ? {} : { directory: input.directory }),
    hostApi: input.hostApi,
    platform: input.platform,
    ...(input.localDigest === undefined ? {} : { localDigest: input.localDigest }),
  });
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };

  const at = deps.now();
  const requested = input.requestedCapabilityRefs.map((ref) => capabilityRefSchema.parse(ref) as CapabilityRef);
  const granted = input.grantedCapabilities.map((ref) => capabilityRefSchema.parse(ref) as CapabilityRef);

  const body = {
    requirementKey: input.requirementKey,
    ownerPrincipalId: input.ownerPrincipalId,
    targetNodeId: deps.nodeId,
    candidate: {
      id: resolved.resolved.packageId,
      version: resolved.resolved.version,
      artifactUrl: resolved.resolved.artifactUrl,
      digest: resolved.resolved.digest,
      rationale: resolved.resolved.rationale,
      sourceTier: resolved.resolved.sourceTier,
    },
    requestedCapabilityRefs: requested,
    grantedCapabilities: granted,
    isolationPlan: input.isolationPlan,
    resolvedDependencies: [],
    effectCategories: input.effectCategories ?? [],
    dataRecipients: [...(input.dataRecipients ?? [])],
  };

  const plan: InstallPlan = {
    planId: deps.newId("plan"),
    ownerPrincipalId: input.ownerPrincipalId as InstallPlan["ownerPrincipalId"],
    requirementKey: input.requirementKey,
    requestedCapabilityRefs: requested,
    candidate: body.candidate as InstallPlan["candidate"],
    resolvedDependencies: [],
    targetNodeId: deps.nodeId as InstallPlan["targetNodeId"],
    grantedCapabilities: granted,
    effectCategories: (input.effectCategories ?? []) as InstallPlan["effectCategories"],
    dataRecipients: [...(input.dataRecipients ?? [])],
    planDigest: digestOf(body),
    isolationPlan: input.isolationPlan as InstallPlan["isolationPlan"],
    createdAt: at,
    expiresAt: input.expiresAt,
  };

  const joined = joinOrCreatePlan(deps, plan);
  if (joined.status === "joined-existing") {
    /*
     * Someone else is already installing this. Joining rather than competing is what the unique index is for: two
     * tasks that need the same pack produce one prompt and one install, not two.
     */
    return {
      ok: true,
      planId: joined.planId,
      state: joined.state,
      generationId: "",
      joinedExisting: true,
    };
  }

  const consent = recordConsent(deps, { planId: plan.planId, currentPlan: plan });
  if (!consent.ok) return { ok: false, code: consent.code, message: consent.message };

  // Each step is a transition the supervisor checks. Reporting an illegal one rather than skipping it is what
  // keeps this function from being a way around the state machine.
  for (const state of ["staging", "validating", "ready_to_activate", "draining", "activating", "healthchecking"] as const) {
    const advanced = advanceInstall(deps, plan.planId, state);
    if (!advanced.ok) return { ok: false, code: "ILLEGAL_TRANSITION", message: advanced.message };
  }

  if (!input.healthcheck()) {
    const rollback = rollbackGeneration(deps, {
      packageId: resolved.resolved.packageId,
      nodeId: deps.nodeId,
      failedAt: "healthchecking",
    });
    if (!rollback.ok) {
      /*
       * Refused, and named as a refusal. A failure this late may already have replaced the active generation, and
       * claiming a rollback that did not happen is worse than asking for a person to look.
       */
      return {
        ok: false,
        code: "ROLLBACK_REFUSED",
        message: `${rollback.message}; the install is at healthchecking and needs review`,
        rolledBack: false,
      };
    }
    return {
      ok: false,
      code: "HEALTHCHECK_FAILED",
      message: `healthcheck failed; rolled back to ${rollback.generation.generationId}`,
      rolledBack: true,
    };
  }

  const activated = activateGeneration(deps, {
    planId: plan.planId,
    currentPlan: plan,
    codeGeneration: input.codeGeneration,
    // Facets whose change does not require restarting a Pi worker. Derived from the isolation plan rather than
    // asserted, because "ui only" is a claim about what will be reloaded.
    uiOnlyFacets: input.isolationPlan
      .filter((facet) => facet.isolation === "isolated-ui" || facet.isolation === "declarative")
      .map((facet) => facet.facetKind),
    nativeExtensionChanged: input.isolationPlan.some((facet) => facet.isolation === "trusted-native"),
    skillOrPromptChanged: input.isolationPlan.some((facet) => facet.facetKind === "skills" || facet.facetKind === "prompts"),
  });
  if (!activated.ok) return { ok: false, code: activated.code, message: activated.message };

  return {
    ok: true,
    planId: plan.planId,
    state: "active",
    generationId: activated.generation.generationId,
    joinedExisting: false,
  };
}

export { artifactMatchesPlan };
