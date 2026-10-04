---
title: "#449 npm-ready widget packages with a verified archive digest contract"
status: in-progress
created: 2026-10-05
issues: [449]
related: [194, 450, 451]
---

# npm-ready widget packages (#449)

Source: issue [#449](https://github.com/digitopvn/clarkcant/issues/449), a scoped deliverable under epic
[#194](https://github.com/digitopvn/clarkcant/issues/194). Coordinates with
[digitopvn/clarkcant-marketplace#5](https://github.com/digitopvn/clarkcant-marketplace/issues/5) (the Marketplace
must accept the manifest this flow ships). #450 (standalone CLI/SDK release) and #451 (public pilot) follow it.

## Outcome

An author runs `clark widget init`, `test`, `pack`, `publish` and gets an npm tarball whose runtime content digest is
the exact digest ClarkCant's npm fetch computes, so the prepared directory entry installs through the real
`fetchNpmArtifact` → install path with no hand-edited coordinates and no weakened verification.

## Digest semantics (the contract)

| Name | Over what | Who checks it |
| --- | --- | --- |
| `npm.integrity` | SRI `sha512-…` of the `.tgz` bytes | npm registry `dist.integrity`; runtime `verifyNpmIntegrity` |
| `npm.contentDigest` | `digestOfDirectory` of the archive extracted with the runtime's own extractor (`package/` stripped) | runtime `fetchNpmArtifact` `expectedDigest`; the npm directory entry's `digest` |
| `authorDigest` | canonical JSON of id, version, definition digest, theme digests and author file hashes | the CLI's same-version immutability check |

`dist/artifact.json` moves to `schemaVersion: 2`, renaming the ambiguous `digest` to `authorDigest`. A local-source
entry keeps its existing behavior (the runtime snapshots local bytes itself).

## Constraints

- Archive workflow is `pnpm pack` (deterministic: pnpm normalizes mtimes; verified byte-identical across repacks).
- Archive verification reuses the runtime extractor (one implementation, shared with `fetchNpmArtifact`).
- `package.json` is optional: without it `pack`/`publish` keep the local workflow. With it, npm rules are enforced.
- Never publishes to npm or submits to the Marketplace; `publish` prints those two outcomes as not done and the
  exact manual commands. No ClarkCant artifact registry.

## npm package rules (enforced by `pack`)

- `name` is a valid npm name; `version` equals `clarkcant.json` version; `license` present.
- `keywords` include `clarkcant` and a facet keyword per facet kind (`clarkcant-widget` for `ui`,
  `clarkcant-service` for `tools`, `clarkcant-skill`, `clarkcant-prompt`, `clarkcant-theme`, `clarkcant-setup`,
  `clarkcant-driver`, `clarkcant-voice`).
- `files` is an explicit allowlist; no `dependencies`/`optionalDependencies`/`bundleDependencies` (the runtime
  installs only the archive); no `preinstall`/`install`/`postinstall` scripts.
- The archive must not hold credential-shaped files (`.npmrc`, `.env*`, `*.pem`, `*.key`, `id_rsa*`, …),
  `node_modules/` or `.git/`, and must pass the conformance suite on its own extracted contents.
- Repacking a version whose content digest changed is refused, like the author digest rule.

## Phases

1. [phase-01-archive-contract.md](phase-01-archive-contract.md) — core tarball inspection, CLI pack/publish/init,
   tests including the runtime install path against an npm-compatible test registry.
2. Docs: `docs/widget-development.md` + `.vi.md` (§16, §19, §20), official `clarkcant-web` CLI/author docs EN/VI.

## Acceptance criteria

- [x] init scaffolds `package.json`; pack validates identity, version alignment, keywords and the `files` allowlist.
- [x] pack produces `dist/<name>-<version>.tgz` via `pnpm pack`, verified for unintended/credential files and conformance.
- [x] Three digests are distinct and documented; installation metadata comes from the final archive contents.
- [x] The packed archive passes `fetchNpmArtifact` and the runtime install route against a local npm-compatible
      registry with integrity and digest checks on.
- [x] Local/git workflows preserved; tampering, version-content repack and archive/listing mismatch are refused.
- [x] publish states prepared / npm-published / marketplace-submitted outcomes separately with manual commands.
- [ ] Internal and official EN/VI author docs updated.
