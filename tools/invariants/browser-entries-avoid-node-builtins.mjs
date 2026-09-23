/**
 * Every browser entry must be free of Node builtins.
 *
 * A module that reads `node:crypto` at its top is fatal in the dev server and invisible in a bundle, because Rollup
 * tree-shakes an unused import away while Vite's dev server serves each module as written and hoists the interop read
 * to the first line. That asymmetry is exactly how the web client kept a broken dev experience: `WidgetFrame`
 * imported a package's barrel, the barrel imported a digest helper that reads `node:crypto`, the build dropped both,
 * and only `pnpm dev:web` failed — with the error in the browser console and nothing on the page. Walking the entries
 * is what turns the dev path into a gate instead of a surprise.
 */
import { join } from "node:path";

import { existsSync, readFileSync, readdirSync, statSync } from "./context.mjs";

export default function run(ctx) {
  const { repoRoot, check, relative } = ctx;
  const c = check("browser-entries-avoid-node-builtins");

  const manifestOf = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch (error) {
      // Named here rather than left as a bare SyntaxError from somewhere unhelpful: a manifest this check cannot read
      // is a failure of the check's own input, and the path is what makes that actionable.
      throw new Error(`could not read the manifest of ${relative(dir)}`, { cause: error });
    }
  };

  const packageDirs = new Map();
  for (const group of ["packages", "apps", "packs", "examples"]) {
    const root = join(repoRoot, group);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      if (existsSync(join(dir, "package.json"))) packageDirs.set(manifestOf(dir).name, dir);
    }
  }

  /**
   * What the bundler would load for one specifier, or undefined for a third-party module this check does not follow.
   *
   * A workspace package is resolved through its own `exports` map, because that map is what decides whether the browser
   * is handed a browser-safe subpath or the whole barrel — the decision this check exists to enforce.
   */
  const resolveSpecifier = (fromDir, specifier) => {
    if (specifier.startsWith(".")) {
      const base = join(fromDir, specifier);
      const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
      return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    }
    if (!specifier.startsWith("@clarkcant/")) return undefined;
    const parts = specifier.split("/");
    const dir = packageDirs.get(`${parts[0]}/${parts[1]}`);
    if (dir === undefined) return undefined;
    const manifest = manifestOf(dir);
    const subpath = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`;
    const target = manifest.exports?.[subpath] ?? (subpath === "." ? manifest.main : undefined);
    return typeof target === "string" ? join(dir, target) : undefined;
  };

  const entries = [
    "apps/web/src/main.tsx",
    "apps/web/src/widget-runtime.ts",
    // The dev host serves this to a frame, so it is a browser graph even though a Node CLI ships it.
    "packages/widget-cli/src/catalog-runtime.tsx",
  ];
  const visited = new Set();
  const offenders = [];
  const visit = (file, via) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\()\s*["'](node:[^"']+)["']/g)) {
      offenders.push(`${relative(file)} imports ${match[1]} — reached from ${via}`);
    }
    for (const match of source.matchAll(/(?:from\s+|import\()\s*["']([^"']+)["']/g)) {
      const next = resolveSpecifier(join(file, ".."), match[1]);
      if (next !== undefined) visit(next, relative(file));
    }
  };

  for (const entry of entries) {
    const file = join(repoRoot, entry);
    if (existsSync(file)) visit(file, entry);
    else c.failures.push(`browser entry ${entry} is missing`);
  }

  for (const offender of offenders.slice(0, 6)) c.failures.push(offender);
  if (offenders.length > 6) c.failures.push(`and ${offenders.length - 6} more reachable module(s)`);
  c.notes.push(`${visited.size} module(s) reachable from ${entries.length} browser entry/entries`);
}
