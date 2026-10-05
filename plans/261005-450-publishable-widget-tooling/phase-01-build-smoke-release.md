---
phase: 1
title: Build, smoke and release
status: in-progress
---

# Phase 01 — build, smoke and release

## Files

- `tools/build-widget-tooling.mjs` (new): stage and `pnpm pack` both packages.
- `tools/smoke-widget-tooling.mjs` (new): install the archives outside the repository and use them.
- `tools/test/build-widget-tooling.spec.ts`, `packages/widget-cli/test/package-assets.spec.ts` (new).
- `packages/widget-cli/src/package-assets.ts` (new); `reference-templates.ts`, `dev-host.ts`, `theme-dev-host.ts`,
  `catalog-target.ts`, `cli.ts` (asset lookup; `clark widget dev` closes its host on SIGINT/SIGTERM).
- `.github/workflows/release-widget-tooling.yml` (new), `.github/workflows/ci.yml` (smoke job).
- `package.json` (`esbuild` devDependency, `build:widget-tooling`, `smoke:widget-tooling`), `pnpm-lock.yaml`.
- `docs/widget-development.md`, `docs/widget-development.vi.md`, `docs/manifest.json`.

## Steps

- [x] Asset lookup that prefers the published layout and falls back to the checkout.
- [x] Build script: esbuild bundles, dependency resolution, declarations, templates, runtime bundles, pack.
- [x] Smoke script with tracked processes and cleanup; `--archives` for the release.
- [x] Unit tests for the build helpers and asset lookup; build integration test.
- [x] Release workflow and CI job.
- [x] EN/VI docs; `node tools/check-invariants.mjs --fix-manifest`.
- [x] Review follow-up ([code-review-450.md](reports/code-review-450.md)):
  - the release compares each version's archive integrity with npm before publishing anything, so it fails on a changed
    package that kept its version and skips only identical bytes;
  - publishing is limited to `widget-tooling-v*` tags in the `npm-release` environment, with trusted publishing
    (OIDC) first and `NPM_TOKEN` as the fallback;
  - the CI smoke runs only when its inputs change (`tools/ci-test-scope.mjs`) and has a timeout;
  - installed dev hosts serve the runtime bundles from disk, and Vite is imported only by the dev hosts;
  - the asset lists are shared by the CLI and the build, and the smoke runs every template;
  - the smoke stops its processes on SIGINT/SIGTERM, and `clark widget pack` uses a private temporary directory;
  - the SDK drops `engines` and gains `typesVersions`, the CLI ships `THIRD_PARTY_NOTICES.md`, and `clark --version`
    prints the version.
- [ ] Publish once npm credentials exist.

## Validation

`pnpm invariants`, `pnpm verify`, `pnpm smoke:widget-tooling` on Windows (local), macOS and Linux (CI).

## Risk and rollback

The source packages and workspace resolution are unchanged; reverting the commit removes the build, smoke and
workflows. A published version cannot be withdrawn after 72 hours, so the release smoke-tests the exact archives it
publishes and skips a version already on npm.
