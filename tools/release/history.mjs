/**
 * Release history from git: which commits each version shipped, classified by the real Conventional Commits parser
 * and commit analyzer, with notes written by the real release-notes generator.
 *
 * Every published version is a `v<version>` tag, so the history of a build is rebuilt from the tags reachable from it,
 * offline and deterministically: the planned release (last tag..HEAD), each earlier release (its previous tag..its
 * tag), and the baseline (the first commit..`v<BASELINE_VERSION>`), which is the source history before the first
 * published release.
 *
 * Run directly, it writes the committed seed: `node tools/release/history.mjs --seed <commit>` records the baseline up
 * to <commit> in `apps/runtime/release-notes.json`, for the build that runs from source.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { generateNotes } from "@semantic-release/release-notes-generator";
import loadPreset from "conventional-changelog-conventionalcommits";
import { filterRevertedCommitsSync } from "conventional-commits-filter";
import { CommitParser } from "conventional-commits-parser";

import { RELEASE_NOTES_PATH, readClarkVersion } from "./clark-version.mjs";
import { BASELINE_VERSION, BOUNDS, CANONICAL_REPOSITORY, isPrerelease, releaseHistory, releaseRecord } from "./notes-data.mjs";
import { COMMIT_ANALYZER_OPTIONS, NOTES_GENERATOR_OPTIONS, TAG_FORMAT } from "./release-config.mjs";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const SILENT = { log: () => {}, warn: () => {}, error: () => {}, success: () => {} };
const FIELD = "\x1f";
const RECORD = "\x1e";

export function tagOf(version) {
  return TAG_FORMAT.replace("${version}", version);
}

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** The full id of a commit-ish, or `undefined` when it does not resolve. */
export function resolveCommit(repoRoot, ref) {
  try {
    return git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Commits in a range, newest first, as semantic-release reads them. `from` undefined means from the first commit.
 * Merge commits are skipped: a merged branch's own commits carry its changes.
 */
export function commitsBetween(repoRoot, from, to) {
  const range = from === undefined ? to : `${from}..${to}`;
  const out = git(repoRoot, ["log", "--no-merges", `--format=%H${FIELD}%cI${FIELD}%B${RECORD}`, range]);
  return out
    .split(RECORD)
    .map((chunk) => chunk.replace(/^\n+/, ""))
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const [hash = "", committerDate = "", message = ""] = chunk.split(FIELD);
      return { hash, committerDate, message: message.trim() };
    });
}

/** The commit date of a commit, as `YYYY-MM-DD` in UTC. */
export function commitDate(repoRoot, ref) {
  return new Date(git(repoRoot, ["show", "-s", "--format=%cI", ref]).trim()).toISOString().slice(0, 10);
}

let parserPromise;
async function parser() {
  // The preset is synchronous in some versions and a promise in others, as the analyzer itself allows for.
  parserPromise ??= Promise.resolve(loadPreset({})).then((preset) => new CommitParser(preset.parser));
  return parserPromise;
}

/**
 * The commits of a range that release, parsed, newest first. A revert and the commit it reverts inside the same range
 * cancel out, exactly as the analyzer treats them; each remaining commit is analysed on its own with the release rules.
 */
export async function releasingCommits(commits) {
  const commitParser = await parser();
  const parsed = filterRevertedCommitsSync(commits.map((commit) => ({ ...commit, ...commitParser.parse(commit.message) })));
  const releasing = [];
  for (const commit of parsed) {
    const release = await analyzeCommits(COMMIT_ANALYZER_OPTIONS, {
      commits: [{ hash: commit.hash, message: commit.message }],
      logger: SILENT,
      cwd: REPO_ROOT,
    });
    if (release === null) continue;
    // A breaking-change note (a footer, or `!` in the header) is what made the analyzer release a major.
    releasing.push({ ...commit, breaking: (commit.notes ?? []).length > 0 });
  }
  return releasing;
}

/** Markdown notes for a version, written by the release-notes generator with links to the canonical repository. */
export async function notesFor({ version, previousTag, tag, commits }) {
  return generateNotes(NOTES_GENERATOR_OPTIONS, {
    commits: commits.map(({ hash, message, committerDate }) => ({ hash, message, committerDate })),
    lastRelease: previousTag === undefined ? {} : { gitTag: previousTag },
    nextRelease: { version, gitTag: tag },
    options: { repositoryUrl: CANONICAL_REPOSITORY },
    cwd: REPO_ROOT,
    logger: SILENT,
  });
}

