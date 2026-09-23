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
    c.notes.push(`${(manifest.files ?? []).length} manifest entries verified`);
  }
}
