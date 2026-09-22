## Outcome

A package install plan now identifies not just the source artifact but the exact dependency closure the activated generation consumes. The closure is resolved **before** any executable build step, frozen into an immutable artifact, and bound into the plan and generation by digest — so the user consents to specific bytes rather than to a resolver's later choice.

Phase 3 of #125. **Does not close this or any related issue.**

## Why this mattered

V08 stayed PARTIAL because quarantine and build isolation existed but a package's own dependency tree was still resolved at build time by whatever the package manager offered then. That breaks the digest-bound consent story: the user could approve one artifact while the transitive bytes were selected afterwards. The capability-host module said so itself ("Not built: dependency locking").

## How It Works

- **Resolve first, build second.** `dependency-lock.ts` resolves the closure to `{ name, version, integrity, resolvedFrom }` before any executable step. npm, git and local sources stay distinguishable rather than flattened into one provenance story; a closure that cannot be pinned is refused, naming the request that has no metadata.
- **Freeze, digest, bind.** The lock is materialised deterministically (sorted, stable) and hashed with the existing scheme. Its reference and digest travel into the install plan and the facet generation, so the build consumes exactly what was consented to.
- **Drift fails closed.** If metadata now resolves to a different closure, or the artifact moved, or a build input changed, the build stops and names what changed. Missing or mutated lock material refuses rather than re-resolving. A project that adds a load-time script is reported as drift, not accepted silently.

## Verification

- `pnpm verify` — **PASSED** on this commit: `Test Files 182 passed | 1 skipped (183)`, `Tests 2238 passed | 7 skipped (2245)` (invariants, typecheck, lint, tests).
- `pnpm exec vitest run packages/capability-host/test/` — 3 files, **44 tests passed** (`dependency-lock.spec.ts` 21, `quarantine.spec.ts` 11, `secrets.spec.ts` 12).
- The five required cases, each by name in `packages/capability-host/test/dependency-lock.spec.ts`:
  - a floating range is pinned to the exact version its metadata names;
  - the build runs the recorded version rather than what metadata would resolve now;
  - drift stops the build and names the dependency, including an added load-time script and a moved build input;
  - missing, mutated, uncovered or out-of-directory lock material fails closed;
  - nothing unapproved gains execution, and declared scripts proceed only when approved by name.
- Digest stability is covered: the same input hashes the same, any changed pin hashes differently, and a frozen artifact stays as it was when a later resolution produces a different closure.

## Scope notes

- No storage migration was needed and `packages/storage/src/migrate.ts` is untouched; no file under `packages/storage/` changed.
- Quarantine, digest-before-inspect, the isolated credential-minimal build and the lifecycle-script gate are intact, with the credential-minimal environment covered by test when a build runs through the lock.
- A lockfile proves reproducibility, not that native code is safe. `docs/conformance-traceability.md` records V08 to the extent actually proved and states what remains outside this claim.

## Acceptance criteria (Phase 3)

- [x] Build input includes a frozen dependency closure with a stable digest/reference.
- [x] Dependency drift invalidates prior plan/consent.
- [x] Build does not silently re-resolve floating ranges.
- [x] Lifecycle-script and credential-isolation guarantees remain intact.

## Scope guard

This PR **does not** close #93, #2, #3, #4 or #5, and contains no closing keyword for them. Those external gates stay open and are not proven by fixture.

## Review outcomes (round 1)

Three Important findings were fixed after review; two of them narrow what this PR may claim, so they are disclosed here rather than buried in commits.

- **The coverage gate now sits inside the function that spawns the build.** Review found the refusal living in `prepareLockedBuild` (the pipeline in front of the runner) while `isolatedLockedBuild` — which actually invokes the contained build — checked only the lifecycle gate. A lock declaring `artifact-only` coverage passed straight to the runner was accepted, and nothing in production calls either entry point yet, so the guarantee rested on a two-call protocol nothing enforced. The check is now shared by both entries and enforced in the runner; `isolatedBuild` is documented as the lower-level primitive that deliberately does not repeat it, because it takes an environment and cannot know where that environment came from.
- **A plan recorded before this release is named as such.** Installing a package that already has a live plan row from before the frozen build input existed returns `LOCK_DRIFT`; the refusal is deliberate and fails closed, but the message previously implied a closure had moved when none was ever recorded. It now identifies the plan id and state, says the plan predates the frozen build input, states plainly that this is not drift, and tells the person to wait for the rollout that plan records rather than installing twice. This is an upgrade interaction, and it is intentional: an unrecorded closure is not silently joined.
- **Range resolution is the metadata source's contract, not this module's.** `resolveDependencyClosure` never reads the declared request spec, so a range like `^1.2.0` is pinned to whatever exact version the configured metadata source names; this module does not check that the named version satisfies the range, and no range-to-version resolution exists in the repository. What it does guarantee is that a range string can never enter a lock and that a non-exact answer is refused. The V08 row and the module documentation now say that instead of implying a resolver that is not there.

Also fixed: an unreadable or non-file artifact is labelled `LOCK_UNREADABLE` with its errno instead of being reported as absent; `dependencyDrift` compares by name **and** version so two versions of one name cannot collapse into nothing; and the `frozenBuildEnvironment` comment now describes the stable key order it actually relies on rather than claiming canonical JSON.