/**
 * One release record for a range.
 *
 * Notes are written from the commits the record lists, so a bounded record never carries notes for commits it does not
 * show; the count of the rest is in `omittedEntries`.
 */
export async function recordFor(repoRoot, { version, previousVersion, from, to, baseline = false }) {
  const toCommit = resolveCommit(repoRoot, to);
  if (toCommit === undefined) throw new Error(`${to} is not a commit in this repository`);
  const fromCommit = from === undefined ? undefined : resolveCommit(repoRoot, from);
  if (from !== undefined && fromCommit === undefined) throw new Error(`${from} is not a commit in this repository`);
  const releasing = await releasingCommits(commitsBetween(repoRoot, fromCommit, toCommit));
  const listed = releasing.slice(0, BOUNDS.entries);
  let notes = await notesFor({
    version,
    previousTag: previousVersion === null ? undefined : tagOf(previousVersion),
    tag: baseline ? undefined : tagOf(version),
    commits: listed,
  });
  if (releasing.length > listed.length) {
    notes += `\n\n${releasing.length - listed.length} earlier changes are not listed here; see ${CANONICAL_REPOSITORY}/commits/${toCommit}.`;
  }
  return releaseRecord({
    version,
    baseline,
    date: commitDate(repoRoot, toCommit),
    previousVersion,
    commitRange: { from: fromCommit ?? null, to: toCommit },
    notes,
    commits: releasing,
  });
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Versions with a `v<version>` tag reachable from `ref`, newest first by SemVer precedence. */
export function releasedVersions(repoRoot, ref, compare) {
  return git(repoRoot, ["tag", "--merged", ref, "--list", tagOf("*")])
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag.startsWith("v") && SEMVER.test(tag.slice(1)))
    .map((tag) => tag.slice(1))
    .sort((a, b) => compare(b, a));
}

/**
 * The history embedded with a build of `ref`, newest first: the planned release (when there is one), the published
 * releases before it, and the baseline. Bounded to `BOUNDS.releases` records; older releases stay in the canonical
 * source.
 *
 * A stable build lists stable releases only: once `dev` is merged into `main`, its beta tags are reachable from `main`
 * too, but the stable channel never received them. A beta build lists both, because it followed both.
 */
export async function buildHistory(repoRoot, { ref, planned, compare }) {
  const stable = planned === undefined || !isPrerelease(planned.version);
  const versions = releasedVersions(repoRoot, ref, compare).filter(
    (version) => compare(version, BASELINE_VERSION) >= 0 && (!stable || !isPrerelease(version)),
  );
  if (!versions.includes(BASELINE_VERSION)) {
    throw new Error(
      `the baseline tag ${tagOf(BASELINE_VERSION)} is not reachable from ${ref}; create it on the last commit before the first ` +
        "release (see docs/releases.md) before planning a release",
    );
  }
  const records = [];
  const ordered = planned === undefined ? versions : [planned.version, ...versions];
  for (const [index, version] of ordered.entries()) {
    if (records.length === BOUNDS.releases) break;
    const previousVersion = ordered[index + 1] ?? null;
    const baseline = version === BASELINE_VERSION;
    records.push(
      await recordFor(repoRoot, {
        version,
        previousVersion: baseline ? null : previousVersion,
        from: baseline || previousVersion === null ? undefined : tagOf(previousVersion),
        to: planned !== undefined && index === 0 ? planned.gitHead : tagOf(version),
        baseline,
      }),
    );
    if (baseline) break;
  }
  return records;
}

/** Write the committed seed: the baseline up to `commit`, for a build that runs from source. */
export async function writeSeed(repoRoot, commit) {
  const record = await recordFor(repoRoot, { version: BASELINE_VERSION, previousVersion: null, from: undefined, to: commit, baseline: true });
  const history = releaseHistory({ version: readClarkVersion(repoRoot), channel: "source", releases: [record] });
  writeFileSync(join(repoRoot, RELEASE_NOTES_PATH), `${JSON.stringify(history, null, 2)}\n`);
  return history;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const index = process.argv.indexOf("--seed");
  const commit = index === -1 ? undefined : process.argv[index + 1];
  if (commit === undefined) {
    process.stderr.write("usage: node tools/release/history.mjs --seed <commit>\n");
    process.exit(2);
  }
  const history = await writeSeed(REPO_ROOT, commit);
  const [record] = history.releases;
  process.stdout.write(
    `${RELEASE_NOTES_PATH}: baseline ${record?.version} up to ${record?.commitRange.to}, ` +
      `${record?.entries.length} entries listed, ${record?.omittedEntries} more counted\n`,
  );
}
