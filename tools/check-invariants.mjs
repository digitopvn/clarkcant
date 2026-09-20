#!/usr/bin/env node
/**
 * Repository invariants that TypeScript and ESLint cannot express.
 *
 * These checks exist because the blueprint makes claims that are otherwise only
 * prose: documentation integrity, phase traceability for every stub, the Node
 * type-stripping syntax contract, and the absence of live credentials.
 *
 * Exit code is non-zero when any check fails.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** @type {{name: string, failures: string[], notes: string[]}[]} */
const results = [];

function check(name) {
  const entry = { name, failures: [], notes: [] };
  results.push(entry);
  return entry;
}

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

function readJson(path) {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${path} is not valid JSON`, { cause });
  }
}

/* ------------------------------------------------------------------ *
 * 1. docs/manifest.json integrity — the documentation claims its own
 *    hashes and file list. Verify that claim instead of trusting it.
 * ------------------------------------------------------------------ */
{
  const c = check("docs-manifest-integrity");
  const manifestPath = join(repoRoot, "docs", "manifest.json");
  if (!existsSync(manifestPath)) {
    c.failures.push("docs/manifest.json is missing");
  } else {
    const manifest = readJson(manifestPath);
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

/* ------------------------------------------------------------------ *
 * 2. Every workspace package must declare its blueprint phase, so a stub
 *    can always be traced back to the milestone that owns it.
 * ------------------------------------------------------------------ */
{
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

/* ------------------------------------------------------------------ *
 * 3. Stubs must be honest: a file that is not implemented has to say which
 *    phase owns it, so nobody mistakes scaffolding for working behaviour.
 * ------------------------------------------------------------------ */
{
  const c = check("stub-marks-owning-phase");
  const pattern = /TODO\((P(?:10|[0-9]))\):/;
  const files = [
    ...walk(join(repoRoot, "packages"), (f) => f.endsWith(".ts") && f.includes(`${join("", "src")}`)),
    ...walk(join(repoRoot, "packs"), (f) => f.endsWith(".ts")),
  ];
  let marked = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const looksLikeStub =
      /@implementation-status\s+stub/.test(source) ||
      /throw new NotImplementedError/.test(source);
    if (!looksLikeStub) continue;
    if (!pattern.test(source)) {
      c.failures.push(
        `${relative(repoRoot, file)} is a stub but has no TODO(P<n>): marker naming its owning phase`,
      );
    } else {
      marked += 1;
    }
  }
  c.notes.push(`${marked} stub files carry an owning-phase marker`);
}

/* ------------------------------------------------------------------ *
 * 4. Node executes .ts directly by stripping types. Syntax that needs a real
 *    transform (enum, namespace, parameter properties) would break at runtime,
 *    so it must not appear in files Node is expected to load.
 * ------------------------------------------------------------------ */
{
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
        c.failures.push(`${relative(repoRoot, file)} uses ${what}, which Node cannot strip`);
      }
    }
  }
  c.notes.push(`${files.length} TypeScript files checked for transform-only syntax`);
}

/* ------------------------------------------------------------------ *
 * 5. No live credentials in tracked files, and no repository metadata that
 *    would let a build quietly pick up a secret from the environment.
 * ------------------------------------------------------------------ */
{
  const c = check("no-committed-secrets");
  const patterns = [
    { re: /gh[pousr]_[A-Za-z0-9]{20,}/, what: "GitHub token" },
    { re: /sk-[A-Za-z0-9]{20,}/, what: "OpenAI-style API key" },
    { re: /AKIA[0-9A-Z]{16}/, what: "AWS access key id" },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "private key block" },
    { re: /npm_[A-Za-z0-9]{30,}/, what: "npm token" },
  ];
  const files = [];
  for (const group of ["packages", "apps", "packs", "examples", "docs", "tools"]) {
    files.push(...walk(join(repoRoot, group), (f) => /\.(ts|tsx|js|mjs|json|md|ya?ml)$/.test(f)));
  }
  files.push(join(repoRoot, "package.json"));
  for (const file of files) {
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const { re, what } of patterns) {
      if (re.test(source)) {
        c.failures.push(`${relative(repoRoot, file)} appears to contain a ${what}`);
      }
    }
  }
  c.notes.push(`${files.length} files scanned for credential patterns`);
}

/* ------------------------------------------------------------------ *
 * 6. Dependency specifiers must be pinned. `latest`, `*`, and branch refs make
 *    a build unreproducible, and the blueprint requires exact versions.
 * ------------------------------------------------------------------ */
{
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

/* ------------------------------------------------------------------ *
 * 7. The blueprint names its scope items V01–V18 and acceptance tests
 *    T01–T72. Every one must appear in the traceability document, so a reader
 *    can find out what is real without reading source.
 * ------------------------------------------------------------------ */
{
  const c = check("scope-and-acceptance-traceability");
  const tracePath = join(repoRoot, "docs", "conformance-traceability.md");
  if (!existsSync(tracePath)) {
    c.failures.push("docs/conformance-traceability.md is missing");
  } else {
    const source = readFileSync(tracePath, "utf8");
    for (let i = 1; i <= 18; i += 1) {
      const id = `V${String(i).padStart(2, "0")}`;
      if (!source.includes(id)) c.failures.push(`traceability document omits ${id}`);
    }
    for (let i = 1; i <= 72; i += 1) {
      const id = `T${String(i).padStart(2, "0")}`;
      if (!source.includes(id)) c.failures.push(`traceability document omits ${id}`);
    }

    /*
     * A row that cites a test has to cite one that exists.
     *
     * An independent audit found why this belongs here: T73's row and the plan's voice criterion both named a
     * browser journey that was not in the shipped file, and the browser suite was green precisely because the
     * journey was absent - a test that does not exist cannot fail. Checking that an id appears is not checking
     * that its evidence does, so a ledger could cite a test nobody ever wrote and every gate would agree.
     *
     * Only sentence-shaped quoted titles are checked, because rows also quote Vietnamese messages and file names,
     * and those are not claims about a test.
     */
    const specFiles = ["packages", "apps", "packs", "examples"].flatMap((group) =>
      walk(join(repoRoot, group), (f) => f.endsWith(".spec.ts") || f.endsWith(".spec.tsx")),
    );
    const specText = specFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    const citedTitles = new Set();
    for (const line of source.split("\n")) {
      if (!/^\| (?:T|V)\d+ \|/.test(line)) continue;
      for (const match of line.matchAll(/"([a-z][a-z0-9 ,:'’()/.-]{11,})"/g)) citedTitles.add(match[1]);
    }
    let missing = 0;
    for (const title of citedTitles) {
      if (!specText.includes(title)) {
        c.failures.push(`traceability cites a test that exists nowhere: "${title}"`);
        missing += 1;
      }
    }
    c.notes.push(
      `${citedTitles.size} cited test titles checked against ${specFiles.length} spec files` +
        (missing === 0 ? "" : `, ${missing} missing`),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Every browser entry must be free of Node builtins.
 *
 * A module that reads `node:crypto` at its top is fatal in the dev server and invisible in a bundle, because Rollup
 * tree-shakes an unused import away while Vite's dev server serves each module as written and hoists the interop read
 * to the first line. That asymmetry is exactly how the web client kept a broken dev experience: `WidgetFrame`
 * imported a package's barrel, the barrel imported a digest helper that reads `node:crypto`, the build dropped both,
 * and only `pnpm dev:web` failed — with the error in the browser console and nothing on the page. Walking the entries
 * is what turns the dev path into a gate instead of a surprise.
 * ------------------------------------------------------------------ */
{
  const c = check("browser-entries-avoid-node-builtins");

  const manifestOf = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch (error) {
      // Named here rather than left as a bare SyntaxError from somewhere unhelpful: a manifest this check cannot read
      // is a failure of the check's own input, and the path is what makes that actionable.
      throw new Error(`could not read the manifest of ${relative(repoRoot, dir)}`, { cause: error });
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

  const entries = ["apps/web/src/main.tsx", "apps/web/src/widget-runtime.ts"];
  const visited = new Set();
  const offenders = [];
  const visit = (file, via) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\()\s*["'](node:[^"']+)["']/g)) {
      offenders.push(`${relative(repoRoot, file)} imports ${match[1]} — reached from ${via}`);
    }
    for (const match of source.matchAll(/(?:from\s+|import\()\s*["']([^"']+)["']/g)) {
      const next = resolveSpecifier(join(file, ".."), match[1]);
      if (next !== undefined) visit(next, relative(repoRoot, file));
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

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
let failed = 0;
const lines = [];
for (const entry of results) {
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
process.stdout.write(`all ${results.length} invariant checks passed\n`);
