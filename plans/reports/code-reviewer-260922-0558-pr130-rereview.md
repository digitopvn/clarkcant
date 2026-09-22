# Re-review — PR #130 fixes (head 693851d, previous head c664ec9)

Scope: the six findings from `plans/260921-1322-125-architecture-consolidation/review-130-findings.md`, judged by reading the code and by running probes against the real modules. Review only; no files were changed.

## 1. CRITICAL — field-wise read of the canonical row — RESOLVED

`packages/core/src/execution-policy.ts:309-316` now answers from `parseExecutionPolicyConfig` (`packages/contracts/src/preferences.ts:297`) when the row declares an axis, and returns without writing. Test: `packages/core/test/execution-policy.spec.ts:349` ("keeps the mode and the refusal when the only bad leaf is inside the guardrails") asserts `mode: "ask"`, `prohibition: "all"`, the bad leaf costing itself, `revision: 1` and an empty `audit_log`.

Probed independently (in-memory DB, real migration): stored `{mode:"ask",prohibition:"all",guardrails:{instructions:12345,…}}` → read returns `ask`/`all` and the row is byte-identical afterwards; no audit row.

`declaresAnyAxis` (`:329`) is not a usable bypass:
- Every writer validates with `executionPolicyConfigSchema`, which requires `mode`. Probed: `writeRegisteredPreference("execution.policy", {mode:"sometimes"})` → `PREFERENCE_INVALID`; there is no route that can store such a row.
- Where the predicate does fall through, the migration joins the legacy families rather than defaulting. Probed: no-axis row `{mode:"sometimes"}` + legacy `autonomy = deny` → `guarded` / `prohibition: all` (narrower, refusal kept).

Residual (informational, not reachable through any writer): `declaresAnyAxis` tests the rules array all-or-nothing (`:335-337`) while `parseStoredRules` is entry-wise. A row with an unreadable `mode` **and** a rules list holding one valid deny plus one malformed entry goes to the migration and the deny is replaced by the join. Probed: `{mode:"confirm",rules:[{financial,deny},{bogus:true}]}` → `readExecutionPolicy` gives `rules: []` and rewrites the row, while `parseExecutionPolicyConfig` would have kept the deny. Because the registry schema requires a valid `mode`, no route in this build can store that row — hence not CRITICAL. Cheap fix if wanted: count a non-empty rules array as an axis when *any* entry parses.

## 2. IMPORTANT — `policyFromAutonomySettings` writes a patch — RESOLVED

`apps/runtime/src/autonomy-settings.ts:83` moves `mode` only when the body names a valid legacy value; `:94` sets `prohibition: "all"` only for `deny` and otherwise preserves `current.prohibition`. Probes on `{mode:"guarded",prohibition:"all"}`: body `{}` → unchanged; `{executionPolicy:"guarded"}` → `all` kept; `{jevGuardrails:false}` → mode kept; `{executionPolicy:"deny"}` → `all` added (mode `guarded`); `{executionPolicy:"auto"}` → `autonomous` with the refusal still in force. A refusal can be added through this shape and never lifted by it.

Tests call the route's own function, not the migration helpers: `apps/runtime/test/autonomy-settings.spec.ts:114` and `:135` (`saveAutonomySettings`), plus the wire-level test at `:211`.

## 3. IMPORTANT — refusal is inspected and reported — RESOLVED

`saveAutonomySettings` returns `SaveAutonomySettingsOutcome` (`apps/runtime/src/autonomy-settings.ts:113-125`) and the route answers `fail(400, saved.code, saved.message)` (`apps/runtime/src/gateway.ts:931`). Test `apps/runtime/test/autonomy-settings.spec.ts:211` posts 17 duplicate classes to `POST /autonomy` and asserts status 400, `code: PREFERENCE_INVALID`, `ok !== true`, and that the node still runs the default policy. The refusal is real: probed `guardrails.classes: Too big: expected array to have <=16 items`.

## 4. IMPORTANT — the `ask` branch consults the judgment layer — RESOLVED (not cosmetic)

`apps/runtime/src/node-tools.ts:660-676` runs `decideGuardrailForCommand` before the `decision.kind === "ask"` branch (`:678`); a refusal returns at `:663-667` with an audit entry and no card. The narrowed envelope is used for the card whole: digest recomputed from `guarded.command` / `guarded.cwd` (`:690`), payload carrying command, cwd and the budget (`:717-726`), and the same `guarded` envelope is what runs (`:783`).

