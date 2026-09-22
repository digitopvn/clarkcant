## Outcome

There is now one machine-readable source of truth for implementation status, and an invariant that keeps it honest, so a claim of "implemented" has to name a test that exists.

Phase 5 of #125. **Does not close this or any related issue.**

## The registry

`packages/contracts/src/implementation-status.ts` — a typed module, not prose and not JSON, because the invariant compares each entry against real package metadata and real test files.

| | |
| --- | --- |
| Entries | **34** — 16 implemented, 14 partial, 4 blocked, 0 not-implemented |
| Scope items | the 18 `V01`–`V18` rows |
| Capability claims | 16, covering all 18 former `@implementation-status` sites across 15 files |

`grep -rn "@implementation-status" packages apps packs examples` now returns nothing (18 → 0), and the invariant fails if the marker returns. Each entry carries `capabilityId`, `summary`, `status`, `owningPackage`, `phase`, `evidenceTests` and an optional `externalGate`. `phase` is checked against the owning package's own `clarkcant.phase`.

## The invariant

A tenth check, `implementation-status-registry`, in `tools/check-invariants.mjs`:

- every entry names an existing workspace package carrying that package's declared phase;
- **`implemented` requires at least one test whose title actually appears in the file it names** — so "the schema exists" cannot pass, because a schema has no title;
- every other status must name what is missing, and `implemented` may not carry an external gate;
- every `@status-ref` resolves, and each `V<n>` entry's status must equal the traceability row's in both directions;
- gates #2/#3/#4/#5 must each stay represented, and **no entry may pin a different issue number**.

It is demonstrated able to fail, not assumed to be. Five mutations, each run on the tree and reverted (exit 1, entry named):

```
✗ references capability nodelink.transportt, which the registry does not define
✗ example.note-widget names a test that is not in examples/note-widget/test/editor.spec.ts
✗ example.note-widget is implemented but names no test at all
✗ V14: registry says implemented (PASS) but the traceability document says PARTIAL
✗ external gate #5 is no longer represented by any registry entry
```

Two further checks were strengthened and are covered in the review history below: a `PASS`/`PARTIAL` row must name a quoted test title that exists (a bare spec basename no longer satisfies it), and the stub check now treats a `@status-ref` to a non-implemented entry as a stub claim. The T-id/V-id presence check was changed from a whole-document substring test to a row-marker test after review showed the substring version was vacuous — the prose range sentence spelled out `T01`–`T73` and `V01`–`V18`, so deleting a row still passed. It now fails with `✗ traceability document omits the T73 row`.

## What the reconciliation actually found

This phase's value was in the corrections, not the table. Review caught several places where the status surface lied, and each was fixed:

- **Five false claims that the product ships no detached host window.** It ships one: `apps/desktop/src/main.mjs` opens it via `detachedWindowOptions`, `apps/web/src/App.tsx` serves `?detached=1`, and the desktop and browser suites cover it — while the same document cited that suite as PASS evidence elsewhere. The true gap is that the *conformance harness* runs on a browser dev host, which has no detached window to drive.
- **A stub→implemented upgrade that discarded the gap it named.** `example.media-widget-contract` claimed implemented while its own comment pointed at a registry entry that named no missing component. Re-gated to `partial` with the missing mountable component named.
- **A status value that asserted a host that does not exist** (`implemented-against-reference-host` → `implemented-against-injected-fixture`).
- **Duplicate opposing `*_STATUS` constants** in three example packages, collapsed to one true value each.
- **A definition that did not decide the case the tree disagreed on**, which is why the root `README.md` now states what `clarkcant.status` means and how `external-blocked` differs from `implemented`.

No T-id or V-id was promoted or demoted: no status cell in the traceability table changed, and all 18 V rows already agreed with the registry. Several `@implementation-status` comments were corrected upward only where a named test exists and was run.

## External gates

**#2, #3, #4 and #5 remain OPEN** and are labelled as unproven, never as implemented. The invariant fails if any of them stops being represented. #93 is CLOSED, and no text in this branch presents it as an open gate.

## Verification

`pnpm invariants` all 10 checks pass (19 manifest entries verified) · `pnpm typecheck` clean · `pnpm lint` clean · `pnpm test` 186 files passed / 1 skipped, 2288 tests passed / 7 skipped · `pnpm verify` exit 0.

## Review history

Three review rounds. Round 1 requested changes with six IMPORTANT findings; round 2 found that round 1's fixes had themselves introduced a new false statement (the detached-window claim) plus two more; round 3 verified items 1, 2, 4 and 5 fixed and the manifest hash recomputed independently, and left one doc-scope item about the `clarkcant.status` definition, which this branch settles. Every fix was verified against the code before it was made, and no test was weakened, skipped or deleted at any point.

## Scope guard

This PR **does not** close #125, #2, #3, #4 or #5, and contains no closing keyword for them. The four Phase 3 and three Phase 4 MINORs recorded in the plan's `evidence.md` were deliberately left untouched, because bundling them would violate this program's no-unrelated-cleanup criterion.
