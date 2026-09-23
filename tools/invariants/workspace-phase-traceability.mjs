/**
 * Every workspace package must declare its blueprint phase, so a stub can always
 * be traced back to the milestone that owns it.
 */
import { join } from "node:path";

import { existsSync, readdirSync } from "./context.mjs";

export default function run(ctx) {
  const { repoRoot, check, readJson } = ctx;
  const c = check("workspace-phase-traceability");
  const groups = ["packages", "apps", "packs", "examples"];
  const allowed = new Set([
    "P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10",
  ]);
  let count = 0;
  for (const group of groups) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(groupDir, entry.name, "package.json");
      if (!existsSync(pkgPath)) {
        c.failures.push(`${group}/${entry.name} has no package.json`);
        continue;
      }
      count += 1;
      const pkg = readJson(pkgPath);
      const phase = pkg.clarkcant?.phase;
      const status = pkg.clarkcant?.status;
      if (!phase) {
        c.failures.push(`${group}/${entry.name}/package.json declares no clarkcant.phase`);
      } else if (!allowed.has(phase)) {
        c.failures.push(`${group}/${entry.name} declares unknown phase ${phase}`);
      }
      if (!status || !["implemented", "stub", "external-blocked"].includes(status)) {
        c.failures.push(
          `${group}/${entry.name}/package.json declares no valid clarkcant.status (got ${JSON.stringify(status)})`,
        );
      }
    }
  }
  c.notes.push(`${count} workspace packages carry phase + status metadata`);
}