Tests: `apps/runtime/test/command-policy.spec.ts:418` (refuse before any card, nothing runs), `:439` (carded `timeoutMs: 30_000` and `operationDigest === commandDigest("pnpm build", work)`), and `apps/runtime/test/run-command.spec.ts:122` (the narrowed budget is what runs and is clamped to `COMMAND_LIMITS`).

## 5. IMPORTANT — collision-proof audit id, duplicate does not throw — RESOLVED

`packages/core/src/execution-policy-migration.ts:345-376`: the id is `audit_execution-policy-migration_<principal>_<ordinal>`, the ordinal taken from the ids already in `audit_log` for that principal (`:349-353`); only a message containing `UNIQUE constraint failed` is swallowed (`:374`), everything else rethrows.

Probes: migrate (`…_1`) → `undoPreference` removes the row → read again returns the join (`guarded`/`all`) with **no throw** and a second, distinct id (`…_2`). A non-UNIQUE audit failure (injected `disk I/O error`) still propagates; a simulated UNIQUE is swallowed. Test: `packages/core/test/execution-policy-migration.spec.ts:320`.

## 6. IMPORTANT — one reader for the projections — RESOLVED

`apps/runtime/src/gateway.ts:1099` (`GET /preferences`) and `:1165` (`PUT`) both serve from `readExecutionPolicyPreference` (`packages/core/src/execution-policy.ts:371`), which returns the effective policy with the canonical row's markers; no route opens the key itself.

`tools/check-invariants.mjs:395` ("single-execution-policy-reader") passes on the tree (`1 canonical policy read(s) across 190 module(s)`) and has teeth: I copied the tree to `/tmp`, added one module calling `readRegisteredPreference`/`getPreference` with `EXECUTION_POLICY_PREFERENCE_KEY` (multi-line call), and the check reported `FAIL … reads the canonical policy preference directly`. The selector balances parentheses and fails when no read is found, so it cannot lose its own subject. Limitation (informational): the allowlist is per file, and a caller that goes through `listRegisteredPreferences` and picks the key out by string is not flagged.

## Regression check — PASS

- Test counts, observed on this worktree: `npx vitest run` → **167 files passed | 1 skipped (168)**, **2063 passed | 7 skipped (2070)**. Pre-fix file counts are identical; the +16 tests match the claim. The 7 skips are the pre-existing opt-in live suites.
- No test weakened, skipped or deleted: assertion counts rise in every touched spec (autonomy-settings 19→42, command-policy 61→72, parity 19→26, execution-policy 39→49, migration 62→68, preference-routes 32→42, run-command 40→43). The only removals are the fake "four surfaces" loop (replaced by real widget-seam tests, `packages/core/test/execution-policy-parity.spec.ts:254` and `:271`) and two marker assertions (see below).
- `npx tsc -p tsconfig.json` and `npx tsc -p tsconfig.web.json` exit 0; `npx eslint` on the touched source is clean; `node tools/check-invariants.mjs` is 9/9.
- No new Critical or Important defect. Three informational items:
  1. `GET /preferences` now writes and mislabels: `readExecutionPolicyPreference` runs the migration, so a plain GET stores a canonical row plus an audit entry and reports `execution.mode` / `execution.rules` / `execution.policy` as `isDefault: false, revision: 1` on a node where nobody chose anything (probed against the real route). That contradicts `packages/core/src/preference-registry.ts`'s third rule ("a read answers for every registered key … `isDefault: true`"), which is exactly the assertion the diff moved off `execution.mode` at `apps/runtime/test/preference-routes.spec.ts:79` onto `experience.theme`. Authority is not widened; the surface just can no longer tell a migration from a user choice.
  2. The `declaresAnyAxis` / `parseStoredRules` asymmetry described under finding 1.
  3. `packages/core/test/execution-policy-parity.spec.ts:372` still calls `decideExecution` three times with identical arguments and a different digest literal per "seam", so that table still cannot fail; the real cross-surface coverage now lives in the widget-seam tests at `:254` and `:271`.

## Verdict

**no actionable findings remain** — all six findings are resolved with code, tests and independent probes; no regression; the three informational items are optional follow-ups.
