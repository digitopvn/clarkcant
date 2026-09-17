#!/usr/bin/env node
/**
 * Probe the optional vector extension on this platform.
 *
 * The vector index needs a loadable extension, and whether it loads is a property of the platform
 * rather than of this code: the repository is developed on one machine and runs on others. This is run
 * by CI for exactly that reason — the Linux x64 pre-gate cannot be checked from a darwin arm64 laptop.
 *
 * Two outcomes are supported and one is not:
 *
 * - **Not installed** is a supported state. Search falls back to lexical retrieval and reports why, so
 *   this exits 0 and says so. `pnpm install` with a lockfile that omits an optional platform package
 *   lands here.
 * - **Installed and usable** exits 0 with the version, so a green run records what was proven.
 * - **Installed and unusable** exits 1. That is a real failure — a package that ships a library which
 *   cannot be loaded, or a `vec0` that cannot create, insert or answer a KNN query — and a silent
 *   fallback would hide it until someone asked why semantic search never runs on that platform.
 *
 * Usage: node tools/probe-vector-extension.mjs
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const platform = `${process.platform}/${process.arch}`;

// Resolved from the package that declares it, not from this file's location: the dependency is
// optional for the runtime, so the root of the workspace is not where it is linked.
const requireFromRuntime = createRequire(join(process.cwd(), "apps", "runtime", "package.json"));

let libraryPath;
try {
  const loaded = requireFromRuntime("sqlite-vec");
  if (typeof loaded.getLoadablePath !== "function") {
    console.error(`vector extension: sqlite-vec is installed on ${platform} but exposes no library path`);
    process.exit(1);
  }
  libraryPath = loaded.getLoadablePath();
} catch {
  console.log(`vector extension: not installed on ${platform} — search stays lexical, with that reason`);
  process.exit(0);
}

const fail = (message) => {
  console.error(`vector extension: ${message}`);
  process.exit(1);
};

const db = new DatabaseSync(":memory:", { allowExtension: true });
try {
  try {
    db.loadExtension(libraryPath);
  } catch (cause) {
    fail(`installed at ${libraryPath} but could not be loaded on ${platform}: ${cause.message}`);
  }

  const version = db.prepare("SELECT vec_version() AS version").get().version;

  // Loading is not the same as working: a vec0 table that cannot be created, written or queried is the
  // failure this probe exists to catch, and each step is checked separately so the message says which.
  try {
    db.exec("CREATE VIRTUAL TABLE probe USING vec0(embedding float[4] distance_metric=cosine)");
  } catch (cause) {
    fail(`vec0 tables cannot be created after loading ${version} on ${platform}: ${cause.message}`);
  }
  try {
    db.prepare("INSERT INTO probe(embedding) VALUES (?)").run(JSON.stringify([1, 0, 0, 0]));
  } catch (cause) {
    fail(`vec0 rejected an insert after loading ${version} on ${platform}: ${cause.message}`);
  }
  try {
    const rows = db.prepare("SELECT rowid FROM probe WHERE embedding MATCH ? AND k = 1").all(
      JSON.stringify([1, 0, 0, 0]),
    );
    if (rows.length !== 1) fail(`a KNN query returned ${rows.length} rows instead of 1 on ${platform}`);
  } catch (cause) {
    fail(`a KNN query failed after loading ${version} on ${platform}: ${cause.message}`);
  }

  console.log(`vector extension: ${version} loaded from ${libraryPath}; create, insert and KNN all work on ${platform}`);
} finally {
  db.close();
}
