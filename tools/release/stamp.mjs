/**
 * Stamp a planned release into this checkout: the version into every manifest that carries the Clark version, and the
 * planned release history into the record the runtime embeds (`apps/runtime/release-notes.json`).
 *
 * Usage: `node tools/release/stamp.mjs <plan.json>`, with the plan `plan.mjs` wrote. For a release build's checkout
 * only, and never committed back: the tag is the record of a published version. Refuses a plan that releases nothing.
 * Dependency-free.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { clarkVersionDrift, stampVersion } from "./clark-version.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Stamp `plan` into `repoRoot`; returns the stamped version. */
export function stampPlan(repoRoot, plan) {
  if (plan?.release !== true) throw new Error("the plan releases nothing, so there is no version to stamp");
  if (typeof plan.version !== "string" || plan.history?.build?.version !== plan.version || !Array.isArray(plan.history?.releases)) {
    throw new Error("the plan does not carry a version with a matching release history");
  }
  stampVersion(repoRoot, {
    version: plan.version,
    channel: plan.history.build.channel,
    releases: plan.history.releases,
    source: plan.history.source,
  });
  const drift = clarkVersionDrift(repoRoot);
  if (drift.length > 0) throw new Error(`stamping left the build carrying more than one version: ${drift.join("; ")}`);
  return plan.version;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const path = process.argv[2];
  try {
    if (path === undefined) throw new Error("usage: node tools/release/stamp.mjs <plan.json>");
    const version = stampPlan(REPO_ROOT, JSON.parse(readFileSync(resolve(path), "utf8")));
    process.stdout.write(`stamped Clark ${version} into every manifest and the embedded release record\n`);
  } catch (error) {
    process.stderr.write(`stamp failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
