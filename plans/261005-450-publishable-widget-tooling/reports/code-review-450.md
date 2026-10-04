# Code review: #450 publishable widget tooling (commit 8ac06e91)

Scope: `git diff 94fb3a72 8ac06e91`, 21 files, +1666/-21. Focus: published package correctness, path resolution
in `node_modules`, smoke process cleanup, release workflow security, CI cost, doc honesty.

## What I verified (Windows 11, read-only for the repo)

- Built both packages into a scratch directory with `buildWidgetTooling` (about 5 s). The generated manifests have no
  `workspace:`, `private` or `scripts`. Dependencies are exact: CLI `vite 8.3.0`, `@vitejs/plugin-react 6.1.1`,
  `zod 4.6.5`; SDK `zod 4.6.5`.
- `lib/cli.js` keeps its `#!/usr/bin/env node` line. Its only bare imports are `zod`, `vite`, `@vitejs/plugin-react`
  and `node:*`. React is used only in the `runtime/*.js` bundles, which import nothing.
- Ran `tools/smoke-widget-tooling.mjs --archives` on those archives with Node 24.20.0 and with Node 22.23.2. Both
  passed. No process was still listening afterwards.
- In the installed project, ran `init` + `test` by hand for `media-tool`, `connected-app` and `ai-generator`. The
  smoke does not cover these three. All passed.
- `node tools/check-invariants.mjs`: 12/12 passed. `eslint` on the changed files: clean. `tsc -p tsconfig.json`:
  clean. The 3 focused spec files: 19 tests passed.
- Probed the installed `clark widget dev --builtin` host. Vite's `fs.allow` covers only the installed CLI's package
  directory and Vite's client, so `/@fs/<project>/…` returns 403. Publishing does not make file exposure wider than
  it is in the checkout.
- Not verified: the macOS/Linux SIGTERM path, a run of the release workflow, and an actual npm publish.

## Critical

None found.

## Important

### I1. A release can succeed after publishing nothing, or a stale SDK (`release-widget-tooling.yml:161-169`)

The publish loop treats "version already exists" as success (`echo "... already on npm; skipped"; continue`).
Nothing checks that the published archive matches the one just built.

Failure scenarios:

- **Stale SDK.** A change touches `packages/contracts` or `widget-sdk` but nobody bumps the SDK version (0.2.0). The
  maintainer bumps only the CLI and pushes `widget-tooling-v0.1.1`. The tag check (line 69) only compares the CLI
  version. The run publishes CLI 0.1.1, skips the SDK, and goes green. The CLI now inlines the newer contracts and
  bridge code. Authors who `pnpm add -D @clarkcant/widget-sdk` still get the old 0.2.0 with older types and runtime.
  Nothing reports it.
- **Nothing published.** A tag is re-pushed or moved without any version bump. Both packages are skipped and the run
  is green. Under the "no fake success" invariant, a green tag release that published nothing is misleading.

Fix: when `npm view "$name@$version" dist.integrity` succeeds, compare it with the local archive's
`sha512-<base64>`. If they are equal, skip (reruns stay idempotent). If they differ, fail with "version exists with
different contents; bump it". Also check the SDK version at tag time, or require a bump whenever SDK inputs changed.

### I2. Publishing has no branch, tag or environment gate (`release-widget-tooling.yml:21-26, 69, 151-153`)

`workflow_dispatch` with `publish: true` runs from any ref the dispatcher picks. The tag/version check runs only for
`push` (line 69). There is no `environment:` with required reviewers or deployment-branch rules.

`NPM_TOKEN` is a repository-level secret. Any workflow on any branch, pushed by anyone with write access, can read
it. The "only the publish step sees it" property holds for this file, not for the repository.

Failure scenario: a collaborator dispatches from a feature branch with unreviewed code and ticks `publish`. Both
packages go to npm with a valid provenance attestation that points at that branch. Unpublishing is limited after
72 h.

Fix:

- Put `publish` in an `environment: npm` with required reviewers and a deployment rule limited to
  `refs/tags/widget-tooling-v*` (and `main` if wanted).
