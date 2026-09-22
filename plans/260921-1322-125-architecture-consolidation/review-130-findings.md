# Review findings — PR #130 (head c664ec9)

Source: independent code review (`code-reviewer`, fresh context) run under `/ak-review-pr 130 --fix --reply` on 2026-09-22. Verdict: **Request changes**. Claims A, B, E, F(i–iii), G **PASS**; C and D **FAIL**.

Reviewer's own runs on this worktree: focused suites 116 passed; full `vitest run` 2047 passed / 7 skipped; `pnpm typecheck` exit 0; `node tools/check-invariants.mjs` 8/8.

## CRITICAL — must fix

**1. `packages/core/src/execution-policy.ts:301` — the authoritative read path uses the all-or-nothing schema, so one bad leaf resets `mode` AND `prohibition` and then persists the widened result.**

`readExecutionPolicy` validates with `executionPolicyConfigSchema.safeParse(stored.value)`. The field-wise parser written for exactly this case (`packages/contracts/src/preferences.ts:297`, `parseStoredRules` at `:268`) is never reached — `parseExecutionPolicyConfig` is used only by the migration (`execution-policy-migration.ts:171-172,300`). When the strict parse fails the read falls through to the migration, and for a node with no legacy rows that returns `DEFAULT_EXECUTION_POLICY_CONFIG` (`autonomous`, `prohibition: "none"`) and **writes it over the user's row**.

Proven against the real modules with an in-memory DB migrated by the real migration:
- stored `{mode:"ask", prohibition:"all", rules:[], guardrails:{enabled:true, instructions:12345, classes:["commands"], whenUnavailable:"deny"}}`
- `parseExecutionPolicyConfig` → `{mode:"ask", prohibition:"all", …}` (correct, leaf-wise)
- `readExecutionPolicy` → `{mode:"autonomous", prohibition:"none", …}` **and the row now holds that**

AC-4 item 1 explicitly makes field-wise parsing a success criterion, and AC-2's point is that a refusal the user set cannot be lifted. One malformed leaf lifts `prohibition: "all"`, downgrades `ask → autonomous`, and rewrites storage so the damage outlives the request.

**Required fix:** read the canonical row with the field-wise `parseExecutionPolicyConfig`; treat a partially-valid row as valid-and-partial. Only fall through to migration when there is genuinely no canonical row.
**Required test:** the stored-input case above keeps `mode: "ask"` and `prohibition: "all"`, and the stored row is left unmodified.

## IMPORTANT — must fix

**2. `apps/runtime/src/autonomy-settings.ts:63-73` (`policyFromAutonomySettings`) — a compatibility POST silently lifts `prohibition: "all"` and can move the mode.**

`prohibition` is derived only from the incoming body (`family.prohibition ?? "none"`) instead of preserving `current.prohibition` when the body is silent — the opposite of the care taken two lines later for `rules` (`rules: [...current.rules]`, commented "a surface that never knew it was writing about it cannot delete a refusal").

Proven: node at `{mode:"guarded", prohibition:"all", whenUnavailable:"deny", classes:["commands"]}` + `saveAutonomySettings(deps, p, { executionPolicy: "guarded" })` → stored `prohibition: "none"` and legacy defaults. And `saveAutonomySettings(deps, p, { jevGuardrails: true })` on an Autonomous node → `mode: "guarded"`; `POST /autonomy {}` → `guarded`.

Why the CI guard missed it: `execution-policy-migration.spec.ts:131-140` tests `autonomySettingsFromPolicy`/`joinExecutionPolicies`, **not** `policyFromAutonomySettings` — a different function than the route uses.

**Required fix:** preserve canonical-only fields (`prohibition`, and any field the legacy body cannot express) from `current` when the body is silent. The legacy body has no way to clear a refusal — that is the safe direction and must be documented.
**Required test:** route-level test calling `saveAutonomySettings` (not the migration helpers) proving `prohibition: "all"` survives, and that an empty/partial body does not move the mode.

**3. `apps/runtime/src/autonomy-settings.ts:77-90` — `saveAutonomySettings` ignores the write outcome; the route reports `ok: true` for a policy never stored.**

`writeRegisteredPreference(...)`'s `PreferenceWriteOutcome` is discarded, `next` is returned as if stored, and `gateway.ts:917-932` echoes it as `policy` with HTTP 200.

Proven: `writeRegisteredPreference` with 17 duplicate `"commands"` → `{ok:false, code:"PREFERENCE_INVALID", message:"guardrails.classes: Too big: expected array to have <=16 items"}`; `saveAutonomySettings` with the same body returns a policy carrying 17 classes while the stored row is unchanged. `parseAutonomySettings` filters by validity but neither de-duplicates nor caps `guardedClasses` (`packages/contracts/src/execution.ts:171-173`) while canonical `classes` is `max(16)`.

**Required fix:** check the outcome and propagate the refusal so the route does not report success.
**Required test:** the 17-duplicate case returns a refusal and the route answers non-200.

