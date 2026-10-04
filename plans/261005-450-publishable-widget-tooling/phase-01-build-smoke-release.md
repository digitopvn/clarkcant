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
- [ ] Publish once npm credentials exist.

## Validation

`pnpm invariants`, `pnpm verify`, `pnpm smoke:widget-tooling` on Windows (local), macOS and Linux (CI).

## Risk and rollback

The source packages and workspace resolution are unchanged; reverting the commit removes the build, smoke and
workflows. A published version cannot be withdrawn after 72 hours, so the release smoke-tests the exact archives it
publishes and skips a version already on npm.
