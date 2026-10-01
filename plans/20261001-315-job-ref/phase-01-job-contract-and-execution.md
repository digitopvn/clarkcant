# Phase 01 — Job contract, durable store, supervisor and service execution

## Context

- Issue: [#315](https://github.com/digitopvn/clarkcant/issues/315).
- Existing contracts and owners: `packages/contracts/src/install.ts`, `apps/runtime/src/work-supervisor.ts`, `apps/runtime/src/service-host.ts`, `packages/mcp-adapters/src/stdio.ts`, and `packages/storage/src/repositories/work-runs.ts`.
- The current schema is migration 39. Applied migrations are immutable; add migration 40.
- Keep #314's action policy and effect ledger as the only invocation path.

## Requirements

- Define bounded `JobRef`, status (`queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`), progress, ArtifactRef results and a sentence error in shared contracts.
- Add an optional, explicitly versioned long-running mode to each service capability declaration; omission retains synchronous behavior.
- Persist owner principal, origin instance/binding, package generation, capability ref, conversation, state, progress, result refs, error and timestamps in a dedicated jobs repository.
- Add bounded node admission using the existing supervisor's job lane; register jobs as a WorkSource so list and cancel share the one work surface. Do not automatically replay jobs.
- Send MCP `tools/call` with a per-request progress token; parse only matching, validated `notifications/progress`. Reuse the existing cancellation notification on abort.
- Return a JobRef once the service request is accepted. Preserve uncertain effect-ledger semantics until the service has answered.

## Files to modify/create

- `packages/contracts/src/jobs.ts`, contract exports and service-capability schema.
- `packages/storage/src/migrate.ts`, `packages/storage/src/repositories/jobs.ts`, storage exports and focused migration/repository tests.
- `packages/mcp-adapters/src/stdio.ts` and `packages/mcp-adapters/test/stdio.spec.ts`.
- `apps/runtime/src/work-supervisor.ts`, `apps/runtime/src/job-host.ts`, action execution and runtime bootstrap/wiring.
- Focused tests for contracts, job ownership/state, work listing/cancel, MCP progress and action dispatch.

## Steps

1. Add contract/schema tests first, including missing/unsupported job version and unchanged synchronous declarations.
2. Add migration 40 and repository tests for owner tuple scoping, monotonic state transitions, progress bounds, result refs and terminal timestamps.
3. Extend stdio MCP handling with a request-scoped progress token/callback and validate notification token, finite monotonic progress and bounded message; retain existing cancellation behavior.
4. Add the job lane under WorkSupervisor's single list/cancel authority and connect it to the existing capability policy/effect ledger.
5. Prove another principal or binding cannot read/cancel a job and that Stop reaches its MCP request.

## Validation

- `corepack pnpm exec vitest run packages/contracts/test/install.spec.ts packages/storage/test/storage.spec.ts packages/mcp-adapters/test/stdio.spec.ts apps/runtime/test/work-supervisor.spec.ts apps/runtime/test/service-host.spec.ts apps/runtime/test/action-widget.spec.ts`
- Then `corepack pnpm verify` after phase 01.

## Risks and rollback

- A disconnected service may already have performed an effect. Mark the ledger unknown and the job failed with a may-have-run explanation; never retry it automatically.
- Schema and service messages are untrusted. Reject non-finite, regressing, oversized or mismatched progress before persistence or forwarding.
- Roll back code by reverting the PR. Keep migration 40 forward-only and data-compatible; do not edit migrations 1–39.
