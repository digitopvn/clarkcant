# Code review: #449 npm packaging and digests for widget packages

Scope: uncommitted worktree changes on `claude/marketplace-manifest-npm-367597`.

- Modified: `packages/core/src/package-fetch.ts`, `packages/widget-cli/src/cli.ts`, `packages/widget-cli/src/theme-cli.ts`, `vitest.config.ts`, the tests, `docs/widget-development{,.vi}.md`
- New: `packages/widget-cli/src/npm-package.ts`, `packages/widget-cli/test/npm-archive.spec.ts`, `apps/runtime/test/package-install-npm-archive.spec.ts`

## How I verified it

- Ran these suites on Windows 11 with Node 24.20.0 and pnpm 12.4.2: `npm-archive`, `package-install-npm-archive`, `package-fetch`, `conformance`, `theme-cli`, `version-rules`, `connected-app-template` and `reference-themes`. All 8 files passed (147 tests).
- Ran `pnpm pack --json` against a scratch package whose path contains spaces and that has a `prepack` script. pnpm reports `filename` as an absolute path. The script's output goes to stdout, before the JSON.
- Ran a throwaway probe test, deleted afterwards. With `.npmrc` listed in `files`, source conformance passes and the refusal comes from `credentialShaped`. So the credential test checks real behaviour and is not a false pass.
- Ran `spawnSync(..., { shell: true })` with arguments on Node 24 on Windows. It prints `DEP0190 DeprecationWarning`.

## Critical

None found.

- **Extraction:** `unpackNpmTarball` moves the old `fetchNpmArtifact` logic as-is: same traversal checks, same refusal of symlinks and non-file entries, same ENOTDIR handling. The inspector uses the same reader as the runtime, so the two digests match by construction. The runtime end-to-end test also shows this independently.
- **Backward compatibility:** A schemaVersion 1 artifact is read through `previous.authorDigest ?? previous.digest` (cli.ts:396). I found no consumers of `artifact.json`'s `digest` field outside widget-cli, either in this repo or in clarkcant-marketplace.

## Important

### I1. `pnpm pack` runs the package's `prepack`, `prepare` and `postpack` scripts, and their output breaks the JSON parse

`npm-package.ts:162-178`

`clark widget pack` and `clark widget publish` used to only read files. Now they run the scripts in `package.json`. `readNpmPackageJson` refuses only `preinstall`, `install` and `postinstall` (`npm-package.ts:40`).

Failure scenarios:

1. **Script output breaks pack.** I reproduced this. Lifecycle output goes to stdout before pnpm's JSON. The parser uses `stdout.slice(stdout.indexOf("{"))`, so any `{` in that output (`echo {..}`, bundler stats, a `tsc` diagnostic) makes `JSON.parse` fail. Pack then refuses with "pnpm pack did not report the archive it wrote", even though pnpm wrote it.
2. **Running pack runs someone else's code.** A Marketplace reviewer or CI job that runs `clark widget pack` on a submitted source tree to check its digest now runs that author's code.
3. **The reproducibility claim no longer holds.** A `prepack` that generates files makes the archive depend on the build environment. The claim in `npm-package.ts:152-153` that "anyone holding the source" can recompute the integrity then fails.

Fix: pass `--ignore-scripts` to `pnpm pack`, or refuse `prepack`, `prepare` and `postpack` in `readNpmPackageJson` alongside the install scripts. Also parse the JSON from the last line that starts with `{` (for example `stdout.lastIndexOf("\n{") + 1`), not from the first `{`. Add a test with a `prepack` script that echoes `{`.

### I2. On Windows with Node 24 (a CI target), every pack and publish prints a DEP0190 deprecation warning, and a missing pnpm gives the wrong hint

`npm-package.ts:161-169`

`shell: true` with an argument array prints `[DEP0190] DeprecationWarning ... arguments are not escaped, only concatenated` to stderr every time. I confirmed this in the test output. The command still succeeds, but a deprecation that names "security vulnerabilities" appears in a security-sensitive publishing flow.

When pnpm is not installed, `result.error` is undefined under `cmd.exe`. The user then gets `pnpm pack failed: 'pnpm' is not recognized…` instead of the `corepack enable pnpm` hint at line 169.

The manual quoting also handles spaces only. `cmd` still expands `%VAR%` inside double quotes, so a temp path with `%…%` (an unusual but legal user profile name) gets rewritten.

Fix:
- Pass one command string, so the concatenation is explicit and DEP0190 does not fire: `spawnSync(\`pnpm pack --pack-destination "${scratch}" --json\`, { shell: true, ... })`. Or resolve `pnpm.cmd` and run it through `cmd.exe /d /s /c` with explicit escaping.
- Map exit status 9009 or "is not recognized" to the corepack hint.

