## Code review — PR #130

Reviewed against the phase-01 plan (including its authoritative "Advisory corrections", AC-0…AC-9) and `AGENTS.md`, in two passes: an initial review at `c664ec9`, then a focused re-review at `693851d` after the fixes.

**Verdict: no actionable findings remain.**

### Initial review verdict: request changes

The architecture held up — one canonical policy, a pointwise join of the two legacy families with no constructible looser tuple, a structural `prohibition` evaluated above `hardBoundary`, the migration checking its write outcome, no weakened tests, no unrelated cleanup — but the review found one CRITICAL and five IMPORTANT defects, all on the live read and compatibility paths.

**CRITICAL — the authoritative read path used the all-or-nothing schema.**
`readExecutionPolicy` validated the stored row with `executionPolicyConfigSchema.safeParse`. The field-wise parser written for exactly that case was never reached, so a row whose only defect was one bad leaf failed the strict parse, fell through to the migration, and had `{mode, prohibition}` rewritten to `autonomous` / `"none"` — lifting a user's refusal and persisting the widened result. Reproduced against the real modules.

**IMPORTANT**
1. The legacy compatibility writer lifted `prohibition: "all"` and could move `mode` from a body that never mentioned it — the opposite of the care taken two lines away for `rules`.
2. `saveAutonomySettings` discarded the write outcome, so a refused write was reported to the client as saved.
3. The `ask` branch returned before the judgment layer, so an approved risky command ran the raw envelope — the user's guardrail instructions, host narrowing and refusals did not apply.
4. The migration's audit id keyed on a resettable preference revision, so a write/undo/re-read threw a UNIQUE violation *after* committing a policy change, leaving it unaudited.
5. `GET /preferences` read the policy key directly, so it could report `autonomous` for a node that refuses every effect.

Plus five MINOR findings (a cross-surface parity test that could not fail, a hardcoded guard-class list, shared mutable defaults, a JSON parse that throws on a hot path, and undo inconsistent with writes).

### Fixes and re-review: all resolved

| # | Finding | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Field-wise canonical read | RESOLVED | `packages/core/src/execution-policy.ts:309-316`; test `packages/core/test/execution-policy.spec.ts:349`. Probed: bad leaf keeps `ask` + `prohibition: "all"`, row byte-identical, no audit row |
| 2 | Legacy body is a patch | RESOLVED | `apps/runtime/src/autonomy-settings.ts:83`, `:94`; tests `apps/runtime/test/autonomy-settings.spec.ts:114`, `:135` |
| 3 | Write outcome inspected | RESOLVED | `autonomy-settings.ts:113-125`; route `apps/runtime/src/gateway.ts:931` answers 400; test `autonomy-settings.spec.ts:211` |
| 4 | Judgment layer before the card | RESOLVED (not cosmetic) | `apps/runtime/src/node-tools.ts:660-676`; card digest recomputed `:690`; narrowed envelope runs `:783`; tests `command-policy.spec.ts:418`, `:439`, `run-command.spec.ts:122` |
| 5 | Collision-proof audit id | RESOLVED | `execution-policy-migration.ts:345-376`; only a UNIQUE violation is swallowed; test `execution-policy-migration.spec.ts:320` |
| 6 | One policy reader + invariant | RESOLVED | `gateway.ts:1099`, `:1165` serve from `readExecutionPolicyPreference`; `tools/check-invariants.mjs:395` fails on an injected second reader |

### Verification

- `pnpm verify` passed on this tree: `Test Files 167 passed | 1 skipped (168)`, `Tests 2063 passed | 7 skipped (2054)`. Reviewer's independent run reproduced the same counts.
- `pnpm invariants` — 9/9, including the new single-reader check (1 read across 190 modules).
- `pnpm typecheck` exit 0; `pnpm lint` exit 0.
- Browser e2e on the touched journey (`apps/web/e2e/autonomy.spec.ts`) — 2 passed locally; the full suite ran green on the earlier head in CI (`e2e` job pass, 4m32s).
- Regression check PASS: no test weakened, skipped, deleted or loosened; assertion counts rise in every touched spec.

### Informational, not blocking

- `GET /preferences` now migrates on read and reports the execution keys as `isDefault: false, revision: 1` on a virgin node; the assertion covering "a preference nobody set is reported as a default" moved to a non-policy key.
- `declaresAnyAxis` parses `rules` all-or-nothing while `parseStoredRules` is entry-wise, so a row with an unreadable `mode` plus one malformed rule entry would lose that rule. Not reachable through any route; worth a follow-up.
- One parity spec still calls `decideExecution` three times identically and cannot fail, though real cross-surface coverage now exists elsewhere.

### Scope guard

This PR **does not** close #93, #2, #3, #4 or #5. Those external gates remain open and are not proven by fixture.

Full details: `plans/260921-1322-125-architecture-consolidation/review-130-findings.md`.