- Make the publish step refuse `github.ref` values outside that pattern.
- Run the version check for dispatch as well.
- Better: switch to npm trusted publishing (OIDC, already granted by `id-token: write`) and delete `NPM_TOKEN`.

### I3. CI cost and flakiness added to every push and PR (`ci.yml:326-356`)

The new job runs on 3 OSes with no path gating, unlike `verify`, which classifies changed paths with
`tools/ci-test-scope.mjs`. `push: branches: ["**"]` plus `pull_request` means same-repo PRs run it twice.

Each leg:

- runs a full monorepo `pnpm install --frozen-lockfile`;
- builds;
- runs a fresh `pnpm add` from the public registry with no lockfile;
- starts 3 dev hosts.

A docs-only or `apps/desktop` change now pays a macOS and a Windows leg and depends on registry availability. There
is also no `timeout-minutes`, so a hang (for example a stuck `pnpm add`) burns up to 6 h on macOS.

Fix:

- Gate the job on changes under `packages/widget-cli`, `packages/widget-sdk`, the bundled workspace packages
  (`contracts`, `core`, `storage`, `design-tokens`, `widget-host`, `widget-catalog`, `integration-sdk`,
  `conversation-client`), `examples/reference-apps`, `tools/*widget-tooling*` and `pnpm-lock.yaml`.
- Add `timeout-minutes: 20`.

## Minor

### M1. The installed dev host serves each prebundled runtime with a huge inline source map

Location: `dev-host.ts:1066`, `theme-dev-host.ts:74-76`.

The runtime files are self-contained, but they still go through Vite's transform middleware, which appends an inline
base64 source map. Measured sizes:

| Bundle | On disk | As served |
|---|---|---|
| `dev-frame-runtime.js` | 612 KB | 3.38 MB |
| `catalog-runtime.js` | 2.31 MB | 12.69 MB |
| `theme-dev-runtime.js` | 2.36 MB | 12.96 MB |

Every catalog or theme preview load moves and parses about 13 MB.

Fix: when `browserRuntime(...).prebundled`, serve the file straight from disk with `text/javascript`, outside Vite.
After that, the installed CLI uses Vite only for these three files. Whether the heavy `vite` + `plugin-react`
dependencies are needed in the published package at all is worth deciding.

### M2. Vite loads on every command, not just the dev commands

Location: `dev-module-server.ts:6-7`, which ends up at line 14451 of the bundled `lib/cli.js`.

Vite and plugin-react are static top-level imports, so `clark --help`, `init`, `test` and `pack` all load Vite (about
1.4 s for `--help`). A Vite load failure therefore breaks commands that never use it.

Observed, cause not confirmed: on Windows with Node 22.23.2, in a project under a very long temp path,
`clark widget test` crashed with `ERR_PACKAGE_IMPORT_NOT_DEFINED "#module-sync-enabled"` from
`vite/dist/node/chunks/node.js`. The same archives under a short path passed, so path length is the likely trigger.

Fix: `const { createServer } = await import("vite")` (and the same for the plugin) inside `createDevModuleServer`.

### M3. The asset lists are hard-coded in two places and can drift

- `build-widget-tooling.mjs:41` `REFERENCE_APPS` and `:44` `TEMPLATE_SKIPPED` duplicate the `ReferenceApp` union
  (`package-assets.ts:19`) and `skippedFromReference` (`cli.ts:145`).
- The runtime entry list (`build-widget-tooling.mjs:424-428`) duplicates `RUNTIME_SOURCES`.

Failure scenario: someone adds a reference template that points at a new `examples/reference-apps/<x>`. Repo tests
pass because the checkout fallback works. In the published CLI, `init --template <new>` resolves to
`node_modules/examples/...` and fails with "missing from this checkout". Neither the build spec (hard-coded list,
`build-widget-tooling.spec.ts:145`) nor the smoke (`pure-ui` only) would catch it.

Fix: export the lists from `package-assets.ts` and have the build import them (Node strips types for the repo-side
build). Alternatively, have the smoke run `init` + `test` for every entry of `REFERENCE_TEMPLATES`.

