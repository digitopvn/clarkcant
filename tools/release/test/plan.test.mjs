/**
 * The plan job end to end, on throwaway repositories: real git, real semantic-release in dry-run mode, run the way the
 * workflow runs it (`node plan.mjs`). A child process rather than an import, because semantic-release hooks the
 * process's standard streams while it runs, which would garble the test runner's own reporting.
 *
 * Covers what the release workflow relies on: a stable plan on `main`, a beta plan on `dev`, the successful no-op when
 * nothing releases, the refusal without the baseline tag, and that planning creates no tag.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const PLAN = fileURLToPath(new URL("../plan.mjs", import.meta.url));

/** Run the plan on a repository: the plan it wrote, or the failure it reported. */
async function plan({ repoRoot, out: dir }) {
  // Without the Actions variables: a test plan must not write outputs, summaries or annotations into the job running it.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !["GITHUB_ACTIONS", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"].includes(name)),
  );
  const run = spawnSync(process.execPath, [PLAN, "--repo", repoRoot, "--out", dir], { encoding: "utf8", env });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
}

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "clark-release-plan-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "tag.gpgsign", "false");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "clarkcant", version: "0.2.1", private: true }, null, 2)}\n`);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "feat: the first conversation");
  return root;
}

function commit(root, message) {
  writeFileSync(join(root, "change.txt"), `${message}\n${Math.random()}\n`);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function baseline(root) {
  git(root, "tag", "v0.2.1");
}

const out = (root) => join(root, ".release-plan");

test("main plans the next stable version from the commits since the last release", async () => {
  const root = repository();
  baseline(root);
  const from = git(root, "rev-parse", "HEAD");
  commit(root, "docs: explain the orb");
  const to = commit(root, "fix(runtime): keep the queued message");

  const planned = await plan({ repoRoot: root, out: out(root) });

  assert.equal(planned.release, true);
  assert.equal(planned.version, "0.2.2");
  assert.equal(planned.tag, "v0.2.2");
  assert.equal(planned.channel, "stable");
  assert.equal(planned.prerelease, false);
  assert.equal(planned.previousVersion, "0.2.1");
  assert.deepEqual(planned.commitRange, { from, to });
  assert.deepEqual(
    planned.record.entries.map(({ kind, summary, scope }) => ({ kind, summary, scope })),
    [{ kind: "fix", summary: "keep the queued message", scope: "runtime" }],
  );
  assert.match(planned.record.notes, /keep the queued message/);
  assert.doesNotMatch(planned.record.notes, /explain the orb/);
  // The build history: the planned release, then the baseline it follows.
  assert.deepEqual(
    planned.history.releases.map(({ version, kind }) => ({ version, kind })),
    [
      { version: "0.2.2", kind: "release" },
      { version: "0.2.1", kind: "baseline" },
    ],
  );
  assert.deepEqual(planned.history.build, { version: "0.2.2", channel: "stable" });
  assert.equal(JSON.parse(readFileSync(join(out(root), "plan.json"), "utf8")).version, "0.2.2");
  assert.match(readFileSync(join(out(root), "notes.md"), "utf8"), /keep the queued message/);
  // Planning tags nothing.
  assert.equal(git(root, "tag", "--list"), "v0.2.1");
});

test("a feat plans a minor and a breaking change a major", async () => {
  const root = repository();
  baseline(root);
  commit(root, "feat(web): a changelog card");
  assert.equal((await plan({ repoRoot: root, out: out(root) })).version, "0.3.0");
  commit(root, "feat(runtime)!: drop the v1 timeline route");
  const planned = await plan({ repoRoot: root, out: out(root) });
  assert.equal(planned.version, "1.0.0");
  assert.equal(planned.record.entries[0]?.kind, "breaking");
});

test("dev plans a beta prerelease on the beta channel", async () => {
  const root = repository();
  baseline(root);
  git(root, "checkout", "--quiet", "-b", "dev");
  commit(root, "feat(web): a changelog card");

  const planned = await plan({ repoRoot: root, out: out(root) });

  assert.equal(planned.version, "0.3.0-beta.1");
  assert.equal(planned.tag, "v0.3.0-beta.1");
  assert.equal(planned.channel, "beta");
  assert.equal(planned.prerelease, true);
  assert.deepEqual(planned.history.build, { version: "0.3.0-beta.1", channel: "beta" });
});

test("nothing releasing since the last release is a successful no-op", async () => {
  const root = repository();
  baseline(root);
  commit(root, "docs: explain the orb");
  commit(root, "test: cover the orb");
  commit(root, "ci: cache the store");

  const planned = await plan({ repoRoot: root, out: out(root) });

  assert.deepEqual(planned, { release: false });
  assert.deepEqual(JSON.parse(readFileSync(join(out(root), "plan.json"), "utf8")), { release: false });
});

test("without the baseline tag, planning refuses instead of starting at 1.0.0", async () => {
  const root = repository();
  commit(root, "fix: a fix");
  await assert.rejects(plan({ repoRoot: root, out: out(root) }), /baseline tag v0\.2\.1/);
});

test("the refusal names the commit the baseline tag belongs on and the command that creates it", async () => {
  const root = repository();
  const tip = git(root, "rev-parse", "HEAD");
  mkdirSync(join(root, "apps", "runtime"), { recursive: true });
  writeFileSync(
    join(root, "apps", "runtime", "release-notes.json"),
    JSON.stringify({
      schemaVersion: 1,
      build: { version: "0.2.1", channel: "source" },
      source: `https://github.com/digitopvn/clarkcant/commits/${tip}`,
      releases: [
        {
          version: "0.2.1",
          kind: "baseline",
          date: "2026-10-06",
          previousVersion: null,
          commitRange: { from: null, to: tip },
          notes: "",
          entries: [],
          omittedEntries: 0,
          artifacts: [],
        },
      ],
    }),
  );
  commit(root, "fix: a fix");
  await assert.rejects(plan({ repoRoot: root, out: out(root) }), (error) => {
    assert.match(error.message, new RegExp(`git tag -a v0\\.2\\.1 ${tip} `));
    assert.match(error.message, /Nothing was tagged or published/);
    return true;
  });
});
