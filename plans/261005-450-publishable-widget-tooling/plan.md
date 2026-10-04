---
title: "#450 publishable widget author CLI and SDK for projects outside the monorepo"
status: in-progress
created: 2026-10-05
issues: [450]
related: [449, 451, 194]
---

# Publishable widget author tooling (#450)

Source: issue [#450](https://github.com/digitopvn/clarkcant/issues/450). Builds on the npm packaging contract of
[#449](https://github.com/digitopvn/clarkcant/issues/449) (PR #465, not yet merged; this branch is based on it). The
checkout-based pilot in #451 may proceed independently.

## Outcome

`@clarkcant/widget-cli` (bin `clark`) and `@clarkcant/widget-sdk` can be packed as npm archives that install and work
in an empty project outside the repository on macOS, Windows and Linux with Node 22.19 and 24, and a release workflow
can publish them with provenance once npm credentials exist.

## Decisions

- Source `package.json` files stay `private: true` and keep resolving to TypeScript source; a build script
  (`tools/build-widget-tooling.mjs`) generates separate publishable package directories under `dist/widget-tooling/`.
  No `publishConfig` override in source, so workspace consumers and the invariant checks are unchanged.
- esbuild (exact-pinned root devDependency, already allowed to build) bundles the workspace packages in; every
  third-party import stays external and is declared at the exact version its importing workspace package pins. The build
  fails on an undeclared, ranged or conflicting dependency.
- SDK entry points `.` and `./dom` are bundled for the browser (a Node builtin fails the build); declarations come from
  the TypeScript compiler, with workspace imports rewritten to the copies shipped beside them.
- The CLI ships its reference templates under `templates/` and the dev hosts' browser modules as self-contained bundles
  under `runtime/`; `packages/widget-cli/src/package-assets.ts` prefers those and falls back to the checkout.
- The release packs once, smoke-tests those exact archives on 3 OS x 2 Node versions, then publishes the same archives.

## Phases

1. [phase-01-build-smoke-release.md](phase-01-build-smoke-release.md) — build, smoke, release workflow, CI job, docs.

## Acceptance criteria

- [x] Both packages pack into archives with complete runtime dependencies, no `workspace:` specifier, no unresolved
      workspace import, browser-safe SDK entry points with declarations, and the CLI's template assets.
- [x] `tools/smoke-widget-tooling.mjs` installs the packed archives into an empty project outside the repository and
      runs `init` (blank and `pure-ui`), `test`, `pack`, the widget/catalog/theme dev hosts over HTTP (stopping each
      process), and imports and type-checks the SDK. Passed locally on Windows.
- [x] `.github/workflows/release-widget-tooling.yml`: tag `widget-tooling-v*` or manual run; smoke on
      ubuntu/windows/macos x Node 22.19/24; `npm publish --provenance --access public` with `NPM_TOKEN` only in the
      publish step; `permissions: contents: read` plus `id-token: write` on the publish job.
- [x] CI runs the smoke once per OS.
- [x] EN/VI quickstart in `docs/widget-development{,.vi}.md` §16, stating the packages are not on npm yet.
- [ ] Publish to npm and record installed-version smoke evidence: blocked on npm scope ownership and the `NPM_TOKEN`
      secret (issue #450's open release prerequisite).
- [ ] Official docs (`digitopvn/clarkcant-web`, CLI page) updated once a version is published.
