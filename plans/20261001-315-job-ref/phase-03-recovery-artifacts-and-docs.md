# Phase 03 — Recovery, result artifacts, notices, docs and verification

## Context

- Recovery is owned by `apps/runtime/src/work-recovery.ts`; notices and conversation notes use the existing inbox/storage and host-reply paths.
- #313 owns ArtifactRef creation and byte storage; #315 must not introduce service paths or a second file broker.
- Internal docs are bilingual; `docs/conformance-traceability.md` is English-only. Official docs live in `digitopvn/clarkcant-web` and require a separate EN/VI PR after the feature PR merges.

## Requirements

- A node restart marks an open service job failed with the service-loss reason; an effectful job remains unconfirmed and is not submitted again.
- For a service answer containing file bytes, create host-owned ArtifactRefs through #313, enforce existing size/type/quota rules, and expose refs only to the authorized instance.
- Record one deduplicated completion/failure/cancel notice or conversation note that names produced artifacts and gives an honest next step.
- Block conversation deletion while a job is active, then allow ordinary cleanup after terminal state.
- Update EN/VI widget authoring and extension docs and the English conformance ledger only after the behavior is implemented and tested.
- Update official website docs in EN/VI after product merge; verify the deployed pages or open the documented `ai-handle` fallback issue if blocked.

## Files to modify/create

- `apps/runtime/src/work-recovery.ts`, startup wiring, `apps/runtime/src/application/emergency-stop.ts` and focused tests.
- Artifact broker/service result conversion and tests under runtime/storage; conversation deletion activity checks.
- `docs/widget-development.md`, `.vi.md`, `docs/widgets-and-extensions.md`, `.vi.md`, `docs/open-interfaces.md`, `.vi.md` only if a public route is added, and `docs/conformance-traceability.md`.
- `digitopvn/clarkcant-web` CLI docs EN/VI in a separate PR after feature merge.

## Steps

1. Add recovery tests for service restart, completion race, effectful uncertainty and proof that no request is replayed.
2. Add E2E with a fixture long-running capability: progress, remount, widget and emergency Stop, result ArtifactRef, notice, and reload recovery.
3. Update internal docs and conformance status against the actual implementation; run plan validation, invariants, focused tests and `pnpm verify:full`.
4. Review the final diff and CI on Linux/macOS/Windows. Merge product PR only when all required checks pass; then open/merge official EN/VI docs PR and verify production.

## Validation

- Focused storage/recovery/notice/widget E2E tests, then `corepack pnpm verify:full` and `corepack pnpm invariants`.
- GitHub PR checks must pass, including Windows Node 24 and relevant browser E2E.
- `ak plan validate plans/20261001-315-job-ref` and `git diff --check`.

## Risks and rollback

- The service may complete just before cancellation or shutdown. Preserve the actual terminal answer if received; otherwise record a failed/uncertain explanation without claiming cancellation prevented the effect.
- Artifact output stays inside #313's owner, grant, quota, type and conversation boundaries. Never serialize paths or bytes through JobRef.
- Revert the product PR for code rollback; preserve migration 40. Land a matching docs correction if official docs were already merged.
