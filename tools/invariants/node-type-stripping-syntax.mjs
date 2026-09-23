/**
 * Node executes .ts directly by stripping types. Syntax that needs a real
 * transform (enum, namespace, parameter properties) would break at runtime, so
 * it must not appear in files Node is expected to load.
 */
import { join } from "node:path";

import { readFileSync } from "./context.mjs";

export default function run(ctx) {
  const { repoRoot, check, walk, relative } = ctx;
  const c = check("node-type-stripping-syntax");
  const files = walk(join(repoRoot, "packages"), (f) => f.endsWith(".ts"));
  files.push(...walk(join(repoRoot, "apps"), (f) => f.endsWith(".ts")));
  const banned = [
    { re: /^\s*(?:export\s+)?enum\s+\w+/m, what: "enum declaration" },
    { re: /^\s*(?:declare\s+)?namespace\s+\w+/m, what: "namespace declaration" },
    {
      re: /constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s+\w+/,
      what: "constructor parameter property",
    },
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const { re, what } of banned) {
      if (re.test(source)) {
        c.failures.push(`${relative(file)} uses ${what}, which Node cannot strip`);
      }
    }
  }
  c.notes.push(`${files.length} TypeScript files checked for transform-only syntax`);
}
