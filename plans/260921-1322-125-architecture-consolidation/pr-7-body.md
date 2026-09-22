Addresses the acceptance-criteria findings from the completion audit of #125.

## What changed

- **The install route now consumes the frozen closure it records.** The route resolves the closure over the artifact, writes the lock, reads it back through the same reader the locked-build path uses, takes that path's own admission, and reports `lock.buildable` / `lock.buildRefusal` in the install result, so the refusal is production-visible rather than only test-visible. Coverage stays `artifact-only` on purpose, because widening it would name a dependency tree nobody read.
- **The Control tab has one policy surface.** The second control that also wrote `execution.mode` is deleted, so no control on that screen can silently overwrite the mode. The mode itself and the legacy migration semantics are unchanged, and a client that still spells `execution.mode` can still read the server-side projection. The e2e journey now asserts exactly one `autonomy-policy` segmented control and zero `execution-mode` ones.
- **The per-phase advisory checkpoints are recorded** as durable artifacts rather than only as PR comments.

## Honest limits, stated rather than implied

Two clauses the audit named are **not** satisfied, and this PR does not pretend otherwise:

1. **"A build fails rather than re-resolving floating ranges" is still unproven on a real path.** The repository has no production step of that kind, and no dependency metadata source able to answer what a range resolves to: a directory entry carries no dependency field, a package's declared dependencies live inside the artifact the route has not downloaded, and there is no registry client or range resolver anywhere. Proven instead: a floating range can never enter the lock, the recorded closure is read under the plan's reference and refused fail-closed rather than re-resolved, and drift invalidates prior consent. The unprovable clause needs a dependency metadata source and a production step that does not exist, which is beyond the six phases.
2. **The capability-effect clause is not achievable here.** There is no production capability-effect execution path — capabilities are registered, listed and probed, and every dispatch path acknowledges without executing (`runDispatchedTask` has no production caller; the one production widget-action admission answers `UNSUPPORTED_ACTION`). `preflightCapability` therefore has nowhere real to be wired, and wiring it into the pack probe would be cosmetic, so it was left alone. Satisfying this clause means building a new executor, which is scope beyond this program.

## Registry

No status changed. `V08` stays `partial`; its gate reason was made more precise, and nothing was raised or lowered to satisfy a criterion.

## Verification

Focused specs 39 passed (install route 16, dependency lock 23); `pnpm typecheck` passed; the autonomy e2e journey passed; `pnpm invariants` all 12 checks pass. A transient failure of `session-preview-real.spec.ts` was observed under load in two full runs and passes in isolation — recorded as a known flake, not caused by this change.

## Scope guard

No external gate is completed by this PR. Issues #93, #2, #3, #4 and #5 remain as they were, and this body carries no closing keyword for any of them.
