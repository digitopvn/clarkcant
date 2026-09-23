/**
 * The execution policy has exactly one reader.
 *
 * Phase 1's AC-5 makes `readExecutionPolicy` the canonical reader and forbids a second one beside it. The reason is
 * not tidiness: a module that reads the policy preference itself answers with the registry's default whenever no
 * canonical row exists, so `apps/runtime/src/gateway.ts` reported `execution.mode: "autonomous"` in `GET
 * /preferences` for an upgraded node whose legacy `autonomy` was `deny` — a node that refuses every effect,
 * described as the loosest mode. Only the module that owns the decision, and the migration it delegates to, may
 * open the key; everything else goes through the reader (or, for the projections that need the row's revision, the
 * reader's own `readExecutionPolicyPreference`).
 *
 * The check reads the call rather than the line, because the key travels as an exported constant and a call can wrap
 * across lines — and it fails when it finds no read at all, so it cannot pass by having lost its own subject.
 */
import { join } from "node:path";

import { readFileSync } from "./context.mjs";

export default function run(ctx) {
  const { repoRoot, check, walk, relative } = ctx;
  const c = check("single-execution-policy-reader");
  const allowed = new Set([
    "packages/core/src/execution-policy.ts",
    "packages/core/src/execution-policy-migration.ts",
  ]);
  const readHelpers = ["readRegisteredPreference", "getPreference", "listRegisteredPreferences"];
  const policyKey = /EXECUTION_POLICY_PREFERENCE_KEY|["']execution\.policy["']/;

  /** The text of the call whose `(` is at `open`, by balancing parentheses. */
  const callText = (source, open) => {
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      const character = source[index];
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) return source.slice(open, index + 1);
      }
    }
    return source.slice(open);
  };

  const sources = [
    ...walk(join(repoRoot, "apps"), (path) => path.endsWith(".ts")),
    ...walk(join(repoRoot, "packages"), (path) => path.endsWith(".ts")),
  ]
    .map((path) => relative(path))
    .filter((path) => path.includes("/src/") && !path.endsWith(".spec.ts"));

  let reads = 0;
  for (const path of sources) {
    const source = readFileSync(join(repoRoot, path), "utf8");
    for (const helper of readHelpers) {
      for (const match of source.matchAll(new RegExp(`\\b${helper}\\s*\\(`, "g"))) {
        const open = match.index + match[0].length - 1;
        if (!policyKey.test(callText(source, open))) continue;
        reads += 1;
        if (!allowed.has(path)) {
          c.failures.push(`${path} reads the canonical policy preference directly; use readExecutionPolicy`);
        }
      }
    }
  }

  if (reads === 0) {
    c.failures.push("nothing reads the canonical policy preference, so this check has no subject");
  }
  c.notes.push(
    `${reads} canonical policy read(s) across ${sources.length} module(s), ${allowed.size} allowed to open the key`,
  );
}
