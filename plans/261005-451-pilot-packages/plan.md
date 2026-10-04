---
title: "#451 pilot reference widget packages on npm (credential-free part)"
status: in-progress
created: 2026-10-05
issues: [451]
related: [194, 445, 449, 450]
---

# Pilot reference packages (#451)

Source: issue [#451](https://github.com/digitopvn/clarkcant/issues/451). Builds on #449 (npm archive and digest
contract, PR [#465](https://github.com/digitopvn/clarkcant/pull/465), not merged yet; this branch starts from its head
`6b643f61`). #445 (Clark-placed service-capability buttons) is closed, so Media Converter is not blocked on it.

## Outcome

Three existing reference apps become npm-ready packages that an author packs and prepares with the shipped CLI, and
that a node installs through the canonical `/packages/install` path from an npm-shaped registry. Everything that needs
npm credentials, a deployed Marketplace or a released remote provider stays open and is named below.

| App | Directory | npm name | Package id |
| --- | --- | --- | --- |
| Quick Notes | `examples/reference-apps/text-editor` | `@clarkcant/quick-notes` | `com.clarkcant.reference.text-editor` |
| CSV Explorer | `examples/reference-apps/spreadsheet` | `@clarkcant/csv-explorer` | `com.example.spreadsheet` |
| Media Converter | `examples/reference-apps/media-render` | `@clarkcant/media-converter` | `com.clarkcant.reference.media-render` |

## Constraints

- No npm publication, Marketplace submission, push or PR from this work, and no credentials touched.
- The `@clarkcant` npm scope must be owned by the publishing account before any `npm publish`.
- Each `package.json` passes `clark widget pack` rules: version equals `clarkcant.json`, license equals
  `publisher.license` (Apache-2.0), keywords `clarkcant` plus facet keywords, an explicit runtime-only `files` list, no
  dependencies or scripts. `type: module` keeps the widget JS resolved as ESM now that the app has its own
  `package.json`.
- The reference app directories are not pnpm workspace members (`pnpm-workspace.yaml` matches `examples/*` only), so
  `pnpm install --frozen-lockfile` is unchanged.
- `clark widget init --template pure-ui|media-tool` never copies the reference app's `package.json`, `LICENSE` or
  READMEs; the copy gets its own.
- Packing happens in a temporary copy in tests, never in the repository tree; `dist/` is gitignored.

## Phases

1. [phase-01-npm-ready-reference-packages.md](phase-01-npm-ready-reference-packages.md) — completed.
2. Publication, Marketplace indexing, clean-node journey and official docs — blocked on the items below.

## Delivered here

- `package.json`, Apache-2.0 `LICENSE` (the repository's own text; the spreadsheet's MIT file contradicted its
  manifest's Apache-2.0 and is replaced) and an "npm package" README section (EN, plus VI where a README.vi.md exists)
  for each app. `publisher.sourceUrl` now points at each app's directory.
- `skippedFromReference` also skips `package.json`; `reference-templates.spec.ts` asserts the copy's npm identity and
  that the reference's `package.json` and `LICENSE` are left behind.
- `apps/runtime/test/reference-packages-npm-install.spec.ts`: for all three apps, `clark widget publish` on a temp copy,
  then install of the CLI-produced archive through `/packages/install` with `CC_NPM_REGISTRY_URL` and
  `CC_DIRECTORY_INDEX`; a tampered archive (fresh registry integrity) is refused with `DIGEST_MISMATCH`, a registry
  integrity mismatch with `NPM_INTEGRITY_MISMATCH`. Media Converter installs without a container engine.
- The fake npm registry answers escaped scoped names (`%40scope%2Fname`), as the real registry does.
- `docs/widget-development.md` / `.vi.md` §16 (init) and §24.1, §24.2, §24.4.

## Acceptance criteria (from #451)

- [ ] Each package has its own npm identity/version, license, source link, screenshots, truthful README and
      supported-platform/permission declarations. **Done except screenshots:** no package has `previews/`, and the
      repository has no deterministic preview generator (the e2e journeys write gitignored evidence, not package
      previews).
- [ ] Publish real immutable npm versions under an authorized publisher; record exact versions, tarball integrity and
      source revisions. **Blocked:** needs `@clarkcant` scope ownership and npm publisher credentials.
- [ ] The production indexer accepts them and public API/search/detail pages show accurate metadata. **Blocked:**
      needs digitopvn/clarkcant-marketplace#5 deployed and the packages published.
- [ ] A clean ClarkCant node, without local source paths or hand-authored directory entries, discovers and installs
      the exact version through the canonical path. **Partially proven:** the canonical install route installs the
      CLI-produced archive from an npm-shaped registry with integrity and digest checks on. Clean-node discovery
      needs #194's remote DirectoryProvider.
- [ ] Open and use the app, persist/reopen, update, removal/restore or rollback; tampered/incompatible packages fail
      with a stated reason. **Tampering proven here** (`DIGEST_MISMATCH`, `NPM_INTEGRITY_MISMATCH`); the
      open/use/update journey from a published version follows publication.
- [ ] Record browser/desktop evidence and supported-platform checks. **Remaining:** follows publication.
- [ ] Publish a reproducible EN/VI author-and-user guide on the official docs site using the released packages.
      **Remaining:** official docs (`digitopvn/clarkcant-web`) follow the release; internal docs are updated here.

## Risks

- `@clarkcant` may not be claimable on npm; renaming changes only `package.json` `name` and the docs.
- `pnpm pack` integrity differs between a pack inside the workspace and one in a temp copy (the content digest is
  identical); publish exactly the archive `pack` wrote, as §16 says.
- CSV Explorer keeps package id `com.example.spreadsheet` and publisher id `example`; renaming is a separate,
  install-identity-breaking decision.
