# Advisory completion review — RECEIPT (not an affirmation)

The post-program advisory review was taken and it **rejected** the closeout rather than confirming it. Its two highest-value findings, each checked against the evidence it stated before acting:

## 1. A live P0 containment escape this program did not find

`packages/core/src/package-files.ts:71-80` checks containment with `resolve()` plus `startsWith`, then calls `statSync`/`readFileSync`. `resolve()` is lexical and `statSync` follows symlinks, so a link placed **inside** a package root that points outside it is read successfully. The review reproduced it by executing the real module: an inside-package `leak.txt -> ../secret.txt` returned `OUTSIDE-SECRET-BYTES`. Both authenticated routes reach it — `apps/runtime/src/routes/packages.ts:232` and `apps/runtime/src/routes/widget-serving.ts:41` — and `readPackageFile` has **no test file anywhere**, which is why it shipped.

This is the defect class Phase 2 fixed in `packages/pi-adapter/src/scoped-fs.ts` by canonicalising with `realpath` and refusing when the canonical path leaves the canonical root. It survives here because this function belongs to issue #93's scope, which the objective told this program not to duplicate.

## 2. The guard set was structurally wrong

The plan's merge constraint required each PR body to state that it does not close #93 **and** to contain no closing keyword for it. Those two requirements cannot both hold in English: the honest sentence contains the keyword. Worse, the Phase 6 check tested only `#2/#3/#4/#5`, and `tools/check-invariants.mjs` rejects any issue number outside that set — so #93 and #125 could not have been represented even if someone had tried. The guard should have been "every issue named in the body", never "the external gates".

Cheap prevention, in the repo's own idiom: the PR bodies are checked in under `plans/*/pr-*-body.md`, so a twelfth invariant could fail when a closing keyword sits adjacent to an issue reference in any of them. It is the only control here that would have fired before the merge.

## Corrections to my closeout, accepted

- "Terminal-green CI on the merged SHA" holds for PR heads, but the main-branch runs for `e0871aeb` (#139) and `cef02344` (#149) are cancelled, superseded by green runs on descendants. Coverage exists; the literal gate was not met twice and the closeout did not say so.
- "Each received an independent review pass" has no artifact for five of six phases: PRs #136/#139/#145/#147/#149 carry 0 reviews and 0 comments on GitHub, so that claim rested entirely on `evidence.md`.
- Phase 4's "explicit dependency interfaces" is only partly true — 2 of 17 route modules take the whole `NodeServices` bundle — and the closeout restated it flat after disclosing it as a MINOR.
- The Phase 5 invariant's bound is instantiated, not hypothetical: `V02` and `runtime.local-transport` are `implemented` with **all** cited evidence inside `describe.skipIf(!POSIX)` (`apps/runtime/test/portable-runtime.spec.ts:38,53,70,71`), so on a non-POSIX runner those two entries pass with zero executed evidence.

## What the review did not overturn

The six phases' code and the reproducible validation stand. It explicitly advised against re-running or re-auditing the phases, and agreed the seven deferred MINORs are consistent with the no-unrelated-cleanup criterion. It also agreed the missing per-PR advisory receipt does not invalidate the program — while noting the substitution traded one unverifiable receipt for five unverifiable reviews, and that an adversarial read of the PR-body sentence would have caught the self-contradiction before any merge.

## Action taken

Issue #93 was reopened and the four tracked-but-unfinished items were listed on it with the reproduction above. A correction was posted to #125 recording that its own "external gates remain linked and are not closed" criterion is unmet as written, and that its closure preceded Phase 6 by 53 minutes.

## Recommended follow-up order

The symlink escape first, with the regression test whose absence is why it shipped, and the misleading comment at `package-files.ts:76-78` corrected in the same change. Then the two grant-authority items (`routes/packages.ts:169-171` with `install-from-entry.ts:69`, and `DesktopSurfaces.tsx:511`), then #137, then the seven MINORs as one small PR, then the PR-body invariant.