### I3. The docs say `.env*` is refused, but the code does not match every `.env*` name

Code: `npm-package.ts:131-147`. Docs: `docs/widget-development.md` §16 pack, and `.vi.md`.

`credentialShaped` matches `.env` and `.env.<x>` only. These go into the archive and are not refused:
- `.envrc` (direnv, which commonly holds exported secrets)
- `.env-local` and `.env_prod`
- `.git-credentials`, `.pypirc`, `id_ecdsa` / `id_dsa`, and `credentials.json`

The doc tells authors this class of file is blocked. A published npm version cannot be taken back, so an author who relies on the doc leaks the file.

Fix: match `base === ".env" || base.startsWith(".env")`, and add `.git-credentials`, `.pypirc` and `id_ecdsa` / `id_dsa`. Or narrow the doc wording to the exact list.

## Minor

- **M1. Pack crashes instead of refusing if pnpm reports a relative filename.** `npm-package.ts:182` calls `readFileSync(filename)` outside a try block, and the path resolves against `process.cwd()`, not `root` or `scratch`. pnpm 12 reports an absolute path, which I checked. A pnpm version that reports a relative path would crash `clark widget pack` with an uncaught ENOENT. Fix: `readFileSync(resolve(scratch, basename(filename)))` inside the try block, returning `{ ok: false }` on failure.
- **M2. No test covers schemaVersion 1 compatibility.** The `previous.digest` fallback in `cli.ts:396` is untested. A test should write a v1 `{schemaVersion:1, version, digest:<other>}` artifact and check that repacking is refused, then write one with the matching digest and check that it is accepted.
- **M3. Two tests prove less than they claim.**
  - `npm-archive.spec.ts:84-98` checks `artifact.npm.*` against `inspectNpmTarball` on the same bytes. That is the same function pack used, so this part is circular. The fetch test at line 181 is what proves the contract.
  - In `npm-archive.spec.ts:214-232`, the "tampered" archive also leaves out `fixtures/` and `previews/`. The mismatch therefore does not depend on the "one changed byte" described in the comment. Building it from the real archive's full file set, with one byte changed, would test what the comment says.
- **M4. `publish --source local` still needs pnpm.** It always calls `pack(root)`, which runs `pnpm pack` whenever `package.json` exists, so pnpm must be installed even though the local entry never uses the archive (cli.ts:543). This is acceptable as long as it is intended; the docs do not mention it.
- **M5. Adding `package.json` forces a version bump.** Existing packages that were packed under v1 have their author digest change once a `package.json` is added. This is because `packageFiles` includes `package.json`. The author then has to bump the version without changing any runtime asset. This is consistent with the immutability rule, but the docs should mention it.
- **M6. The unscoped default name will often be taken on npm.** `npmNameFor` (cli.ts:207) produces names like `quick-notes`, which are likely to collide on the public registry. The comment explains this, but the author docs say only that `init` writes a valid `package.json`. Say there that the author should rename or scope the package before publishing.
- **M7. Official docs are still open.** The plan's acceptance item "Internal and official EN/VI author docs updated" is unchecked. Per AGENTS.md, the `digitopvn/clarkcant-web` change, or an `ai-handle` fallback issue, is still needed before #449 can close.

## Checklist

| Area | Finding |
| --- | --- |
| Concurrency | Scratch directories use random names (`mkdtemp` and `.inspect-<fingerprint>`) and are removed in `finally`. No shared mutable state. |
| Error boundaries | The I1 parse issue and the M1 uncaught `readFileSync`. If the `conform` callback throws, the error propagates, but the scratch directory is still cleaned up. |
| API contracts | The `runThemeCli` `delivery.pack` signature change is internal. The directory entry `source: {kind:"npm",name,version}` passes `directoryEntrySchema` in the tests. |
| Input validation | `--source` is validated (exit 2). `package.json` checks are explicit and each failure is named. |
| Data leaks | I3 (credential list gaps). Everything else is fine. |
| Fake success | Publish output says separately that it prepared the entry, did not publish to npm and did not submit to a Marketplace. It does not claim a publish that did not happen. |
| Node type stripping | No enums, namespaces or parameter properties in the new code. |

## Plan follow-up

All acceptance items appear met except the official docs item (M7). I recommend fixing I1 to I3 before merging.

Status: DONE_WITH_CONCERNS
Summary: No critical issues. Extraction is shared and safe, v1 compatibility logic holds, and the end-to-end tests are real. Three important issues should be fixed before merge: `pnpm pack` runs lifecycle scripts and its JSON parse breaks on their output; the Windows `shell: true` path triggers DEP0190 and hides the missing-pnpm hint; and the credential-file filter does not match the documented `.env*`.
