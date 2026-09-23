/**
 * Dependency specifiers must be pinned. `latest`, `*`, and branch refs make a
 * build unreproducible, and the blueprint requires exact versions.
 */
import { join } from "node:path";

import { existsSync, readdirSync } from "./context.mjs";

export default function run(ctx) {
  const { repoRoot, check, readJson } = ctx;
  const c = check("pinned-dependency-specifiers");
  const groups = ["packages", "apps", "packs", "examples"];
  let deps = 0;
  for (const group of groups) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(groupDir, entry.name, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = readJson(pkgPath);
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
          deps += 1;
          if (spec === "latest" || spec === "*" || /^(git|github|https?):/.test(spec)) {
            c.failures.push(
              `${group}/${entry.name} has unpinned ${field} "${name}": ${spec}`,
            );
          }
        }
      }
    }
  }
  c.notes.push(`${deps} dependency specifiers checked for pinning`);
}
