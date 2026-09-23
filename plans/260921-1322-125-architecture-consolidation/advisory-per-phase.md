# Retrospective advisory review-gate assessment, one block per phase

Posted per phase on that phase's PR, and in full on #125. Source: an independent advisory review pass run after the completion audit rejected the closeout, judging each phase as it exists on `main` today rather than as its PR claimed at the time. Each block names the strongest surviving weakness rather than affirming the phase.

## Phase 1 — #130

**Verdict: holds.** `packages/contracts/src/preferences.ts:239` is the one `ExecutionPolicyConfig`, `packages/core/src/execution-policy.ts:309` is the one reader (enforced by `tools/check-invariants.mjs`), and the declared precedence is real in code: `prohibition` at `:164`, hard boundary at `:181`, rules at `:193`, mode after. Command, widget and install all reach `decideExecution`, and containment is explicitly not routed through the resolver (`packages/pi-adapter/src/scoped-fs.ts:13`).

**Strongest surviving weakness: the fourth surface is still unbuilt.** `preflightCapability` (`apps/runtime/src/preflight.ts:305`) has no production call site — only its own spec — so "one policy governs command / widget / install / capability effect" is three of four; there is no capability-effect executor to govern yet. Second: a `prohibition: "all"` node cannot be released from any UI. `apps/runtime/src/autonomy-settings.ts:94` only ever sets `prohibition`, never clears it, and no client file writes the field — yet the comment at `:92-93` states Settings → Control has its own control for lifting it. It does not.

**Unrelated cleanup: mildly, yes.** The PR swept all six phase docs, `red-team.md` and two review files into the policy change. The code part is in scope.

**Overstated:** the plan's "one user-facing set of modes" is not met — `packages/conversation-client/src/settings/ControlSettings.tsx:206` still renders the compatibility panel and `:336-339` a second control writing `execution.mode`, with the overwrite hazard recorded in `evidence.md`. AC-9 permitted the split, but no follow-up issue tracks it.

## Phase 2 — #136

**Verdict: holds, and it is the strongest of the six.** `packages/pi-adapter/src/scoped-fs.ts:263` decides containment on canonical paths, re-checks root identity by `dev`/`ino` and `realpath` before admitting anything (`:290-315`), and closes the check-then-open window with `O_NOFOLLOW` plus an `fstat` of the descriptor (`:347`). The binding is built from the brief rather than left to the call site (`real.ts:423-460`), and `real.ts:539` refuses `registerTool` on a confined session.

**Strongest surviving weakness: the boundary is per-lane, and the same defect class survives where this phase did not look.** `apps/worker/src/tools.ts:31-45` contains lexically (`resolve()` only, no `realpath`) while its own doc comment claims symlinks are accounted for, and that lane is handed `projectRoots: []` at `apps/runtime/src/pack-load.ts:118` — filed as #137. The worse instance is route-reachable and untouched: `packages/core/src/package-files.ts:71-80` uses `resolve()` plus `startsWith` then `statSync`/`readFileSync`, so an in-package symlink pointing outside is followed — reachable from `routes/packages.ts:232` and `routes/widget-serving.ts:41`, with no test file for `readPackageFile` anywhere. Tracked by the reopened #93.

**Unrelated cleanup: no.** All 14 files belong to the change.

**Overstated: nothing substantiated.** The empty-`projectRoots` lane is disclosed in the type comment rather than claimed closed.

## Phase 3 — #139

**Verdict: the module and the plan binding hold; the build half does not exist in production.** Pinning, digest and drift refusal are real (`packages/capability-host/src/dependency-lock.ts:103`, `:542`, `:560`; `quarantine.ts:258`), the lock is bound into plan and generation, and joining a plan whose closure moved is refused by name.

**Strongest surviving weakness: no production build ever consumes the lock.** `apps/runtime/src/application/package-install.ts:162-181` resolves exactly one request — the artifact itself — and always writes `coverage: "artifact-only"`. `prepareLockedBuild` and `isolatedLockedBuild` have no caller outside their own spec, so an artifact-only lock would be refused `LOCK_INCOMPLETE` by the runner it is meant to feed, and "the build does not silently re-resolve floating ranges" is unproven on any real build path. There is also no range-to-version resolver in the repository at all.

