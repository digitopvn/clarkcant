/**
 * Shared state and helpers for the invariant checks in this directory.
 *
 * `buildContext()` loads the implementation-status registry once and returns the
 * primitives every check module needs: `repoRoot`, filesystem helpers, and a
 * `check(name)` factory that appends a fresh result entry to the shared `results`
 * array. Each check module receives one context and pushes its own entry into it;
 * the entry point in `tools/check-invariants.mjs` prints `results` once every
 * check has run.
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * `path` relative to `root`, always with `/` separators.
 *
 * The checks match these paths against `/`-based patterns (`/src/`, allow-lists, tsconfig `include` globs), so a
 * Windows `\` path would slip past every one of them and a check could pass or fail for the wrong reason. The path
 * API is a parameter so a test can hand in `path.win32` on any OS.
 */
export function repoRelativePath(root, target, pathApi = path) {
  return pathApi.relative(root, target).split(pathApi.sep).join("/");
}

export function relative(target) {
  return repoRelativePath(repoRoot, target);
}

export const REGISTRY_PATH = "packages/contracts/src/implementation-status.ts";

export function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

export function readJson(path) {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${path} is not valid JSON`, { cause });
  }
}

/** Write JSON back with the repository's two-space indent and a trailing newline. */
export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export { existsSync, readFileSync, readdirSync, statSync };

/**
 * The runner's report on `results`: a line per check (`PASS`, `SKIP` or `FAIL`, a check with failures failing even if
 * it also said it skipped) with its notes and failures, then a summary that counts a skipped check as skipped, never as
 * passed. `failed` is the number of failing checks.
 */
export function formatReport(results) {
  const lines = [];
  let failed = 0;
  let skipped = 0;
  for (const entry of results) {
    const status = entry.failures.length > 0 ? "FAIL" : entry.skipped ? "SKIP" : "PASS";
    if (status === "FAIL") failed += 1;
    if (status === "SKIP") skipped += 1;
    lines.push(`${status}  ${entry.name}`);
    for (const note of entry.notes) lines.push(`      · ${note}`);
    for (const failure of entry.failures) lines.push(`      ✗ ${failure}`);
  }
  const passed = results.length - failed - skipped;
  const skippedText = skipped > 0 ? `, ${String(skipped)} skipped` : "";
  let summary;
  if (failed > 0) summary = `${String(failed)} invariant check(s) failed${skippedText}`;
  else if (skipped > 0) summary = `${String(passed)} invariant check(s) passed${skippedText}`;
  else summary = `all ${String(results.length)} invariant checks passed`;
  return { text: `${lines.join("\n")}\n\n${summary}\n`, failed };
}

/**
 * Build the shared context: the `results` array every check appends to, a `check(name)`
 * factory, and the implementation-status registry, loaded once.
 *
 * The registry is loaded rather than parsed, because it is a typed module: a status claim and
 * the package metadata it points at are checked against each other, not against a regex.
 *
 * A load failure is reported by the check that needs it instead of crashing this script, so a
 * broken registry still prints the check that owns it. Node strips the types of a `.ts` file for
 * the same reason the runtime can execute one.
 */
export async function buildContext() {
  let statusRegistry = null;
  let statusRegistryError = null;
  try {
    ({ IMPLEMENTATION_STATUS: statusRegistry } = await import(
      pathToFileURL(join(repoRoot, REGISTRY_PATH)).href,
    ));
  } catch (error) {
    statusRegistryError = error;
  }

  const statusById = new Map(
    (Array.isArray(statusRegistry) ? statusRegistry : []).map((entry) => [entry.capabilityId, entry]),
  );

  /** @type {{name: string, failures: string[], notes: string[], skipped: boolean}[]} */
  const results = [];

  /** A check's result. A check that could not run sets `skipped` and says why in a note. */
  function check(name) {
    const entry = { name, failures: [], notes: [], skipped: false };
    results.push(entry);
    return entry;
  }

  return {
    repoRoot,
    walk,
    readJson,
    writeJson,
    relative,
    check,
    results,
    statusRegistry,
    statusRegistryError,
    statusById,
    REGISTRY_PATH,
  };
}
