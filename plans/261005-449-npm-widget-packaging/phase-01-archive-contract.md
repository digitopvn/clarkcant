---
phase: 1
title: Archive contract
status: in-progress
---

# Phase 01 — archive contract

## Files

- `packages/core/src/package-fetch.ts`: extract the tarball-to-directory step into a shared helper; add
  `inspectNpmTarball(bytes, scratchRoot)` returning integrity, content digest and file list (same limits and
  refusals as `fetchNpmArtifact`). Export from `packages/core/src/index.ts`.
- `packages/widget-cli/src/npm-package.ts` (new): package.json rules, keyword mapping, credential-file patterns,
  `pnpm pack` invocation.
- `packages/widget-cli/src/cli.ts`: init writes package.json; pack writes artifact schemaVersion 2 with
  `authorDigest` and the `npm` block; publish emits an npm-source entry (`--source local` keeps the local one).
- `packages/widget-cli/src/reference-templates.ts`: reference copies get a package.json too.
- Tests: `packages/core/test/package-fetch.spec.ts` (inspect parity), `packages/widget-cli/test/npm-archive.spec.ts`
  (new), existing `conformance.spec.ts` / `theme-cli.spec.ts` updated for `authorDigest`,
  `apps/runtime/test/package-install-npm-archive.spec.ts` (new) for the install route.

## Steps (TDD)

1. Test: `inspectNpmTarball` digest equals `fetchNpmArtifact` digest for the same tarball; unsafe entries refused.
2. Implement the helper by moving the existing extraction loop (no behavior change for the fetch).
3. Test the CLI: blank init → pack produces tgz, artifact v2 with three distinct digests; rule violations refused
   with actionable text; repack with changed content refused; no package.json keeps the local workflow.
4. Implement `npm-package.ts` and the CLI changes.
5. Test the runtime: entry from `publish` + local registry serving the tgz installs through `/packages/install`;
   a tampered tarball and a wrong digest are refused.
6. Docs EN/VI.

## Validation

`pnpm exec vitest run packages/core/test/package-fetch.spec.ts packages/widget-cli apps/runtime/test/package-install-npm-archive.spec.ts`,
then `pnpm verify`.

## Risk / rollback

`artifact.json` field rename is an author-file format change; it is versioned (`schemaVersion: 2`) and nothing in the
runtime reads it. Revert is a plain revert of the PR.