### M4. Smoke cleanup gaps (`smoke-widget-tooling.mjs`)

- There is no SIGINT/SIGTERM handler. If the smoke is killed (for example `timeout`, or a TERM sent to the parent
  only), the `finally` at lines 320-324 never runs. Started `clark … dev` children keep their ports and the scratch
  directory stays. Add handlers that run the same stop loop and then exit.
- `stop()` throws when a process ignores termination (line 98). It is called inside `finally` blocks
  (lines 152, 171, 184), so it replaces the original assertion error. Catch it and log, or use `AggregateError`.
- POSIX signals go to the child pid only (line 91). This is fine today because `clark` spawns no grandchildren. Use
  `detached: true` + `process.kill(-pid)` if that ever changes.
- Pre-existing from the parent commit: `clark widget pack` leaves an empty fixed-name `clark-pack-inspect/` in the OS
  temp directory (`cli.ts:470`), and the smoke does not redirect TMP for `run()`. This is harmless, but a fixed shared
  path is racy across concurrent packs.

### M5. The smoke's install bypasses the repo's supply-chain policy

Location: `smoke-widget-tooling.mjs:294`.

`pnpm add` in the empty project resolves the transitive ranges of vite, plugin-react and zod fresh on every CI push,
without the workspace's `minimumReleaseAge: 1440`. No secrets are present in either smoke job, so the blast radius
is the runner only.

Fix: pass `--config.minimum-release-age=1440` (or write an `.npmrc` with it) so the smoke matches policy.

### M6. Release smoke legs install more than they need (`release-widget-tooling.yml:110-111`)

With `--archives`, the smoke needs no workspace dependencies. It imports `build-widget-tooling.mjs` only for
`repoRoot`, and esbuild is loaded lazily. Yet 6 legs run a full monorepo install.

Fix: drop the install step there, keeping `corepack enable` for `pnpm`. Consider `cache: ''` in the `pack` job of a
release. pnpm's integrity check against the lockfile already limits cache-poisoning risk.

### M7. SDK and CLI package nits (`build-widget-tooling.mjs:327, 383-391, 422-438`)

- `engines.node >=22.19.0` on the browser-only SDK. Users with `engine-strict` on older Node cannot install a
  library that never runs in Node. Scope `engines` to the CLI.
- No `typesVersions`, so `@clarkcant/widget-sdk/dom` has no types under `moduleResolution: node10`.
- The runtime bundles inline third-party code, but only React's and two MIT `@license` comments survive. Other
  libraries, for example highlight.js (BSD-3), ship without notices. Add a third-party notices file, or set esbuild
  `legalComments: "linked"`.
- `clark --version` prints usage. This is pre-existing, but it is now a published CLI.

## Verified non-issues

- **Workflow script injection.** `github.ref_name` and step outputs reach `run:` through `env:`. The only inline
  expression is `${{ runner.temp }}`, which the runner controls.
- **Credentials.** `persist-credentials: false` everywhere. The publish job does no checkout and runs no repo code.
  `id-token: write` is set on the publish job only.
- **Provenance.** `repository.url` matches `digitopvn/clarkcant`.
- **Bin shim resolution.** `isMainModule` uses realpath and compares case-insensitively on Windows. It works through
  pnpm's `.cmd` and shell shims (smoke-verified on Windows).
- **Vite root inside `node_modules`.** `/runtime/*.js` is served, and the allow-list stays confined to the package
  (probed).
- **Doc honesty.** EN and VI both say no version is on npm yet and give the local-archive path.

## Plan status

The checked acceptance items match the code. Publishing and the official docs update remain open, as the plan says.
The branch depends on unmerged #449 (PR #465), so merge order matters.

## Unresolved questions

- Should the published CLI keep Vite at all (see M1), or serve prebundled runtimes statically and drop `vite` and
  `plugin-react`?
- Is the SDK meant to be versioned in lockstep with the CLI? If so, the tag check should enforce it (see I1).
