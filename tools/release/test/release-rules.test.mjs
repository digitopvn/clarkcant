/**
 * The release rules, run through the real `@semantic-release/commit-analyzer` with the real Conventional Commits
 * preset: the SemVer level a commit releases is what semantic-release decides, never a re-implementation of it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { generateNotes } from "@semantic-release/release-notes-generator";

import { BRANCHES, COMMIT_ANALYZER_OPTIONS, NOTES_GENERATOR_OPTIONS, TAG_FORMAT, planOptions } from "../release-config.mjs";

const silent = { log: () => {}, warn: () => {}, error: () => {}, success: () => {} };

let sequence = 0;
async function releaseOf(...messages) {
  const commits = messages.map((message) => {
    sequence += 1;
    return { message, hash: sequence.toString(16).padStart(40, "0") };
  });
  return analyzeCommits(COMMIT_ANALYZER_OPTIONS, { commits, logger: silent, cwd: process.cwd() });
}

test("a breaking change releases a major, by footer or by !", async () => {
  assert.equal(await releaseOf("feat(runtime)!: drop the v1 timeline route"), "major");
  assert.equal(await releaseOf("fix: rename the setting\n\nBREAKING CHANGE: the old key is no longer read"), "major");
  assert.equal(await releaseOf("docs!: the documented port changed"), "major");
});

test("feat releases a minor; fix, perf, build, refactor and revert a patch", async () => {
  assert.equal(await releaseOf("feat(web): a changelog card"), "minor");
  assert.equal(await releaseOf("fix(runtime): keep the queued message"), "patch");
  assert.equal(await releaseOf("perf(storage): index the timeline"), "patch");
  assert.equal(await releaseOf("build(app-desktop): bump Electron"), "patch");
  assert.equal(await releaseOf("refactor(core): split the conductor"), "patch");
  assert.equal(await releaseOf("revert: feat(web): a changelog card\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567."), "patch");
});

test("docs, test, chore, ci and style release nothing", async () => {
  for (const type of ["docs", "test", "chore", "ci", "style"]) {
    assert.equal(await releaseOf(`${type}: a change that ships nothing`), null, type);
    assert.equal(await releaseOf(`${type}(runtime): a scoped change that ships nothing`), null, type);
  }
  assert.equal(await releaseOf("Merge branch 'main' into dev"), null);
});

test("the dist scope marks a non-releasing type as release-affecting", async () => {
  assert.equal(await releaseOf("chore(dist): bundle the CA roots with the desktop app"), "patch");
  assert.equal(await releaseOf("ci(dist): build the arm64 installer"), "patch");
});

test("a revert releases only when the reverted commit would have", async () => {
  const footer = "\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.";
  assert.equal(await releaseOf(`revert: fix(web): keep a/b in step${footer}`), "patch");
  assert.equal(await releaseOf(`Revert "feat(web): a changelog card"${footer}`), "patch");
  assert.equal(await releaseOf(`Revert "refactor!: split the conductor"${footer}`), "patch");
  assert.equal(await releaseOf(`revert: chore(dist): bundle the CA roots${footer}`), "patch");
  assert.equal(await releaseOf(`Revert "ci(dist): build the arm64 installer"${footer}`), "patch");
  assert.equal(await releaseOf(`revert: docs: the port note${footer}`), null);
  assert.equal(await releaseOf(`Revert "chore: tidy the scripts"${footer}`), null);
  assert.equal(await releaseOf(`Revert "test(runtime): a/b fixture"${footer}`), null);
  assert.equal(await releaseOf(`Revert "Merge branch 'dev'"${footer}`), null);
  assert.equal(await releaseOf(`revert!: chore: the old key${footer}`), "major");
});

test("a release made only by dist-scoped commits has notes listing them", async () => {
  const commits = ["chore(dist): bundle the CA roots with the desktop app", "ci(dist): build the arm64 installer"].map(
    (message, index) => ({ hash: String(index + 1).padStart(40, "c"), message, committerDate: "2026-10-06T00:00:00Z" }),
  );
  const notes = await generateNotes(NOTES_GENERATOR_OPTIONS, {
    commits,
    lastRelease: { gitTag: "v0.2.1" },
    nextRelease: { version: "0.2.2", gitTag: "v0.2.2" },
    options: { repositoryUrl: "https://github.com/digitopvn/clarkcant" },
    cwd: process.cwd(),
    logger: silent,
  });
  assert.match(notes, /### Distribution/);
  assert.match(notes, /bundle the CA roots with the desktop app/);
  assert.match(notes, /build the arm64 installer/);
});

test("the highest commit in a range decides", async () => {
  assert.equal(await releaseOf("docs: notes", "fix: a fix", "feat: a feature"), "minor");
  assert.equal(await releaseOf("docs: notes", "test: more tests"), null);
});

test("a revert inside the same range cancels the reverted commit", async () => {
  const feat = "feat(web): a changelog card";
  sequence += 1;
  const hash = sequence.toString(16).padStart(40, "a");
  // Newest first, as semantic-release reads them from `git log`.
  const commits = [
    { message: `Revert "${feat}"\n\nThis reverts commit ${hash}.`, hash: hash.replace(/^a/, "b") },
    { message: feat, hash },
  ];
  assert.equal(await analyzeCommits(COMMIT_ANALYZER_OPTIONS, { commits, logger: silent, cwd: process.cwd() }), null);
});

test("main is stable, dev is the beta prerelease channel, tags are v<version>", () => {
  assert.deepEqual(BRANCHES, [{ name: "main" }, { name: "dev", channel: "beta", prerelease: "beta" }]);
  assert.equal(TAG_FORMAT, "v${version}");
});

test("a planning run loads no plugin that can tag, push or publish", () => {
  const options = planOptions({ repositoryUrl: "/tmp/checkout" });
  assert.equal(options.dryRun, true);
  assert.deepEqual(
    options.plugins.map(([name]) => name),
    ["@semantic-release/commit-analyzer", "@semantic-release/release-notes-generator"],
  );
});
