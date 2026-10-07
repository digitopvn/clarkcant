/**
 * ClarkCant's release rules: which commits release, at what SemVer level, on which channel.
 *
 * semantic-release decides the version from Conventional Commits; nothing here computes a version by hand. This module
 * is the one place the rules are written, read by `plan.mjs` (the release workflow's plan job) and by the tests in
 * `test/`, which run the real commit analyzer over these rules. `docs/releases.md` explains them for people; when the
 * two disagree, this file is what CI runs.
 *
 * Channels:
 * - `main` releases stable versions (`1.4.0`), tagged `v1.4.0`.
 * - `dev` releases beta prereleases of the next version (`1.5.0-beta.1`, `1.5.0-beta.2`, ...). A beta is never
 *   published on the stable channel; merging `dev` into `main` releases the stable version.
 *
 * SemVer from Conventional Commits:
 * - `BREAKING CHANGE:` footer, or `!` after the type/scope: major.
 * - `feat`: minor.
 * - `fix`, `perf`: patch.
 * - `build`: patch. A build change alters what is shipped (bundler, Electron, packaging, runtime dependencies). A
 *   change to developer tooling only is `chore`, not `build`.
 * - `refactor`: patch. A refactor changes shipped code without changing intended behaviour; it still ships, so an
 *   installed Clark always runs bytes that a version names, and a regression it causes is traceable to a version.
 * - `revert`: patch when the reverted commit would have released, otherwise nothing. A revert of a commit in the same
 *   unreleased range cancels both commits (the analyzer drops the pair), so nothing ships for them; a revert of an
 *   already released commit ships as a patch, even when the reverted commit was a `feat`. Reverting a breaking change
 *   is itself breaking and must say so with `!`.
 * - `docs`, `test`, `chore`, `ci`, `style`: no release.
 * - Any type with the scope `dist` (for example `chore(dist): bundle the CA roots with the desktop app`): patch.
 *   This is how a change of an otherwise non-releasing type is marked release-affecting.
 *
 * A range with no releasing commit plans no release: the workflow succeeds and publishes nothing.
 */

/** The tag every release gets. The widget tooling's own tags (`widget-tooling-v*`) never match it. */
export const TAG_FORMAT = "v${version}";

/** The prerelease identifier of the beta channel. */
export const BETA_PRERELEASE = "beta";

export const BRANCHES = [
  { name: "main" },
  { name: "dev", channel: "beta", prerelease: BETA_PRERELEASE },
];

/** Release-affecting scope: a commit of any type with this scope releases a patch. */
export const DIST_SCOPE = "dist";

/** Types that never release on their own. */
export const NON_RELEASING_TYPES = ["docs", "test", "chore", "ci", "style"];

/** Types that release a patch or more on their own. */
export const RELEASING_TYPES = ["feat", "fix", "perf", "build", "refactor", "revert"];

/**
 * Globs (micromatch, as the analyzer matches string fields) for the header of a reverted commit. `[\s\S]` is used
 * because `*` would stop at a `/` in the description.
 */
const REVERTED_RELEASING_HEADER = `@(${RELEASING_TYPES.join("|")})[(!:]+([\\s\\S])`;
const REVERTED_DIST_HEADER = `+([a-z])\\(${DIST_SCOPE}\\)[!:]+([\\s\\S])`;

/**
 * Rules for `@semantic-release/commit-analyzer`. Every matching rule is evaluated in order and the highest release
 * wins, with one catch the analyzer has: a `release: false` rule matched after a release would cancel it. So the
 * breaking rule comes first (a major stops the evaluation), then every `false` baseline, then the rules that release.
 *
 * A revert releases a patch only when the commit it reverts would have released: `revert: feat: …` and git's own
 * `Revert "fix(web): …"` ship, `revert: docs: …` and `Revert "chore: …"` do not, and `chore(dist)` reverted ships
 * again because the dist scope made it release-affecting. A revert whose header names no Conventional Commit releases
 * nothing.
 */
export const RELEASE_RULES = [
  { breaking: true, release: "major" },
  ...NON_RELEASING_TYPES.map((type) => ({ type, release: false })),
  { type: "revert", release: false },
  { revert: true, release: false },
  { type: "feat", release: "minor" },
  { type: "fix", release: "patch" },
  { type: "perf", release: "patch" },
  { type: "build", release: "patch" },
  { type: "refactor", release: "patch" },
  { type: "revert", subject: REVERTED_RELEASING_HEADER, release: "patch" },
  { type: "revert", subject: REVERTED_DIST_HEADER, release: "patch" },
  { revert: true, header: `Revert "${REVERTED_RELEASING_HEADER}`, release: "patch" },
  { revert: true, header: `Revert "${REVERTED_DIST_HEADER}`, release: "patch" },
  { scope: DIST_SCOPE, release: "patch" },
];

/**
 * Release-note sections, in the order they are written. A non-releasing type with the dist scope released, so it is
 * listed under Distribution; the scoped entries come first because the notes generator uses the first match. Without
 * the scope those types are hidden: they never release, so a note can only list what a release actually shipped.
 */
export const NOTE_SECTIONS = [
  ...NON_RELEASING_TYPES.map((type) => ({ type, scope: DIST_SCOPE, section: "Distribution" })),
  { type: "feat", section: "Features" },
  { type: "fix", section: "Bug Fixes" },
  { type: "perf", section: "Performance Improvements" },
  { type: "revert", section: "Reverts" },
  { type: "build", section: "Distribution" },
  { type: "refactor", section: "Code Refactoring" },
  ...NON_RELEASING_TYPES.map((type) => ({ type, hidden: true })),
];

const PRESET = "conventionalcommits";

/** The plugin options both plugins share, so the analyzer and the notes parse a commit the same way. */
export const COMMIT_ANALYZER_OPTIONS = { preset: PRESET, releaseRules: RELEASE_RULES };
export const NOTES_GENERATOR_OPTIONS = { preset: PRESET, presetConfig: { types: NOTE_SECTIONS } };

/**
 * The semantic-release options for a planning run.
 *
 * Only the analyzer and the notes generator are loaded: planning computes a version and notes and changes nothing.
 * No plugin that tags, pushes, publishes to npm or creates a GitHub Release is configured, so even a run without
 * `dryRun` could not publish. Publishing is added with the signed artifact stages (see `docs/releases.md`).
 *
 * `repositoryUrl` is the local checkout: semantic-release reads tags and notes from it and never needs a token.
 */
export function planOptions({ repositoryUrl }) {
  return {
    branches: BRANCHES,
    tagFormat: TAG_FORMAT,
    repositoryUrl,
    dryRun: true,
    ci: false,
    plugins: [
      ["@semantic-release/commit-analyzer", COMMIT_ANALYZER_OPTIONS],
      ["@semantic-release/release-notes-generator", NOTES_GENERATOR_OPTIONS],
    ],
  };
}
