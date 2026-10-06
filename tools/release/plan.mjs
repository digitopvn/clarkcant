/**
 * Plan the next ClarkCant release, and change nothing.
 *
 * Runs semantic-release in dry-run mode with only the commit analyzer and the notes generator (`release-config.mjs`),
 * against the local checkout, which must hold the full history and every tag. It decides whether the commits since the
 * last release on this branch release anything, and at what version and channel. It never creates a tag, pushes,
 * publishes or opens a release; no plugin that could is loaded.
 *
 * Plans the checkout this file is in, or the one given with `--repo`. Writes, into the directory given with `--out`
 * (default `release-plan/`):
 * - `plan.json`: `{ release: false }`, or the planned release: version, tag, channel, prerelease, previous version,
 *   commit range, and the release-note record and history a build of it embeds (`releaseHistorySchema`);
 * - `notes.md`: the release notes, when there is a release.
 *
 * On GitHub Actions it also writes the step outputs `release`, `version`, `tag`, `channel`, `prerelease`,
 * `previous-version`, `range-from` and `range-to`, and the plan as the job summary.
 *
 * No releasing commit since the last release is a plan too: `release: false`, exit 0.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";

import semanticRelease from "semantic-release";

import { compareReleaseVersions, releaseHistorySchema } from "../../packages/contracts/src/release-notes.ts";
import { readClarkVersion } from "./clark-version.mjs";
import { REPO_ROOT, buildHistory, resolveCommit, tagOf } from "./history.mjs";
import { BASELINE_VERSION, releaseHistory } from "./notes-data.mjs";
import { planOptions } from "./release-config.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

/** semantic-release's own log, kept for the job log but not mixed into this script's output. */
function logStream() {
  return new Writable({
    write(chunk, _encoding, done) {
      process.stderr.write(chunk);
      done();
    },
  });
}

function writeOutputs(values) {
  const path = process.env.GITHUB_OUTPUT;
  if (path === undefined || path === "") return;
  appendFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function writeSummary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path === undefined || path === "") return;
  appendFileSync(path, `${markdown}\n`);
}

export async function plan({ repoRoot = REPO_ROOT, out }) {
  // Checked first: without the baseline tag semantic-release would plan 1.0.0 as if nothing had come before.
  if (resolveCommit(repoRoot, tagOf(BASELINE_VERSION)) === undefined) {
    throw new Error(
      `the baseline tag ${tagOf(BASELINE_VERSION)} does not exist in this checkout. A maintainer creates it once, on the last ` +
        "commit before the first release (docs/releases.md, \"Before the first release\"); fetch tags with full history.",
    );
  }
  const result = await semanticRelease(planOptions({ repositoryUrl: pathToFileURL(repoRoot).href }), {
    cwd: repoRoot,
    env: process.env,
    stdout: logStream(),
    stderr: logStream(),
  });

  mkdirSync(out, { recursive: true });
  if (result === false || result.nextRelease === undefined) {
    writeFileSync(join(out, "plan.json"), `${JSON.stringify({ release: false }, null, 2)}\n`);
    writeOutputs({ release: "false" });
    writeSummary("### Release plan\n\nNo releasing commit since the last release on this branch: nothing to release.");
    return { release: false };
  }

  const { nextRelease, lastRelease } = result;
  const history = await buildHistory(repoRoot, {
    ref: nextRelease.gitHead,
    planned: { version: nextRelease.version, gitHead: nextRelease.gitHead },
    compare: compareReleaseVersions,
  });
  const [record] = history;
  if (record === undefined) throw new Error("the planned release produced no record");
  const channel = record.channel ?? "stable";
  const embedded = releaseHistorySchema.parse(releaseHistory({ version: nextRelease.version, channel, releases: history }));

  const planned = {
    release: true,
    version: nextRelease.version,
    tag: nextRelease.gitTag,
    channel,
    prerelease: channel === "beta",
    type: nextRelease.type,
    previousVersion: lastRelease?.version ?? null,
    commitRange: record.commitRange,
    canonicalVersion: readClarkVersion(repoRoot),
    record,
    history: embedded,
  };
  writeFileSync(join(out, "plan.json"), `${JSON.stringify(planned, null, 2)}\n`);
  writeFileSync(join(out, "notes.md"), `${record.notes}\n`);
  writeOutputs({
    release: "true",
    version: planned.version,
    tag: planned.tag,
    channel: planned.channel,
    prerelease: String(planned.prerelease),
    "previous-version": planned.previousVersion ?? "",
    "range-from": planned.commitRange.from ?? "",
    "range-to": planned.commitRange.to,
  });
  writeSummary(
    [
      `### Release plan: ${planned.tag} (${planned.channel}, ${planned.type})`,
      "",
      `Previous: ${planned.previousVersion ?? "none"} · range ${planned.commitRange.from ?? "first commit"}..${planned.commitRange.to}`,
      `${record.entries.length} entries${record.omittedEntries > 0 ? `, ${record.omittedEntries} more counted` : ""}. Nothing was tagged or published.`,
      "",
      record.notes,
    ].join("\n"),
  );
  return planned;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const repoRoot = resolve(argument("--repo", REPO_ROOT));
  try {
    const planned = await plan({ repoRoot, out: resolve(argument("--out", "release-plan")) });
    process.stdout.write(
      planned.release ? `planned ${planned.tag} on ${planned.channel} (${planned.type})\n` : "no release: nothing releasing since the last release\n",
    );
  } catch (error) {
    process.stderr.write(`release plan failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
