import {
  type InstallPlan,
  type InstallState,
  type Instant,
  type PackageGeneration,
  canTransitionInstall,
  consentStillValid,
  legalInstallTargets,
  packageGenerationSchema,
  previousGenerationSurvives,
  requiredRefreshScope,
} from "@clarkcant/contracts";

import { type Database, oneRow, parseJson, toJson, transaction } from "@clarkcant/storage";

/**
 * Install supervisor.
 *
 * Three behaviours here are the reason this is not a thin wrapper over SQL:
 *
 * 1. One plan per (requirement, target node). Two tasks that need the same pack
 *    join the existing plan instead of racing to install it twice.
 * 2. Consent is bound to a plan digest. If the source, version, digest, grants or
 *    node change, the consent no longer applies and the user is asked again.
 * 3. Activation produces an immutable generation. A failure rolls back to the
 *    previous generation rather than leaving the node in a half-installed state.
 */

export interface InstallDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
}

export interface InstallRecord {
  plan: InstallPlan;
  state: InstallState;
  consentedDigest?: string;
  consentedAt?: Instant;
}

export function savePlan(deps: InstallDeps, plan: InstallPlan): void {
  deps.db
    .prepare(
      `INSERT INTO install_plans
         (plan_id, requirement_key, owner_principal_id, target_node_id, candidate, plan_digest, document, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET
         candidate = excluded.candidate,
         plan_digest = excluded.plan_digest,
         document = excluded.document,
         expires_at = excluded.expires_at`,
    )
    .run(
      plan.planId,
      plan.requirementKey,
      plan.ownerPrincipalId,
      plan.targetNodeId,
      toJson(plan.candidate),
      plan.planDigest,
      toJson(plan),
      plan.createdAt,
      plan.expiresAt,
    );
}

export type JoinPlanResult =
  | { status: "joined-existing"; planId: string; state: InstallState }
  | { status: "created"; planId: string };

/**
 * Find or create the install plan a task should wait on.
 *
 * The unique index on (requirement_key, target_node_id) for non-dead plans is
 * what makes this safe under concurrency: the second caller joins the first plan
 * instead of producing a competing prompt (acceptance test T20).
 */
export function joinOrCreatePlan(deps: InstallDeps, plan: InstallPlan): JoinPlanResult {
  return transaction(deps.db, () => {
    const existing = oneRow<{ plan_id: string; state: string }>(
      deps.db,
      `SELECT plan_id, state FROM install_plans
        WHERE requirement_key = ? AND target_node_id = ?
          AND state NOT IN ('declined','failed','cancelled')
        LIMIT 1`,
      plan.requirementKey,
      plan.targetNodeId,
    );
    if (existing) {
      return {
        status: "joined-existing" as const,
        planId: existing.plan_id,
        state: existing.state as InstallState,
      };
    }
    savePlan(deps, plan);
    return { status: "created" as const, planId: plan.planId };
  });
}

export function getPlan(deps: InstallDeps, planId: string): InstallRecord | undefined {
  const row = oneRow<Record<string, unknown>>(
    deps.db,
    "SELECT * FROM install_plans WHERE plan_id = ?",
    planId,
  );
  if (!row) return undefined;
  return {
    plan: parseJson<InstallPlan>(String(row.document), "install_plans.document"),
    state: String(row.state) as InstallState,
    ...(row.consented_digest === null ? {} : { consentedDigest: String(row.consented_digest) }),
    ...(row.consented_at === null ? {} : { consentedAt: String(row.consented_at) as Instant }),
  };
}

export type ConsentResult =
  | { ok: true; state: InstallState }
  | { ok: false; code: "ILLEGAL_TRANSITION" | "CONSENT_STALE"; message: string; changed?: string[] };

/**
 * Record user consent for a plan.
 *
 * Consent names the exact artifacts the user saw. Re-deriving the plan and
 * comparing the two is what turns "the source changed after you approved it" into
 * a refusal rather than a silent substitution (acceptance test T21).
 */
