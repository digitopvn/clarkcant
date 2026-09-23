#!/usr/bin/env node
/**
 * Repository invariants that TypeScript and ESLint cannot express.
 *
 * These checks exist because the blueprint makes claims that are otherwise only
 * prose: documentation integrity, phase traceability for every stub, the Node
 * type-stripping syntax contract, and the absence of live credentials.
 *
 * Each check lives in its own module under tools/invariants/, in the run order
 * below. This file only builds the shared context, runs them in order, and
 * prints the same report format as before the split.
 *
 * Exit code is non-zero when any check fails.
 */
import { buildContext } from "./invariants/context.mjs";

import docsManifestIntegrity, { fixManifest } from "./invariants/docs-manifest-integrity.mjs";
import workspacePhaseTraceability from "./invariants/workspace-phase-traceability.mjs";
import stubMarksOwningPhase from "./invariants/stub-marks-owning-phase.mjs";
import nodeTypeStrippingSyntax from "./invariants/node-type-stripping-syntax.mjs";
import noCommittedSecrets from "./invariants/no-committed-secrets.mjs";
import pinnedDependencySpecifiers from "./invariants/pinned-dependency-specifiers.mjs";
import scopeAndAcceptanceTraceability from "./invariants/scope-and-acceptance-traceability.mjs";
import browserEntriesAvoidNodeBuiltins from "./invariants/browser-entries-avoid-node-builtins.mjs";
import singleExecutionPolicyReader from "./invariants/single-execution-policy-reader.mjs";
import implementationStatusRegistry from "./invariants/implementation-status-registry.mjs";
import tsxFilesAreTypechecked from "./invariants/tsx-files-are-typechecked.mjs";
import prBodiesCloseNothing from "./invariants/pr-bodies-close-nothing.mjs";

const CHECKS = [
  docsManifestIntegrity,
  workspacePhaseTraceability,
  stubMarksOwningPhase,
  nodeTypeStrippingSyntax,
  noCommittedSecrets,
  pinnedDependencySpecifiers,
  scopeAndAcceptanceTraceability,
  browserEntriesAvoidNodeBuiltins,
  singleExecutionPolicyReader,
  implementationStatusRegistry,
  tsxFilesAreTypechecked,
  prBodiesCloseNothing,
];

const ctx = await buildContext();

if (process.argv.includes("--fix-manifest")) {
  const updated = fixManifest(ctx);
  process.stdout.write(`docs/manifest.json: rewrote bytes+sha256 for ${updated} file(s)\n`);
  process.exit(0);
}

for (const runCheck of CHECKS) {
  await runCheck(ctx);
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
let failed = 0;
const lines = [];
for (const entry of ctx.results) {
  const ok = entry.failures.length === 0;
  if (!ok) failed += 1;
  lines.push(`${ok ? "PASS" : "FAIL"}  ${entry.name}`);
  for (const note of entry.notes) lines.push(`      · ${note}`);
  for (const failure of entry.failures) lines.push(`      ✗ ${failure}`);
}

process.stdout.write(`${lines.join("\n")}\n\n`);
if (failed > 0) {
  process.stdout.write(`${failed} invariant check(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`all ${ctx.results.length} invariant checks passed\n`);
