---
phase: 1
title: npm-ready reference packages
status: completed
---

# Phase 01 — npm-ready reference packages

## Files

- `examples/reference-apps/{text-editor,spreadsheet,media-render}/package.json` (new), `LICENSE` (new for
  text-editor and media-render; the spreadsheet's MIT file replaced by the repository's Apache-2.0 text),
  `clarkcant.json` (`publisher.sourceUrl` only), `README.md` / `README.vi.md` (npm package section, absolute doc links).
- `packages/widget-cli/src/cli.ts`: `skippedFromReference` skips `package.json`.
- `packages/widget-cli/test/reference-templates.spec.ts`: the copy's own npm identity; the reference's
  `package.json` and `LICENSE` left behind.
- `packages/core/src/test-support/fake-npm-registry.ts`: answers escaped scoped package names.
- `apps/runtime/test/reference-packages-npm-install.spec.ts` (new).
- `docs/widget-development.md`, `docs/widget-development.vi.md` (§16 init, §24.1, §24.2, §24.4), `docs/manifest.json`.

## Steps

- [x] Add `package.json`, `LICENSE`, README sections; keep `clarkcant.json` changes to `sourceUrl`.
- [x] Prove `widget test`, `widget pack`, `widget publish` on each app (archive plus npm directory entry; `dist/`
      ignored and removed afterwards).
- [x] Keep `init --template pure-ui|media-tool` from inheriting the reference's npm identity; test it.
- [x] Install test for all three apps through `/packages/install`, plus tampered and wrong-integrity refusals.
- [x] Docs EN/VI and `node tools/check-invariants.mjs --fix-manifest`.

## Validation

`pnpm exec vitest run apps/runtime/test/reference-packages-npm-install.spec.ts packages/widget-cli/test/reference-templates.spec.ts packages/widget-cli/test/npm-archive.spec.ts apps/runtime/test/package-install-npm-archive.spec.ts`,
then `pnpm invariants` and `pnpm verify`; `pnpm install --frozen-lockfile` unchanged.

## Risk / rollback

The changes are additive except the spreadsheet licence file and the three `sourceUrl` values; reverting the commit
restores the previous local-only packages. No published artifact exists to roll back.
