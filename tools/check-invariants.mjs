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
import { fileURLToPath, pathToFileURL } from "node:url";

import { uncoveredFiles } from "./tsconfig-coverage.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const REGISTRY_PATH = "packages/contracts/src/implementation-status.ts";

/**
 * The registry is loaded rather than parsed, because it is a typed module: a status claim and the
 * package metadata it points at are checked against each other, not against a regex.
 *
 * A load failure is reported by the check that needs it instead of crashing this script, so a
 * broken registry still prints the check that owns it. Node strips the types of a `.ts` file for
 * the same reason the runtime can execute one.
 */
let statusRegistry = null;
let statusRegistryError = null;
try {
  ({ IMPLEMENTATION_STATUS: statusRegistry } = await import(
    pathToFileURL(join(repoRoot, REGISTRY_PATH)).href,
  ));
} catch (error) {
  statusRegistryError = error;
}

/** Registry entries by capability id, or an empty map when the registry could not be loaded. */
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
    /*
     * A status reference is a stub claim when the registry does not call it implemented. That is why
     * this reads the registry instead of a marker: the marker used to be a second copy of the status,
     * so a file could say "stub" while the registry said otherwise and both would look fine.
     *
     * When the registry could not be loaded, every reference resolves to nothing, so this stays
     * quiet: check 10 reports the load failure, and turning it into a stub claim here would bury it
     * under owning-phase failures in files that carry no marker at all.
     */
    const stubRef =
      /@implementation-status\s+stub/.test(source) ||
      (statusRegistry !== null &&
        [...source.matchAll(/@status-ref\s+([A-Za-z0-9.-]+)/g)].some(
          (match) => statusById.get(match[1])?.status !== "implemented",
        ));
    const looksLikeStub = stubRef || /throw new NotImplementedError/.test(source);
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
 *    T01–T73. Every one must have its own row in the traceability document, so
 *    a reader can find out what is real without reading source.
 * ------------------------------------------------------------------ */
{
  const c = check("scope-and-acceptance-traceability");
  const tracePath = join(repoRoot, "docs", "conformance-traceability.md");
  if (!existsSync(tracePath)) {
    c.failures.push("docs/conformance-traceability.md is missing");
  } else {
    const source = readFileSync(tracePath, "utf8");
    /*
     * A row marker, not a substring anywhere in the file.
     *
     * The previous version asked `source.includes(id)`, and the prose that introduces this table
     * spells the ranges `V01`–`V18` and `T01`–`T73` out in full - so both ends of each range were
     * satisfied by that sentence alone, and deleting the `| T73 | …` row left every check green. A
     * presence check has to be about the row, because the row is what a reader uses.
     */
    const rowIds = new Set([...source.matchAll(/^\| (V\d{2}|T\d{2}) \|/gm)].map((match) => match[1]));
    for (let i = 1; i <= 18; i += 1) {
      const id = `V${String(i).padStart(2, "0")}`;
      if (!rowIds.has(id)) c.failures.push(`traceability document omits the ${id} row`);
    }
    for (let i = 1; i <= 73; i += 1) {
      const id = `T${String(i).padStart(2, "0")}`;
      if (!rowIds.has(id)) c.failures.push(`traceability document omits the ${id} row`);
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

    /*
     * The loop above is the whole of this check, and its limit is worth naming where the check lives: a
     * row is held to a quoted title only when it quotes one. A companion rule that also accepted a bare
     * spec basename was tried and removed, because it proved nothing about the row it sat on - an
     * unrelated but existing file name (`see widget.spec for the detail`) satisfied it. Proving a PASS or
     * PARTIAL row is what it claims would mean requiring a quoted title that exists on every row, which
     * several rows cannot give: their evidence is an integration path rather than one titled case.
     */
    c.notes.push(
      `${citedTitles.size} cited test titles checked against ${specFiles.length} spec files` +
        (missing === 0 ? "" : `, ${missing} missing`) +
        "; rows that cite a path rather than a quoted title are not matched to a case",
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
 * 9. The execution policy has exactly one reader.
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
 * ------------------------------------------------------------------ */
{
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
    .map((path) => relative(repoRoot, path))
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

/* ------------------------------------------------------------------ *
 * 10. The implementation-status registry.
 *
 * A registry that lies is worse than no registry, so this check is not a spelling test on a data
 * file. It holds four properties at once:
 *
 *   - every entry names a workspace package that exists, with that package's declared phase;
 *   - `implemented` names at least one test, and each named test exists in the file it names (the
 *     reason "the schema exists" is not allowed to pass is here: a schema has no title);
 *   - every other status names what is missing, and the four external gates this program must keep
 *     open (#2 Calendar account, #3 Computer Use signing, #4 live voice provider, #5 two-host
 *     NodeLink) stay represented by at least one entry, so a gate cannot quietly stop being a gate;
 *   - every `@status-ref` in source resolves, every scope id agrees with
 *     docs/conformance-traceability.md, and no `@implementation-status` marker survives.
 * ------------------------------------------------------------------ */
{
  const c = check("implementation-status-registry");
  const statuses = new Set(["implemented", "partial", "blocked", "not-implemented"]);
  const docStatusOf = {
    implemented: "PASS",
    partial: "PARTIAL",
    blocked: "BLOCKED",
    "not-implemented": "NOT-IMPLEMENTED",
  };

  if (statusRegistryError) {
    c.failures.push(`${REGISTRY_PATH} could not be loaded: ${statusRegistryError.message}`);
  } else if (!Array.isArray(statusRegistry)) {
    c.failures.push(`${REGISTRY_PATH} does not export an IMPLEMENTATION_STATUS array`);
  } else {
    const packagesByName = new Map();
    for (const group of ["packages", "apps", "packs", "examples"]) {
      const groupDir = join(repoRoot, group);
      if (!existsSync(groupDir)) continue;
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        const manifestPath = join(groupDir, entry.name, "package.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = readJson(manifestPath);
        packagesByName.set(manifest.name, { phase: manifest.clarkcant?.phase, path: `${group}/${entry.name}` });
      }
    }

    const seenIds = new Set();
    for (const entry of statusRegistry) {
      const id = entry?.capabilityId;
      const label = typeof id === "string" ? id : "(entry without a capabilityId)";
      if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9.-]*$/.test(id)) {
        c.failures.push(`${label} is not a usable capability id`);
      } else if (seenIds.has(id)) {
        c.failures.push(`the registry defines ${id} more than once`);
      } else {
        seenIds.add(id);
      }
      if (!statuses.has(entry.status)) {
        c.failures.push(`${label} has status ${JSON.stringify(entry.status)}, which is not one of the four`);
      }
      if (typeof entry.summary !== "string" || entry.summary.length === 0) {
        c.failures.push(`${label} has no summary`);
      }
      const owner = packagesByName.get(entry.owningPackage);
      if (owner === undefined) {
        c.failures.push(`${label} names owning package ${entry.owningPackage}, which is not a workspace package`);
      } else if (owner.phase !== entry.phase) {
        c.failures.push(
          `${label} says phase ${entry.phase} but ${owner.path} declares clarkcant.phase ${owner.phase}`,
        );
      }

      const evidence = Array.isArray(entry.evidenceTests) ? entry.evidenceTests : [];
      if (!Array.isArray(entry.evidenceTests)) {
        c.failures.push(`${label} has no evidenceTests array`);
      }
      for (const item of evidence) {
        const full = typeof item?.file === "string" ? join(repoRoot, item.file) : null;
        if (full === null || !existsSync(full)) {
          c.failures.push(`${label} names a test file that does not exist: ${item?.file}`);
          continue;
        }
        if (item.test !== undefined && !readFileSync(full, "utf8").includes(item.test)) {
          c.failures.push(`${label} names a test that is not in ${item.file}: "${item.test}"`);
        }
      }

      if (entry.status === "implemented") {
        if (evidence.length === 0) {
          c.failures.push(`${label} is implemented but names no test at all`);
        }
        for (const item of evidence) {
          if (item.test === undefined) {
            c.failures.push(`${label} is implemented but its evidence for ${item?.file} is untitled`);
          }
        }
        if (entry.externalGate !== undefined) {
          c.failures.push(`${label} is implemented and still carries an external gate; one of the two is wrong`);
        }
      }
      if (entry.status === "partial" && evidence.length === 0) {
        c.failures.push(`${label} is partial but names no test for the layer that does work`);
      }
      if (entry.status !== "implemented" && typeof entry.externalGate?.reason !== "string") {
        c.failures.push(`${label} is ${entry.status} but does not name what is missing`);
      }
    }

    /* Every `@status-ref` in source has to resolve, and no self-asserting marker may come back. */
    const sources = ["packages", "apps", "packs", "examples"]
      .flatMap((group) => walk(join(repoRoot, group), (path) => /\.tsx?$/.test(path)))
      .map((path) => relative(repoRoot, path));
    let references = 0;
    for (const path of sources) {
      const source = readFileSync(join(repoRoot, path), "utf8");
      for (const match of source.matchAll(/@status-ref\s+([A-Za-z0-9.-]+)/g)) {
        references += 1;
        if (!statusById.has(match[1])) {
          c.failures.push(`${path} references capability ${match[1]}, which the registry does not define`);
        }
      }
      if (source.includes("@implementation-status")) {
        c.failures.push(
          `${path} still carries an @implementation-status marker; status lives in ${REGISTRY_PATH} - point at it with @status-ref <capabilityId>`,
        );
      }
    }
    if (references === 0) {
      c.failures.push("no source file references the registry, so this check has no subject");
    }

    /* Scope ids carry two statuses at once, so they are checked against each other. */
    const tracePath = join(repoRoot, "docs", "conformance-traceability.md");
    const traceability = readFileSync(tracePath, "utf8");
    const documented = new Map();
    for (const line of traceability.split("\n")) {
      const row = line.match(/^\| (V\d{2}) \| (PASS|PARTIAL|BLOCKED|NOT-IMPLEMENTED) \|/);
      if (row) documented.set(row[1], row[2]);
    }
    for (const [id, documentedStatus] of documented) {
      const entry = statusById.get(id);
      if (entry === undefined) {
        c.failures.push(`docs/conformance-traceability.md states ${id} but the registry has no entry for it`);
      } else if (docStatusOf[entry.status] !== documentedStatus) {
        c.failures.push(
          `${id}: registry says ${entry.status} (${docStatusOf[entry.status]}) but the traceability document says ${documentedStatus}`,
        );
      }
    }
    for (const entry of statusRegistry) {
      if (/^V\d{2}$/.test(entry.capabilityId) && !documented.has(entry.capabilityId)) {
        c.failures.push(`the registry carries ${entry.capabilityId}, which docs/conformance-traceability.md omits`);
      }
    }

    /*
     * The external gates are the point of being honest about blocked work, so they stay named.
     * Only the four this program must keep open are pinned to an issue number, and any other issue
     * number is rejected rather than ignored: the header rule that a gap waiting on nothing outside
     * this repository is described by the gap itself is a rule about the field, not advice for the
     * reader, and a rejected number is the only way a check can enforce it.
     */
    const openGates = [2, 3, 4, 5];
    const gateIssues = new Set();
    for (const entry of statusRegistry) {
      const issue = entry.externalGate?.issue;
      if (typeof issue !== "number") continue;
      if (!openGates.includes(issue)) {
        c.failures.push(
          `${entry.capabilityId} pins its external gate to #${issue}; #${openGates.join("/#")} are the only gates this program keeps open, and a gap that waits on nothing outside the repository is described by the gap itself`,
        );
        continue;
      }
      gateIssues.add(issue);
    }
    for (const issue of openGates) {
      if (!gateIssues.has(issue)) {
        c.failures.push(`external gate #${issue} is no longer represented by any registry entry`);
      }
    }

    c.notes.push(
      `${statusRegistry.length} entries (${[...statusRegistry].filter((e) => e.status === "implemented").length} implemented, ` +
        `${[...statusRegistry].filter((e) => e.status === "partial").length} partial, ` +
        `${[...statusRegistry].filter((e) => e.status === "blocked").length} blocked, ` +
        `${[...statusRegistry].filter((e) => e.status === "not-implemented").length} not-implemented) verified against ${packagesByName.size} workspace packages`,
    );
    c.notes.push(`${references} @status-ref reference(s) across ${sources.length} source files`);
    c.notes.push(`${documented.size} V row(s) agree with the registry; gates #${[...gateIssues].sort((a, b) => a - b).join("/#")} represented`);
    c.notes.push(
      "evidence is checked for existence, not for execution: a named test that a runtime condition skips " +
        "(the socket suite runs under describe.skipIf(!POSIX)) still counts as evidence",
    );
  }
}

/* ------------------------------------------------------------------ *
 * 11. Every `.tsx` in the workspace is covered by a typecheck include.
 *
 * `tsconfig.json` matches `.ts` and never `.tsx`, and `tsconfig.web.json` names only the web roots it covers. A
 * `.tsx` outside those roots is therefore in neither program: `pnpm typecheck` passes, `pnpm verify` passes, and
 * nothing has read the file. The widget CLI's browser entry was written into exactly that hole and escaped only
 * because its path was added to `tsconfig.web.json` by hand.
 *
 * The config list is read out of the `typecheck` script rather than naming the two files here, so a third config
 * is covered the moment it is wired in — and the check fails when it resolves no config or finds no `.tsx`, so it
 * cannot pass by having lost its own subject. The matching lives in tsconfig-coverage.mjs so it can be tested.
 * ------------------------------------------------------------------ */
{
  const c = check("tsx-files-are-typechecked");
  const roots = ["packages", "apps", "packs", "examples", "tools"];
  const files = roots
    .flatMap((root) => walk(join(repoRoot, root), (path) => path.endsWith(".tsx")))
    .map((path) => relative(repoRoot, path));

  const typecheck = readJson(join(repoRoot, "package.json")).scripts?.typecheck ?? "";
  const names = [...typecheck.matchAll(/-p\s+(\S+)/g)].map((match) => match[1]);
  const configs = [];
  for (const name of names) {
    const configPath = join(repoRoot, name);
    if (!existsSync(configPath)) {
      c.failures.push(`the typecheck script names ${name}, which does not exist`);
      continue;
    }
    configs.push({ name, ...readJson(configPath) });
  }

  if (configs.length === 0) {
    c.failures.push("no typecheck config could be read, so this check has no subject");
  }
  if (files.length === 0) {
    c.failures.push("no .tsx file was found, so this check has no subject");
  }

  const { uncovered, problems } = uncoveredFiles(files, configs);
  for (const problem of problems) c.failures.push(problem);
  for (const file of uncovered.slice(0, 6)) {
    c.failures.push(
      `${file} is in no typecheck include (${names.join(", ")}), so nothing typechecks it: add its path to one of them`,
    );
  }
  if (uncovered.length > 6) {
    c.failures.push(`and ${uncovered.length - 6} more .tsx file(s) in no typecheck include`);
  }
  c.notes.push(
    `${files.length} .tsx file(s) checked against ${configs.length} typecheck config(s) — ${names.join(", ")}`,
  );
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
