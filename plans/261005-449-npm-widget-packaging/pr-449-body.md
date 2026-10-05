## Summary

Widget packages now ship as npm archives whose digest a node can verify end to end. Part of #449, under epic #194.

- `clark widget pack` builds `dist/<name>-<version>.tgz` with `pnpm pack` when the package has a `package.json`.
  It extracts the archive with the runtime's own reader (`inspectNpmTarball`, sharing `unpackNpmTarball` with
  `fetchNpmArtifact`). It then refuses the archive unless it passes the conformance suite on its own, holds the same
  `clarkcant.json` and contains nothing credential-shaped.
- `dist/artifact.json` moves to `schemaVersion: 2` with three distinct digests:
  - `npm.integrity` is the registry's sha512 SRI.
  - `npm.contentDigest` is the runtime digest of the extracted archive, and is the npm entry's `digest`.
  - `authorDigest` is the former `digest`. It feeds the same-version immutability check.
- `package.json` rules are checked before packing:
  - npm name, and a version equal to the one in the manifest;
  - a license that matches the publisher's;
  - the `clarkcant` keyword plus one keyword per facet kind;
  - an explicit `files` list;
  - no dependencies and no install scripts.
- `clark widget init` scaffolds a compliant `package.json` for every template.
- `clark widget publish` writes an npm-source entry naming the exact version and content digest; `--source local`
  keeps the local entry. It uploads nothing, and states three outcomes separately: prepared, published to npm (no)
  and Marketplace submission (no). It also prints the `npm publish dist/<archive>.tgz` command.
- A package without `package.json` keeps the local/git workflow unchanged.
- Docs: `docs/widget-development.md` and `.vi.md` §16 and §19, plus the implementation status.

## Evidence

- `packages/widget-cli/test/npm-archive.spec.ts`: a real `pnpm pack` produces three distinct digests, and repacking
  is byte-identical. The rules are refused with actionable text, and so are credential files, an archive missing a
  runtime asset, and a repack of changed content. The local workflow is unchanged. The prepared entry's digest equals
  what `fetchNpmArtifact` computes from a local npm-compatible registry, and a tampered archive is refused with
  `ARTIFACT_DIGEST_MISMATCH`.
- `apps/runtime/test/package-install-npm-archive.spec.ts` runs the canonical `/packages/install` route against a
  registry serving the CLI-packed archive:
  - it installs;
  - a wrong entry digest gives 409 `DIGEST_MISMATCH`;
  - a wrong registry integrity gives `NPM_INTEGRITY_MISMATCH`.
- `pnpm invariants` and `pnpm verify` pass.

## Not in this PR

- Publishing the CLI/SDK themselves is #450.
- Publishing the pilot packages to npm and the Marketplace is #451.
- Live npm publication needs the author's credentials and is never done by the CLI.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