export function recordConsent(
  deps: InstallDeps,
  input: { planId: string; currentPlan: InstallPlan },
): ConsentResult {
  return transaction(deps.db, () => {
    const record = getPlan(deps, input.planId);
    if (!record) {
      return { ok: false as const, code: "ILLEGAL_TRANSITION" as const, message: "install plan not found" };
    }
    if (!canTransitionInstall(record.state, "consented")) {
      return {
        ok: false as const,
        code: "ILLEGAL_TRANSITION" as const,
        message: `cannot consent while the plan is ${record.state}`,
      };
    }

    const validity = consentStillValid(record.plan, input.currentPlan);
    if (!validity.valid) {
      return {
        ok: false as const,
        code: "CONSENT_STALE" as const,
        // The field names say what moved; the detail says which dependency, when one did. A refusal a person cannot
        // act on is indistinguishable from a bug.
        message: `the plan changed since it was displayed (${validity.changed.join(", ")})${validity.detail.length === 0 ? "" : `: ${validity.detail.join("; ")}`}; it must be reviewed again`,
        changed: validity.changed,
      };
    }

    const at = deps.now();
    deps.db
      .prepare(
        "UPDATE install_plans SET state = 'consented', consented_digest = ?, consented_at = ? WHERE plan_id = ?",
      )
      .run(input.currentPlan.planDigest, at, input.planId);

    return { ok: true as const, state: "consented" };
  });
}

export function advanceInstall(
  deps: InstallDeps,
  planId: string,
  to: InstallState,
): { ok: true; state: InstallState } | { ok: false; code: "ILLEGAL_TRANSITION"; message: string } {
  return transaction(deps.db, () => {
    const record = getPlan(deps, planId);
    if (!record) {
      return { ok: false as const, code: "ILLEGAL_TRANSITION" as const, message: "install plan not found" };
    }
    if (!canTransitionInstall(record.state, to)) {
      return {
        ok: false as const,
        code: "ILLEGAL_TRANSITION" as const,
        message: `cannot move install from ${record.state} to ${to}; legal targets are ${legalInstallTargets(record.state).join(", ") || "none"}`,
      };
    }
    deps.db.prepare("UPDATE install_plans SET state = ? WHERE plan_id = ?").run(to, planId);
    return { ok: true as const, state: to };
  });
}

/* ------------------------------------------------------------------ *
 * Generations
 * ------------------------------------------------------------------ */

export type ActivationResult =
  | { ok: true; generation: PackageGeneration; refreshScope: RefreshScope }
  | { ok: false; code: "CONSENT_MISSING" | "CONSENT_STALE" | "ILLEGAL_TRANSITION"; message: string };

