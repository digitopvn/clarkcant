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
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative as relativePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export function relative(path) {
  return relativePath(repoRoot, path);
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

export { existsSync, readFileSync, readdirSync, statSync };

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

  /** @type {{name: string, failures: string[], notes: string[]}[]} */
  const results = [];

  function check(name) {
    const entry = { name, failures: [], notes: [] };
    results.push(entry);
    return entry;
  }

  return {
    repoRoot,
    walk,
    readJson,
    relative,
    check,
    results,
    statusRegistry,
    statusRegistryError,
    statusById,
    REGISTRY_PATH,
  };
}
