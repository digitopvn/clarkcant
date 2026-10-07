# Releases

> English (default) · [Tiếng Việt](releases.vi.md)

How ClarkCant versions, plans and describes a release. This page covers the release contract (#508, step 0), the plan
and quality-gate workflow, and the changelog capability. **Nothing is published yet.** Packaging, signing, publishing
and the self-updater are later steps, listed under [Not built yet](#not-built-yet).

The machine-owned sources are authoritative where this page summarises them:

- rules: [`tools/release/release-config.mjs`](../tools/release/release-config.mjs)
- plan: [`tools/release/plan.mjs`](../tools/release/plan.mjs)
- version stamping: [`tools/release/clark-version.mjs`](../tools/release/clark-version.mjs)
- workflow: [`.github/workflows/release.yml`](../.github/workflows/release.yml)
- release-note data contract: [`packages/contracts/src/release-notes.ts`](../packages/contracts/src/release-notes.ts)

## One Clark version

The root `package.json` version is the Clark version. Every application under `apps/` (runtime, desktop, web, CLI,
worker) carries the same version, and so does the release record the runtime embeds
(`apps/runtime/release-notes.json`). The `clark-version-single-source` invariant (`pnpm invariants`) fails when any of
them disagree.

Libraries under `packages/` and packs under `packs/` are not on this list. They are workspace sources resolved by path.
The widget tooling has its own release line (`release-widget-tooling.yml`).

A release build stamps the planned version into every one of these files (`tools/release/stamp.mjs`). It never
commits the stamp back: the tag is the record of a published version. The committed tree keeps the version of its last
baseline and the channel `source`.

## Versions from Conventional Commits

semantic-release decides the version from the commits since the last release on the branch. Nothing computes a
version by hand.

| Commit | Release |
|---|---|
| `BREAKING CHANGE:` footer, or `!` after the type/scope | major |
| `feat` | minor |
| `fix`, `perf` | patch |
| `build`: a change to what ships (bundler, Electron, packaging, runtime dependencies) | patch |
| `refactor`: shipped code changes, so an installed Clark always runs bytes a version names | patch |
| `revert` of an already released commit of a releasing type (`feat`, `fix`, `perf`, `build`, `refactor`, `revert`, or any type with scope `dist`) | patch (reverting a breaking change is itself breaking and needs `!`) |
| `revert` of a commit that did not release (`docs`, `test`, `chore`, `ci`, `style`), or whose header is not a Conventional Commit | nothing |
| `revert` of a commit in the same unreleased range | nothing: the pair cancels |
| `docs`, `test`, `chore`, `ci`, `style` | none |
| any type with scope `dist`, e.g. `chore(dist): …` | patch: how a non-releasing type is marked release-affecting; its notes list it under Distribution |

When a range holds several releasing commits, the highest level wins. A range with no releasing commit plans nothing,
and the workflow succeeds without a release.

## Channels

| Branch | Channel | Versions | Tag |
|---|---|---|---|
| `main` | stable | `1.4.0` | `v1.4.0` |
| `dev` | beta | `1.5.0-beta.1`, `1.5.0-beta.2`, … | `v1.5.0-beta.1` |

A beta never reaches the stable channel. Merging `dev` into `main` releases the stable version.

## Release-note data

Each release has one record (`releaseNotesSchema`). It holds:

- the version, channel and date;
- the previous version;
- the commit range (`from` is exclusive, `to` inclusive);
- the generated markdown notes;
- the entries, one per releasing commit, grouped as breaking, feature, fix and other;
- the count of entries left out;
- the artifact summary.

The artifact summary stays empty until signed build stages exist: a record never lists a file that was not
published. Records are bounded: up to 100 entries per release, 40,000 characters of notes, and 20 releases per build.

A build embeds the history it belongs to (`releaseHistorySchema`): its own version and channel, then its releases
newest first. The history ends at the **baseline**: `0.2.1`, the source history before the first published release. The
baseline is labelled as history, never as a published release. The committed record was generated from real git
history with `node tools/release/history.mjs --seed <commit>`.

## The changelog in Clark

The runtime has one changelog capability (`apps/runtime/src/application/changelog.ts`). It reads the embedded record,
so it works offline. Every way of asking reaches it:

- **Conversation:** "Clark có gì mới?", "what changed since 1.4?". The model calls `show_changelog`, and the host
  records the `changelog-card`. The model may summarise the entries in the person's language. It cannot invent one:
  the card is host-owned, and the model reads the entries as data.
- **Slash command:** `/changelog`, or `/changelog 1.4` for what came after 1.4.
- **Settings:** Experience → Version & what's new.
- **Open interface:** `GET /changelog?since=1.4` ([open interfaces](open-interfaces.md)).

The view shows the installed version and channel and the canonical notes. It has no Update action, no update status
and no channel selector, because there is no update service yet.

**Limitation of a build run from source.** The embedded record is written when a release is planned, and the stamp
is never committed back. A checkout therefore carries the committed baseline record, while its code may be ahead of
it. For the `source` channel, the card, `/changelog` and the model all name the commit and date the notes reach
(`notesCover` in the view), and say that the checkout may include later changes that are not listed. While the newest
record is the baseline, the link reads "Full change history" and opens the commit history up to that commit, because no
release has been published yet. A source checkout does not compare itself with its own `HEAD`: a Docker image or a copied tree
has no git history to compare against.

## The release workflow

`.github/workflows/release.yml` runs on pushes to `main` and `dev`, and by hand. It does not run on pull requests, so
the merge gate (`.github/required-checks.json`) is unchanged.

- **plan** checks out the full history with tags and runs the release-tooling tests. It then runs semantic-release in
  dry-run mode with only the commit analyzer and the notes generator loaded. It writes:
  - the outputs `release`, `version`, `tag`, `channel`, `prerelease`, `previous-version`, `range-from` and `range-to`;
  - the job summary;
  - the `release-plan` artifact (`plan.json`, `notes.md`).
- **quality gate** runs only when the plan releases something. It stamps the planned version and history into its
  checkout, then runs `pnpm run verify`.

No job has write permission, an environment or a secret, and none creates a tag or a release.

The release tooling is an isolated pnpm project in `tools/release/`, with its own exact-pinned lockfile. To run it
locally:

```sh
corepack pnpm --dir tools/release install --frozen-lockfile
corepack pnpm --dir tools/release test
node tools/release/plan.mjs --out release-plan   # needs the baseline tag
```

## Before the first release

A maintainer does these once, after the release contract merges:

1. Tag the baseline on the commit the embedded record was built to:
   `git tag -a v0.2.1 806c39686b2b531a4671f519e7d8072041b2a494 -m "baseline: history before the first release"`,
   then `git push origin v0.2.1`. Without it, the plan job fails with that instruction instead of planning `1.0.0`.
2. Create `dev` from `main` and give it a ruleset, as `main` has: pull requests only, no force push, no deletion.
3. Configure the signing environments when credentials exist ([release signing](release-signing.md)).

## Not built yet

| Step | What | Blocked by |
|---|---|---|
| 1 | Packaging spike: Windows MSIX vs Squirrel, macOS bundle, Linux/Omarchy | Decision: [ADR-004](research/adr-004-desktop-packaging.md) (proposal), #193 for Omarchy |
| 2 | Build, sign, verify and publish matrix; checksums; GitHub Release; channel feed | Step 1; signing credentials ([release signing](release-signing.md)) |
| 3 | UpdateService and staging | Step 1 |
| 4 | Supervisor, activation planner, clean next launch | Step 3 |
| 5 | Migration, health check, rollback | Step 4 |
| 6 | Durable continuity across activation | #402 |
| 7 | Update status, Update action, channel selector in the changelog view and Settings | Step 3 |
| 8 | Signed installed-platform smoke and fault injection | Steps 2–5; real Windows/macOS/Omarchy environments |