export function activateGeneration(
  deps: InstallDeps,
  input: {
    planId: string;
    currentPlan: InstallPlan;
    codeGeneration: string;
    uiOnlyFacets: string[];
    nativeExtensionChanged: boolean;
    skillOrPromptChanged: boolean;
  },
): ActivationResult {
  return transaction(deps.db, () => {
    const record = getPlan(deps, input.planId);
    if (!record) {
      return { ok: false as const, code: "ILLEGAL_TRANSITION" as const, message: "install plan not found" };
    }
    if (record.consentedDigest === undefined) {
      return { ok: false as const, code: "CONSENT_MISSING" as const, message: "plan has not been consented to" };
    }
    const validity = consentStillValid(record.plan, input.currentPlan);
    if (!validity.valid) {
      return {
        ok: false as const,
        code: "CONSENT_STALE" as const,
        message: `consent no longer covers the plan (${validity.changed.join(", ")})${validity.detail.length === 0 ? "" : `: ${validity.detail.join("; ")}`}; re-review before activating`,
      };
    }

    const at = deps.now();
    const generation = packageGenerationSchema.parse({
      generationId: `${input.currentPlan.candidate.id}@${input.currentPlan.candidate.version}:${input.codeGeneration}`,
      packageId: input.currentPlan.candidate.id,
      version: input.currentPlan.candidate.version,
      digest: input.currentPlan.candidate.digest,
      nodeId: input.currentPlan.targetNodeId,
      codeGeneration: input.codeGeneration,
      activatedAt: at,
      uiOnlyFacets: input.uiOnlyFacets,
      // Carried from the plan rather than re-derived: what is running and what was consented to are two rows.
      ...(input.currentPlan.lockRef === undefined
        ? {}
        : {
            lockRef: input.currentPlan.lockRef,
            ...(input.currentPlan.lockDigest === undefined ? {} : { lockDigest: input.currentPlan.lockDigest }),
            ...(input.currentPlan.lockCoverage === undefined ? {} : { lockCoverage: input.currentPlan.lockCoverage }),
          }),
    });

    // Supersede the previous generation for this package on this node. Keeping the
    // row (rather than deleting it) is what makes rollback possible.
    deps.db
      .prepare(
        "UPDATE package_generations SET superseded_at = ? WHERE package_id = ? AND node_id = ? AND superseded_at IS NULL",
      )
      .run(at, generation.packageId, generation.nodeId);

    deps.db
      .prepare(
        `INSERT INTO package_generations
           (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        generation.generationId,
        generation.packageId,
        generation.version,
        generation.digest,
        generation.nodeId,
        generation.codeGeneration,
        generation.activatedAt,
        toJson(generation),
      );

    deps.db.prepare("UPDATE install_plans SET state = 'active' WHERE plan_id = ?").run(input.planId);

    const refreshScope = requiredRefreshScope({
      facetKinds: input.currentPlan.isolationPlan.map((entry) => entry.facetKind),
      nativeExtensionChanged: input.nativeExtensionChanged,
      skillOrPromptChanged: input.skillOrPromptChanged,
    });

    return { ok: true as const, generation, refreshScope };
  });
}

export type RefreshScope = ReturnType<typeof requiredRefreshScope>;

export function activeGeneration(
  deps: InstallDeps,
  packageId: string,
  nodeId: string,
): PackageGeneration | undefined {  const row = oneRow<{ document: string }>(
    deps.db,
    "SELECT document FROM package_generations WHERE package_id = ? AND node_id = ? AND superseded_at IS NULL",
    packageId,
    nodeId,
  );
  return row === undefined ? undefined : parseJson<PackageGeneration>(row.document, "package_generations.document");
}

/**
 * Roll back to the newest superseded generation for a package.
 *
 * Rollback restores code, and only code. External effects the failed generation
 * already produced are not undone, and the result says so rather than implying a
 * clean reversal.
 */
export function rollbackGeneration(
  deps: InstallDeps,
  input: { packageId: string; nodeId: string; failedAt: InstallState },
): { ok: true; generation: PackageGeneration } | { ok: false; message: string } {
  if (!previousGenerationSurvives(input.failedAt)) {
    return {
      ok: false,
      message: `a failure at ${input.failedAt} may already have replaced the active generation; this needs operator review rather than an automatic rollback`,
    };
  }

  return transaction(deps.db, () => {
    const previous = oneRow<{ document: string; generation_id: string }>(
      deps.db,
      `SELECT document, generation_id FROM package_generations
        WHERE package_id = ? AND node_id = ? AND superseded_at IS NOT NULL
        ORDER BY superseded_at DESC LIMIT 1`,
      input.packageId,
      input.nodeId,
    );
    if (!previous) {
      return { ok: false as const, message: `no previous generation of ${input.packageId} exists on ${input.nodeId}` };
    }

    // Order matters: the partial unique index allows only one active generation per
    // (package, node), so the currently active row must be retired before the
    // previous one can be revived.
    deps.db
      .prepare(
        `UPDATE package_generations SET superseded_at = ?
          WHERE package_id = ? AND node_id = ? AND superseded_at IS NULL AND generation_id <> ?`,
      )
      .run(deps.now(), input.packageId, input.nodeId, previous.generation_id);
    deps.db
      .prepare("UPDATE package_generations SET superseded_at = NULL WHERE generation_id = ?")
      .run(previous.generation_id);

    return {
      ok: true as const,
      generation: parseJson<PackageGeneration>(previous.document, "package_generations.document"),
    };
  });
}
