import { directoryEntrySchema, riskLaneFor, type RiskLane } from "@clarkcant/contracts";
import { allRows, parseJson, oneRow } from "@clarkcant/storage";

import type { InstallDeps } from "./install-lifecycle.ts";

/**
 * What is installed, and what it is.
 *
 * The marketplace's UI has to answer four questions about every installed package — where it came from, which
 * version, which digest, and which risk lane — and three of those are things a user cannot check for themselves.
 * A digest especially: it is the only thing that ties what is running to what was approved, so a list that showed a
 * version without one would be inviting trust it has not earned.
 *
 * The lane is derived from the plan's isolation, not from the package's own description. A package is as trusted as
 * its least isolated facet, and a listing that took the publisher's word for it would make the label decorative.
 */

export interface InstalledPackageView {
  packageId: string;
  version: string;
  digest: string;
  codeGeneration: string;
  activatedAt: string;
  /** Where it came from, as the plan recorded it at consent time. */
  source: {
    /** The tier the resolver assigned, so "found on the internet" is never dressed up as "first-party". */
    sourceTier: string;
    rationale: string;
    artifactUrl: string;
  };
  /** The strongest lane among the package's facets. */
  lane: RiskLane;
  /** True when the plan that installed it is still the active one. */
  consentedDigest: string | undefined;
  /**
   * The frozen build input this generation was activated against, when it had one.
   *
   * From the generation rather than the plan: what is running is a fact about the generation, and a superseded plan
   * must not be able to change the answer. Absent means nothing was frozen, which is a different statement from an
   * empty closure and is reported as such.
   */
  lock:
    | { ref: string; digest: string; coverage: string }
    | undefined;
}

/**
 * The active generation of every package on this node.
 *
 * Only active generations: a superseded one is history, and listing it would make an uninstalled package look
 * present. When a rollback happens the active row changes, so this list follows the rollback without anything here
 * needing to know about it.
 */
export function listInstalledPackages(deps: InstallDeps): InstalledPackageView[] {
  const rows = allRows<{
    generation_id: string;
    package_id: string;
    version: string;
    digest: string;
    code_generation: string;
    activated_at: string;
    document: string;
  }>(
    deps.db,
    `SELECT generation_id, package_id, version, digest, code_generation, activated_at, document
       FROM package_generations
      WHERE node_id = ? AND superseded_at IS NULL
      ORDER BY package_id`,
    deps.nodeId,
  );

  return rows.map((row) => {
    /*
     * The plan, not the generation. A generation records what is running; the plan records what was consented to —
     * the source it came from and the isolation the supervisor decided on. Reading those off the generation would
     * mean guessing, and the two answers that matter here (where it came from, how isolated it is) are exactly the
     * ones a generation does not carry.
     */
    const planRow = oneRow<{ consented_digest: string | null; document: string }>(
      deps.db,
      "SELECT consented_digest, document FROM install_plans WHERE candidate LIKE ? ORDER BY created_at DESC LIMIT 1",
      `%${row.digest}%`,
    );
    const plan = planRow === undefined
      ? undefined
      : parseJson<{
          candidate?: { rationale?: string; artifactUrl?: string; sourceTier?: string };
          isolationPlan?: { isolation: string }[];
        }>(planRow.document, "install_plans.document");

    const isolations = (plan?.isolationPlan ?? [])
      .map((facet) => facet.isolation)
      .filter((isolation): isolation is "declarative" | "service" | "isolated-ui" | "trusted-native" =>
        ["declarative", "service", "isolated-ui", "trusted-native"].includes(isolation),
      );

    const generation = parseJson<{
      lockRef?: string;
      lockDigest?: string;
      lockCoverage?: string;
    }>(row.document, "package_generations.document");

    return {
      packageId: row.package_id,
      version: row.version,
      digest: row.digest,
      codeGeneration: row.code_generation,
      activatedAt: row.activated_at,
      source: {
        sourceTier: plan?.candidate?.sourceTier ?? "unknown",
        rationale: plan?.candidate?.rationale ?? "",
        artifactUrl: plan?.candidate?.artifactUrl ?? "",
      },
      lane: riskLaneFor(isolations),
      consentedDigest: planRow?.consented_digest ?? undefined,
      lock:
        generation.lockRef === undefined || generation.lockDigest === undefined
          ? undefined
          : {
              ref: generation.lockRef,
              digest: generation.lockDigest,
              coverage: generation.lockCoverage ?? "unknown",
            },
    };
  });
}

/**
 * A directory listing as the UI shows it.
 *
 * Kept separate from what is installed because the two are different questions: this is what could be installed,
 * and it carries the compatibility answer so a listing that cannot run here is not offered as one that can.
 */
export function describeDirectoryEntry(entry: unknown): { ok: true; summary: string } | { ok: false; reason: string } {
  const parsed = directoryEntrySchema.safeParse(entry);
  if (!parsed.success) return { ok: false, reason: "the directory entry does not match the schema" };
  const value = parsed.data;
  return {
    ok: true,
    // One line per entry, and every field the contract requires to be visible: source, version, digest and lane.
    summary:
      `${value.packageId}@${value.version} · ${value.riskTier} · ${String(value.sizeBytes)} B · ` +
      `${value.publisher.id} · ${value.publisher.license} · ${value.digest}`,
  };
}
