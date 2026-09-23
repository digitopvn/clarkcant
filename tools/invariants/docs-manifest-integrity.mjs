/**
 * docs/manifest.json integrity — the documentation claims its own hashes and file
 * list. Verify that claim instead of trusting it.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { existsSync, readFileSync, statSync } from "./context.mjs";

export default function run(ctx) {
  const { repoRoot, check } = ctx;
  const c = check("docs-manifest-integrity");
  const manifestPath = join(repoRoot, "docs", "manifest.json");
  if (!existsSync(manifestPath)) {
    c.failures.push("docs/manifest.json is missing");
  } else {
    const manifest = ctx.readJson(manifestPath);
    const docsDir = join(repoRoot, "docs");
    for (const entry of manifest.files ?? []) {
      const full = join(docsDir, entry.path);
      if (!existsSync(full)) {
        c.failures.push(
          `declared in manifest but absent from disk: docs/${entry.path}`,
        );
        continue;
      }
      const actual = createHash("sha256")
        .update(readFileSync(full))
        .digest("hex");
      if (actual !== entry.sha256) {
        c.failures.push(
          `sha256 mismatch for docs/${entry.path}: manifest=${entry.sha256.slice(0, 12)}… actual=${actual.slice(0, 12)}…`,
        );
      }
      if (statSync(full).size !== entry.bytes) {
        c.failures.push(
          `byte size mismatch for docs/${entry.path}: manifest=${entry.bytes} actual=${statSync(full).size}`,
        );
      }
    }
    if (c.failures.length > 0) {
      c.failures.push(
        "run `node tools/check-invariants.mjs --fix-manifest` to rewrite bytes+sha256 for the files listed above",
      );
    }
    c.notes.push(`${(manifest.files ?? []).length} manifest entries verified`);
  }
}

/**
 * Rewrite bytes+sha256 for every file docs/manifest.json lists, in place.
 *
 * Used by `check-invariants.mjs --fix-manifest`. A file the manifest declares but that is
 * missing from disk is left alone: this check only fixes a stale hash, never a stale file list.
 */
export function fixManifest(ctx) {
  const { repoRoot } = ctx;
  const manifestPath = join(repoRoot, "docs", "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("docs/manifest.json is missing, so there is nothing to fix");
  }
  const manifest = ctx.readJson(manifestPath);
  const docsDir = join(repoRoot, "docs");
  let updated = 0;
  for (const entry of manifest.files ?? []) {
    const full = join(docsDir, entry.path);
    if (!existsSync(full)) continue;
    const bytes = statSync(full).size;
    const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
    if (entry.bytes !== bytes || entry.sha256 !== sha256) {
      entry.bytes = bytes;
      entry.sha256 = sha256;
      updated += 1;
    }
  }
  ctx.writeJson(manifestPath, manifest);
  return updated;
}