**Unrelated cleanup: no.** All 19 files are the install/lock surface, its contract, the conformance row and the lockfile.

**Overstated:** the PR checklist ticks "build input includes a frozen dependency closure" while the closure is a single artifact pin enforced by nothing that runs. The PR's round-1 section and the V08 registry row do disclose this, so the overstatement is confined to the checklist and the closeout sentence.

## Phase 4 — #145

**Verdict: holds.** `apps/runtime/src/gateway.ts` is 237 lines of auth plus ordered dispatch, `main.ts` is 367, and the 17 route / 5 application / 4 bootstrap modules are real. `test-support/` is reached only through `apps/runtime/src/bootstrap/fixtures.ts:48`, a dynamic import behind the `CC_*_FIXTURE` gates — no static production import exists.

**Strongest surviving weakness: the "explicit dependency interface" is a per-family name over one common bundle.** `routes/control.ts:24` and `routes/conversations.ts:74,84` took the whole `NodeServices` (37 fields), and every route module's deps interface carried the same bundle, so ownership boundaries shrank in file terms without shrinking in substance. Not the forbidden locator — injected at composition, never looked up — but the claim was weaker than the word "explicit". Those two modules have since been narrowed to the fields they read, with a negative probe proving the narrowing bites.

**Unrelated cleanup: no.** All 35 files are the runtime split and the moved fixtures; no test file changed.

**Overstated:** `pr-4-body.md` presents "187 route-focused tests before and after" and "startup stderr byte-identical" as evidence, while `evidence.md` records that the reviewer left both unverified and that they must not be restated as established. The absent `policy/` directory is disclosed.

## Phase 5 — #147

**Verdict: holds, and the check is stronger than a data-file lint.** `tools/check-invariants.mjs` requires a named test that exists in the named file for `implemented`, a named gap for every other status, resolvable `@status-ref`s, agreement with every V-row in the traceability document, and failure if any `@implementation-status` marker returns.

**Strongest surviving weakness: the registry and the package-level vocabulary it swept contradict each other.** `packages/node-link/package.json` says `external-blocked`, while `V04` and `V05` — both owned by that package — are `implemented` citing `apps/runtime/test/peers.spec.ts`. `README.md` justifies node-link as a package where "nothing it ships can be exercised on this machine", which the two-node delegation test the registry itself cites disproves. Separately, evidence was checked for existence but not execution: `V02` and `runtime.local-transport` were `implemented` with every cited test under `describe.skipIf(!POSIX)`. The invariant now requires at least one cited test that is not platform-skipped, and `runtime.local-transport` is `partial` because its Unix-socket half genuinely cannot be exercised off POSIX.

**Unrelated cleanup: no unrelated work, but a wide sweep** — seven `package.json` status words, `README.md`, `docs/widget-development.md` and three example markers, all of which is the reconciliation itself.

**Overstated:** the README's `external-blocked` rule as applied to `packages/node-link`, above.

## Phase 6 — #149

**Verdict: the bytes half holds.** `apps/runtime/src/session-preview.ts:95` captures through the driver and content-addresses the result; `routes/previews.ts:30,50,58` sniffs the bytes and asks for `no-store` through `binary.cache`; the 29-byte constant is gone; and `apps/runtime/test/session-preview-real.spec.ts:156` runs real Chromium, two pages, two digests, with no skip guard. `packs/google-calendar/test/connector.spec.ts` gives that pack its first tests at all, and #2/#3/#4/#5 stay open with `V14` kept `partial`.

**Strongest surviving weakness: the journey's entry point is a fixture, and the production node never captures a frame.** `captureSessionPreview` has exactly one caller — `apps/runtime/src/test-support/browser-frame.ts:80`, reached from `test-support/fixture-model.ts:384` — and the only producer of a `browser-session-card` in the repository is `fixture-model.ts:392`. "End to end" is true of bytes → blob → authenticated route → card rendering, and false of the node deciding to take the capture. Nothing in the PR body or the `V14` row says this; it is disclosed only in the fixture's own comment.

**Unrelated cleanup: no.** All 21 files are the preview/calendar seams, the two real defects the evidence found (placeholder sniff type, silent `cache-control` override) and the conformance row.

**Overstated:** the unqualified "The preview journey is real, end to end" headline, given the above.