**4. `apps/runtime/src/node-tools.ts:644-687` — the `ask` outcome returns before the guardrail stage, so an approved risky command runs un-narrowed and un-refused.**

The guardrail is consulted only on the `execute` branch (`:692`). Legacy `guarded` judged every covered command through Jev; canonical `guarded` cards those categories instead, and once the person approves, the command executes with the raw envelope, so `guardrails.instructions`, the host narrowing table and Jev's refusal no longer apply. Not a looseness by `deny<ask<execute` ordering (a card is stricter), but it inverts enforcement: the *more* restrictive mode gives *less* policy enforcement for exactly the categories the user wrote instructions about, and the published precedence table is inaccurate.

**Required fix:** run the judgment stage on the ask branch too — refuse before offering a card, and narrow the envelope used for both the card and the execution.
**Required test:** an `ask`-mode risky command whose guardrail refuses produces a refusal and no approval card; a narrowing constraint is reflected in the carded envelope.

**5. `packages/core/src/execution-policy-migration.ts:345-350` — audit id derived from a resettable revision; after the row is removed the next read commits a policy change and then throws.**

`auditId = …_r${outcome.preference.revision}` and `audit_log.audit_id` is a PRIMARY KEY. `POST /preferences/execution.policy/undo` is live (`gateway.ts:1176-1191` → `undoRegisteredPreference` → `undoPreference`, which deletes the row when `previousValue === undefined`, `packages/core/src/preferences.ts:154-160`).

Proven: first read writes (revision 1, audit `…_r1`); `undoPreference(execution.policy)` → `removed: true`; next `readExecutionPolicy` throws `UNIQUE constraint failed: audit_log.audit_id`. The write is committed before the throw, so the triggering request (command / install / widget action / `GET /autonomy`) fails with a DB error and the policy change is left **un-audited** — the one thing the module says must not happen. Self-heals on the next read, but `readExecutionPolicy` has no error boundary and is called per command, per widget action, per install, and from `main.ts:1243-1250`.

**Required fix:** derive a collision-proof audit id (do not key on a resettable revision) and do not throw on a duplicate.
**Required test:** write, undo, then read again — no throw and the re-migration is audited.

**6. `apps/runtime/src/gateway.ts:1084` and `:1148` — a second read of the policy preference key that can disagree with the authority (claim D FAIL).**

Both project `execution.mode` / `execution.rules` from `readRegisteredPreference(…, EXECUTION_POLICY_PREFERENCE_KEY)` directly instead of from `readExecutionPolicy`. When no canonical row exists, `envelope` returns the registry default with `isDefault: true`, so on an upgraded node whose legacy `autonomy` is `deny`, `GET /preferences` reports `execution.mode: "autonomous"` while the node refuses every effect.

**Required fix:** serve both projections from `readExecutionPolicy`. Add the AC-5 grep invariant to `tools/check-invariants.mjs` so only one module reads policy preferences (the PR claims this but nothing enforces it).
**Required test:** on a node with legacy `autonomy = deny` and no canonical row, `GET /preferences` does not report `autonomous`.

## MINOR — fix where cheap, otherwise record

7. `packages/core/test/execution-policy-parity.spec.ts:155-182` — "one policy, four surfaces" cannot fail: it calls `decideExecution` four times with identical arguments and only uses `surface` in a label, importing no seam. It prints "cross-surface tuples evaluated: 336" (84 cases × 4), which reads as evidence it does not measure. Also: no test passes `policy` to `invokeMiniAppAction` (the widget surface has zero coverage of the new plumbing), and `apps/runtime/test/package-install-route.spec.ts:132-152` still drives "asks first" by writing the raw legacy `execution.mode` row.
8. `packages/core/src/execution-policy-migration.ts:236-238` — `joinGuardrails` hardcodes the six guard classes as a literal, so a seventh added later is silently dropped from the union. `GUARD_CLASSES` was available.
9. `execution-policy-migration.ts:245-249` and `preference-registry.ts:90` — returned defaults share arrays with module constants; a mutating caller would corrupt the process-wide default.
10. `packages/core/src/preferences.ts:52` → `packages/storage/src/db.ts:174-183` — `toRecord` uses `parseJson`, which throws on malformed JSON. The pre-PR reader caught exactly that and fell back to defaults, so a corrupt row now throws out of every policy read.
11. `gateway.ts:1176-1191` vs `:1139` — legacy-key writes are translated to the canonical policy, undo is not; `POST /preferences/execution.mode/undo` undoes a row nothing reads.

## Reviewer's caveats worth carrying forward

- No production call site ever passes `hardBoundary`, so the prohibition-above-boundary ordering is proven only in unit tests.
- Every production call site passes `explicitUserIntent: true`, so the autonomous risk gate is unreachable in production; it holds today only because the sole non-user-initiated model path uses a Pi worker with `projectRoots: []` and no tools.
- Finding 5's refusal branch in the migration is reachable only through the injected seam; the same discipline is missing where a refusal *is* reachable (`saveAutonomySettings`, finding 3).
