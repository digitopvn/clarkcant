# Fix report: snapshot a local package at install (#415)

Date: 2026-10-03. Branch: `codex/415-snapshot-local-package`.

## User decision

Snapshot by default. Every install of a package listed by a path on this machine copies it into the content-addressed
package cache, and the installed package runs from that copy. There is no "linked" install mode; the live editing loop
stays in `clark widget dev`. Editing the files and installing again makes a new snapshot, checked and recorded like any
other install.

## Design

- `snapshotLocalPackage` (`packages/core/src/package-fetch.ts`) copies the path into
  `<dataDir>/package-cache/local/.tmp-*`, walking it with the `localContentDigest` bounds (5,000 files, 64 MiB) and the
  `digestOfDirectory` refusals (symlink, junction, hard link; root `.git` skipped; realpath containment per directory;
  `O_NOFOLLOW` + fstat re-check per file; bytes counted after reading). It digests the staged copy, compares it with the
  expected digest, and renames it to `local/<sha256>` (`cachedLocalSnapshotPath`). An existing folder with the same
  digest is reused; a tampered one is replaced. Windows: rename retried on EPERM/EACCES/EBUSY, copies written
  owner-writable (`mode | 0o600`) so read-only sources do not leave unremovable copies, `wx` writes refuse names a
  case-insensitive filesystem merges.
- One digest: the install compares the snapshot's digest with the approval-pinned `localDigest`, or the client's
  `contentDigest`. `409 DIGEST_MISMATCH` and `400 LOCAL_SOURCE_UNREADABLE` keep their meaning. The check runs before the
  policy decides, as before. The `effect.executed` record names the snapshot digest.
- The generation records `snapshotDigest` (optional field on `packageGenerationSchema`, surfaced in `GET /packages`).
  Every reader resolves the snapshot from it: files route, frame route (`widget-serving.ts`), isolated frame lookup
  (`conversations.ts`), widget list, theme registry, service host, capability grants. `resolveLocalSource` never falls
  back to the live path when a generation has a snapshot.
- Reinstall after an edit: the plan's `artifactUrl` is `file:<snapshot path>`, and `joinOrCreatePlan` now retires a
  finished plan whose candidate `artifactUrl` differs, so new bytes get a new plan and generation. Same bytes join the
  existing plan.

## Existing installs

Generations without `snapshotDigest` (installed before this change) keep reading their path until installed again; the
reinstall creates a snapshot-backed generation. No migration, nothing deleted.

## Cache cleanup

No garbage collection exists for git/npm cache entries, so none was added for snapshots. Unused snapshots stay until the
cache is cleared by hand. Documented.

## Tests

- `packages/core/test/local-snapshot.spec.ts` (new, 20 tests): copy/digest equality, edits after snapshot, reuse, new
  path after edit, tampered snapshot replaced, expected-digest mismatch caches nothing, file/byte bounds, symlink,
  junction, root junction, hard link, missing path, `.git` handling, read-only source, path spellings (relative,
  trailing separator, forward slashes on Windows), `cachedLocalSnapshotPath` rejecting non-sha256 values,
  `resolveLocalSource`, `installedDirectoryEntries`.
- `apps/runtime/test/install-approval.spec.ts`: served bytes unchanged after edits and after deleting the path; generation
  `snapshotDigest` equals the recorded files digest; reinstall after edit creates a second generation and serves new
  bytes; repeated install of the same bytes is idempotent.
- `apps/web/e2e/marketplace-local-install.spec.ts`: after installing from the card, editing `themes/harbor.json` and
  adding a file changes neither the served file nor the theme name in `GET /themes`; installing again serves the edit.

## Verification

- Focused vitest: install-approval (37) and local-snapshot (20) pass.
- E2E: marketplace-local-install, widget-frame-grant, widget-library, themes, package-lifecycle, service-facet, inbox:
  42 passed, run twice.
- `pnpm verify`, `pnpm verify:full`: see PR.

## Docs

`docs/open-interfaces(.vi).md`, `docs/widget-development(.vi).md`, `docs/manifest.json` refreshed. The official site
(`clarkcant-web` `docs/api.html`, `vi/docs/api.html`) still says a local package stays linked to its path; replacement
wording is in the PR and the issue comment.
