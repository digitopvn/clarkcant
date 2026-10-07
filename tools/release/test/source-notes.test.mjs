/**
 * Release notes for a checkout run from source, on throwaway repositories: real git, the real parser, analyzer and
 * notes generator, run the way onboarding runs it (`node history.mjs --source`).
 *
 * The committed record stays at the baseline because release builds never commit their stamp back. A checkout that
 * holds the release tags rebuilds the records those releases embedded, and lists nothing a tag does not reach.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

const HISTORY = fileURLToPath(new URL("../history.mjs", import.meta.url));
const LOCAL = join("apps", "runtime", "release-notes.local.json");

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function temporary() {
  const root = mkdtempSync(join(tmpdir(), "clark-source-notes-"));
  roots.push(root);
  return root;
}

function repository() {
  const root = temporary();
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "tag.gpgsign", "false");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "clarkcant", version: "0.2.1", private: true }, null, 2)}\n`);
  mkdirSync(join(root, "apps", "runtime"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "apps/runtime/release-notes.local.json\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "feat: the first conversation");
  git(root, "tag", "v0.2.1");
  return root;
}

function commit(root, message) {
  writeFileSync(join(root, "change.txt"), `${message}\n${Math.random()}\n`);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

/** Refresh the source notes of a checkout: the record it wrote, or the reason it gave. */
function refresh(root, nodeOptions = []) {
  const run = spawnSync(process.execPath, [...nodeOptions, HISTORY, "--source", "--repo", root], { encoding: "utf8" });
  const path = join(root, LOCAL);
  return { status: run.status, stderr: run.stderr, record: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined };
}

test("a checkout lists every release its tags reach, and nothing after the newest tag", () => {
  const root = repository();
  const baseline = git(root, "rev-parse", "HEAD");
  const released = commit(root, "feat(web): a changelog card");
  git(root, "tag", "v0.3.0");
  commit(root, "fix(runtime): keep the queued message");

  const { status, stderr, record } = refresh(root);

  assert.equal(status, 0, stderr);
  // Still the checkout's version on the source channel: the canonical version is not stamped here.
  assert.deepEqual(record.build, { version: "0.2.1", channel: "source" });
  assert.deepEqual(
    record.releases.map(({ version, kind, channel }) => ({ version, kind, channel })),
    [
      { version: "0.3.0", kind: "release", channel: "stable" },
      { version: "0.2.1", kind: "baseline", channel: undefined },
    ],
  );
  assert.deepEqual(record.releases[0].commitRange, { from: baseline, to: released });
  assert.deepEqual(
    record.releases[0].entries.map(({ kind, summary }) => ({ kind, summary })),
    [{ kind: "feature", summary: "a changelog card" }],
  );
  // The untagged fix is not a release, so no record lists it.
  assert.doesNotMatch(JSON.stringify(record), /keep the queued message/);
  assert.equal(record.source, "https://github.com/digitopvn/clarkcant/releases");
  // Ignored, so a refresh never dirties the checkout or blocks the next `git pull`.
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("before any release is published, the notes reach the baseline", () => {
  const root = repository();
  commit(root, "fix(runtime): keep the queued message");

  const { status, stderr, record } = refresh(root);

  assert.equal(status, 0, stderr);
  assert.deepEqual(
    record.releases.map(({ version, kind }) => ({ version, kind })),
    [{ version: "0.2.1", kind: "baseline" }],
  );
});

test("a checkout whose newest release is a beta follows the beta channel", () => {
  const root = repository();
  commit(root, "feat(web): a changelog card");
  git(root, "tag", "v0.3.0");
  git(root, "checkout", "--quiet", "-b", "dev");
  commit(root, "feat(voice): a spoken answer");
  git(root, "tag", "v0.4.0-beta.1");

  const { status, stderr, record } = refresh(root);

  assert.equal(status, 0, stderr);
  assert.deepEqual(
    record.releases.map(({ version, channel }) => ({ version, channel })),
    [
      { version: "0.4.0-beta.1", channel: "beta" },
      { version: "0.3.0", channel: "stable" },
      { version: "0.2.1", channel: undefined },
    ],
  );
});

test("a shallow checkout refuses, names the fix, and removes notes it can no longer rebuild", () => {
  const origin = repository();
  commit(origin, "feat(web): a changelog card");
  git(origin, "tag", "v0.3.0");
  const root = temporary();
  rmSync(root, { recursive: true, force: true });
  execFileSync("git", ["clone", "--quiet", "--depth", "1", pathToFileURL(origin).href, root], { stdio: "ignore" });
  mkdirSync(join(root, "apps", "runtime"), { recursive: true });
  writeFileSync(join(root, LOCAL), "{}\n");

  const { status, stderr, record } = refresh(root);

  assert.equal(status, 1);
  assert.match(stderr, /shallow/);
  assert.match(stderr, /git fetch --unshallow --tags/);
  assert.match(stderr, /notes committed with this checkout/);
  assert.equal(record, undefined);
});

test("a blobless clone, as the installers make, holds the history and tags the notes are rebuilt from", () => {
  const origin = repository();
  git(origin, "config", "uploadpack.allowFilter", "true");
  commit(origin, "feat(web): a changelog card");
  git(origin, "tag", "v0.3.0");
  const root = temporary();
  rmSync(root, { recursive: true, force: true });
  execFileSync("git", ["clone", "--quiet", "--filter=blob:none", pathToFileURL(origin).href, root], { stdio: "ignore" });
  // The throwaway repository tracks no file under it; ClarkCant's does.
  mkdirSync(join(root, "apps", "runtime"), { recursive: true });

  const { status, stderr, record } = refresh(root);

  assert.equal(status, 0, stderr);
  assert.deepEqual(
    record.releases.map(({ version }) => version),
    ["0.3.0", "0.2.1"],
  );
});

test("a checkout that cannot load the contract refuses with a reason and removes notes it can no longer check", () => {
  const root = repository();
  writeFileSync(join(root, LOCAL), "{}\n");
  // The contract fails to load, as it does before `pnpm install` brings its dependencies.
  const hooks = temporary();
  writeFileSync(
    join(hooks, "hooks.mjs"),
    'export async function resolve(specifier, context, next) {\n  if (specifier.endsWith("/release-notes.ts")) throw new Error("zod is not installed");\n  return next(specifier, context);\n}\n',
  );
  writeFileSync(join(hooks, "register.mjs"), `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(join(hooks, "hooks.mjs")).href)});\n`);

  const { status, stderr, record } = refresh(root, ["--import", pathToFileURL(join(hooks, "register.mjs")).href]);

  assert.equal(status, 1);
  assert.match(stderr, /release notes not refreshed: the release-notes contract could not be loaded/);
  assert.match(stderr, /notes committed with this checkout/);
  assert.doesNotMatch(stderr, /\n\s+at /);
  assert.equal(record, undefined);
});

test("a checkout without the baseline tag refuses and names the fetch that brings it", () => {
  const root = repository();
  git(root, "tag", "--delete", "v0.2.1");
  commit(root, "fix(runtime): keep the queued message");

  const { status, stderr, record } = refresh(root);

  assert.equal(status, 1);
  assert.match(stderr, /baseline tag v0\.2\.1 is not reachable/);
  assert.match(stderr, /git fetch --tags/);
  assert.equal(record, undefined);
});
