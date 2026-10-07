/**
 * The one ClarkCant version, and every place a build carries it.
 *
 * The root `package.json` version is canonical. Every application under `apps/` (runtime, desktop, web, CLI, worker)
 * ships as part of Clark and carries the same version, and so does the build record the runtime embeds
 * (`apps/runtime/release-notes.json`). Libraries under `packages/` and capability packs under `packs/` are not listed:
 * they are workspace sources resolved by path (or, for the widget tooling, published on their own version line).
 *
 * The invariant `clark-version-single-source` fails when any of these disagree, and `stampVersion` is the only writer
 * a release uses: it sets every one of them from the version semantic-release planned, so a build cannot carry two
 * versions. Dependency-free, so the invariant runner can import it without the release tooling installed.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RELEASE_NOTES_PATH = "apps/runtime/release-notes.json";

/**
 * The record a checkout run from source rebuilds from its own release tags (`history.mjs --source`). Git-ignored and
 * never stamped: it carries the same build version as the committed record, which the runtime requires before reading it.
 */
export const SOURCE_RELEASE_NOTES_PATH = "apps/runtime/release-notes.local.json";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Repository-relative paths of the manifests that carry the Clark version, the canonical root first. */
export function clarkVersionManifests(repoRoot) {
  const apps = readdirSync(join(repoRoot, "apps"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(repoRoot, "apps", entry.name, "package.json")))
    .map((entry) => `apps/${entry.name}/package.json`)
    .sort();
  return ["package.json", ...apps];
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The canonical version, from the root manifest. Throws when it is missing or not a version. */
export function readClarkVersion(repoRoot) {
  const version = readJsonFile(join(repoRoot, "package.json")).version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`package.json carries no valid Clark version (got ${JSON.stringify(version)})`);
  }
  return version;
}

/**
 * Every place that disagrees with the canonical version, as sentences; empty when the build carries one version.
 */
export function clarkVersionDrift(repoRoot) {
  const canonical = readClarkVersion(repoRoot);
  const problems = [];
  for (const manifest of clarkVersionManifests(repoRoot).slice(1)) {
    const version = readJsonFile(join(repoRoot, manifest)).version;
    if (version !== canonical) problems.push(`${manifest} has version ${JSON.stringify(version)}; the Clark version is ${canonical}`);
  }
  const notesPath = join(repoRoot, RELEASE_NOTES_PATH);
  if (!existsSync(notesPath)) {
    problems.push(`${RELEASE_NOTES_PATH} is missing; the runtime embeds it to answer what changed`);
  } else {
    const build = readJsonFile(notesPath).build;
    if (build?.version !== canonical) {
      problems.push(`${RELEASE_NOTES_PATH} describes build ${JSON.stringify(build?.version)}; the Clark version is ${canonical}`);
    }
  }
  return problems;
}

/** Write a JSON file back the way the repository formats it: two spaces and a trailing newline. */
function writeJsonFile(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Set the Clark version everywhere a build carries it, and the build record's channel.
 *
 * Used on a release build's checkout, never committed back: the tag is the record of a published version, and the
 * committed tree keeps the version line of its last baseline. Key order in each manifest is kept.
 *
 * @param {string} repoRoot
 * @param {{ version: string, channel: "stable" | "beta" | "source", releases?: unknown[] }} build
 */
export function stampVersion(repoRoot, build) {
  if (!SEMVER.test(build.version)) throw new Error(`${JSON.stringify(build.version)} is not a version`);
  for (const manifest of clarkVersionManifests(repoRoot)) {
    const path = join(repoRoot, manifest);
    const pkg = readJsonFile(path);
    pkg.version = build.version;
    writeJsonFile(path, pkg);
  }
  const notesPath = join(repoRoot, RELEASE_NOTES_PATH);
  const history = readJsonFile(notesPath);
  history.build = { version: build.version, channel: build.channel };
  if (build.releases !== undefined) history.releases = build.releases;
  writeJsonFile(notesPath, history);
}
