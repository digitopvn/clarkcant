Final head: 374e100a2c65a7c4ae6ce98595d6ba1be8d9abf9. Local full verification passed: 4,954 unit tests and 328 browser journeys; final paired-DESIGN-only update was followed by another successful `pnpm verify`.

Both complete CI runs have finished. Push run 36717013749 passed its complete browser suite, but its Linux Node 22.19 HTTP dev-host test exceeded 20 seconds. The same test in PR run 36717022516 passed in 323 ms on this exact head. All other platform/desktop/rootless/security jobs passed.

PR run 36717022516 exceeded the 60-second total budget in the typed-sentence/keyboard theme journey, including retry. The first failure was at the final overflow read (`appearance-depth.spec.ts:467`); no assertion failure was reported. That journey passed in the duplicate push run and local full run. The exact cause of either timeout is not yet established; these are not being treated as successful checks.

Rerun only failed jobs now that the full runs have completed. Preserve the original logs and block merge until both runs are green. A repeated failure will require investigation and a cause-aligned repair rather than further blind retries.
