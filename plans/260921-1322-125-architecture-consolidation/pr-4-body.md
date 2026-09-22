## Outcome

`apps/runtime` is decomposed so that ownership and dependencies are explicit. `main.ts` is composition/startup, `gateway.ts` authenticates and routes, business flows live in application services, and the deterministic fixtures are isolated behind an explicit gate.

This is a **behavior-preserving refactor**. No public route, method, status code or response shape changed.

Phase 4 of #125. **Does not close this or any related issue.**

| File | Before | After |
| --- | --- | --- |
| `apps/runtime/src/gateway.ts` | 3825 | **237** |
| `apps/runtime/src/main.ts` | 1972 | **367** |

## How It Works

- **`routes/` (17 modules)** owns HTTP parsing and response mapping only: `public`, `node`, `voice`, `control`, `credentials`, `record-read`, `search-memory`, `mini-app-data`, `widget-serving`, `peers`, `attachments`, `previews`, `preferences`, `packages`, `interactions`, `conversations`, and `http` for the shared primitives. Each takes an explicit dependency interface; each returns "not mine" so the gateway's dispatch chain falls through in the same order it did before.
- **`application/` (5 services)** owns the flows: `package-install`, `widget-actions`, `emergency-stop`, `credential-vault`, `model-choice`. A service receives its dependencies and answers with a result rather than a response.
- **`bootstrap/` (4 modules)** composes: `runtime-bootstrap`, `model-bootstrap`, `voice-bootstrap`, and `fixtures`. **`test-support/` (5 modules)** holds the deterministic fixtures (`fixture-model`, `fixture-session`, `fixture-voice`, `voice-fixture`, plus an index). `bootstrap/fixtures.ts` is the only place `test-support/` is named and it is reached by a **dynamic** import only when a `CC_*_FIXTURE` gate matched, so no static production import of test-support exists.

`gateway.ts` keeps only the auth core (frame-grant verify, peer uplink, bearer check, pairing), the ordered dispatch calls, `/command`, and the final 404.

## Evidence that behavior did not change

This is the part that matters for a refactor, so it is evidenced four ways rather than asserted:

- **The whole runtime suite is identical to the pre-move baseline**: `pnpm exec vitest run apps/runtime/test` → 68 files passed / 1 skipped, **727 passed** / 7 skipped, both before any move and after the last one.
- **The route-focused specs were measured before and after the split** by temporarily restoring the pre-move `gateway.ts`: **187 passed before, 187 passed after**.
- **Startup stderr is byte-identical** to a pre-refactor capture for both a fixture node and a no-gate node, apart from the node id.
- **A live probe against a fixture node exercised all 13 scripted paths** successfully.

Two real behavior leaks were introduced during the work and caught before landing: the scripted composer and the scripted voice adapter were being created whenever *any* gate was on, rather than only when their own gate was; both now depend on their own gate. A pre-existing unreachable second turn-control block was preserved as-is rather than quietly deleted.

## Verification

- `pnpm verify` — **PASSED** on this tree: `Test Files 186 passed | 1 skipped (187)`, `Tests 2279 passed | 7 skipped (2286)` (invariants, typecheck, lint, tests).
- `pnpm test:e2e` — **PASSED**: 127 passed, 1 skipped (3.8m), with ports 8876 and 4273 freed first.
- `pnpm invariants` 9/9; `pnpm typecheck` exit 0; `pnpm lint` clean.

## Acceptance criteria (Phase 4)

- [x] `main.ts` is primarily composition/startup (1972 → 367 lines).
- [x] Gateway route families have explicit dependencies and smaller ownership boundaries (3825 → 237 lines).
- [x] Test fixtures are separated from normal production composition and reached only through an explicit, dynamic gate.
- [x] No public behavior regression is introduced (evidenced above).

## Scope notes

- The plan's file list sketched a `policy/` directory. No such module was created, because the plan states that list is "a direction, not a mandatory filename list", and the policy seams already live at `src/autonomy-settings.ts`, `src/preflight.ts` and `src/jev-decider.ts`. Moving them for naming alone would be churn without an ownership change, and Phase 1 deliberately established the ordering they enforce.
- No service locator or container object was introduced: route modules receive explicit interfaces.
- `contracts`, `core`, `storage`, `pi-adapter`, the widget trust lanes and NodeLink were not touched.

## Scope guard

This PR **completes no external gate**. Issues #93, #2, #3, #4 and #5 stay as they were and are not proven by fixture, and this body carries no closing keyword for any of them.
