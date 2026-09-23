# Recorded advisory checkpoints, one per phase

The orchestration contract requires a `kongming` advisory checkpoint recorded for every phase. The first attempt at this was incomplete and the completion auditor rejected it: only one program-level checkpoint had been taken, and the later per-phase pass was a retrospective assessment posted as PR comments rather than a recorded set of checkpoints. This file is that record. Each entry names the phase, what was asked, what came back, the verdict, and where the assessment is published.

These were taken **after** the phases merged, judging each phase as it exists on `main` rather than as its PR claimed at the time. They are recorded as retrospective checkpoints, not presented as having happened during each phase.

| ID | Phase | PR | Verdict | Published |
| --- | --- | --- | --- | --- |
| ADV-1 | canonical execution policy | #130 | holds, with gaps | PR #130 comment; full text on #125 |
| ADV-2 | Pi `projectRoots` confinement | #136 | holds; strongest of the six | PR #136 comment; full text on #125 |
| ADV-3 | install dependency locking | #139 | module holds, build half unwired | PR #139 comment; full text on #125 |
| ADV-4 | runtime decomposition | #145 | holds | PR #145 comment; full text on #125 |
| ADV-5 | implementation-status source of truth | #147 | holds, with a contradiction | PR #147 comment; full text on #125 |
| ADV-6 | internal real-path proofs | #149 | bytes half holds | PR #149 comment; full text on #125 |

Source text for all six: `advisory-per-phase.md`.

## ADV-1 — canonical execution policy (#130)

**Question asked:** does the phase's deliverable hold as it exists on `main`, what is its strongest surviving weakness, did it bundle unrelated cleanup, and is anything overstated?

**Assessment:** holds. One `ExecutionPolicyConfig`, one reader enforced by an invariant, and the declared precedence is real in code — `prohibition` above `hardBoundary`, rules, then mode. Command, widget and install all reach `decideExecution`, and containment is explicitly not routed through the resolver.

**Findings:** the fourth effect surface is unbuilt — `preflightCapability` has no production call site, so the policy governs three of the four named surfaces. A `prohibition: "all"` node cannot be released from any UI although a comment claims it can. Mild unrelated cleanup: the PR swept the phase docs and review files in with the policy change. Overstated: the "one user-facing set of modes" claim, since a compatibility panel and a second control writing `execution.mode` both still render.

## ADV-2 — Pi `projectRoots` confinement (#136)

**Assessment:** holds, and it is the strongest of the six. Containment is decided on canonical paths, root identity is re-checked by `dev`/`ino` and `realpath` before admitting anything, and the check-then-open window is closed with `O_NOFOLLOW` plus an `fstat` of the descriptor.

**Findings:** the boundary is per-lane, and the same defect class survives where the phase did not look — the packed-worker lane contains lexically and is handed empty roots (filed as #137), and `packages/core/src/package-files.ts` follows an in-package symlink out of its root through two authenticated routes with no test for `readPackageFile`. No unrelated cleanup. Nothing overstated.

## ADV-3 — install dependency locking (#139)

**Assessment:** the module and the plan binding hold; the build half does not exist in production. Pinning, digest and drift refusal are real, the lock is bound into plan and generation, and joining a plan whose closure moved is refused by name.

**Findings:** no production build consumes the lock — the route resolves one request and always writes `coverage: "artifact-only"`, and the locked-build runner has no caller outside its own spec. There is also no range-to-version resolver in the repository. No unrelated cleanup. Overstated: the PR checklist ticks "build input includes a frozen dependency closure" while the closure is a single artifact pin enforced by nothing that runs.

## ADV-4 — runtime decomposition (#145)

**Assessment:** holds. `gateway.ts` is 237 lines of auth plus ordered dispatch, `main.ts` is 367, and the route/application/bootstrap modules are real. Test support is reached only through a dynamic import behind the fixture gates, so no static production import exists.

**Findings:** the "explicit dependency interface" was a per-family name over one common bundle — two route modules took the whole services object and every deps interface carried the same bundle. Those two have since been narrowed. No unrelated cleanup. Overstated: the PR body presents two evidence claims that the review had already superseded.

## ADV-5 — implementation-status source of truth (#147)

**Assessment:** holds, and the check is stronger than a data-file lint — it requires a named test that exists in the named file for `implemented`, a named gap for every other status, resolvable status references, and agreement with every traceability row.

**Findings:** the registry and the package-level vocabulary it swept contradict each other — `node-link` declares `external-blocked` while its own `V04`/`V05` entries are `implemented`, and the README's justification for that package is disproved by the two-node test the registry itself cites. Separately, evidence was checked for existence but not execution; the invariant now requires at least one cited test that is not platform-skipped, and `runtime.local-transport` is `partial`.

## ADV-6 — internal real-path proofs (#149)

**Assessment:** the bytes half holds. The capture is content-addressed, the route sniffs the bytes and asks for `no-store`, the fixed PNG constant is gone, and the real spec drives Chromium over two pages to two digests with no skip guard. The calendar pack gained its first tests.

**Findings:** the journey's entry point is a fixture and the production node never captures a frame — the capture function has exactly one caller, in test support. "End to end" is true of bytes to blob to authenticated route to card, and false of the node deciding to take the capture. No unrelated cleanup. Overstated: the unqualified "the preview journey is real, end to end" headline.

## Program-level checkpoint (taken before execution)

Separately, one program-level checkpoint was taken at plan time and returned GO with corrections. Eleven of its twelve corrections were adopted into Phase 1; its recommendation to reorder Phases 2 and 3 was rejected because the issue's own phase order is authoritative, with the risk handled by a spike instead. That rejection is recorded rather than smoothed over.

## Unavailable-advisor condition

The `ask_advisor` consult failed with `400 MissingSessionID` — a harness routing failure, not a review outcome. The advisory work was therefore carried out through the `kongming` agent. Recorded as the external blocker the objective asks for, rather than silently substituted.
