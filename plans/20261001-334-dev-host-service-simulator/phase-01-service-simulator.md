# Phase 1 — Service simulator and conformance

## Context

- Issue: https://github.com/digitopvn/clarkcant/issues/334
- Shared plan: [widget platform expansion](../260930-0200-widget-platform-expansion/plan.md)
- Existing contracts: `packages/contracts/src/grants.ts`, `packages/widget-sdk/src/index.ts`, `packages/widget-host/src/session.ts`.

## Requirements

- Load a bounded, data-only service fixture from the package; verify each binding refers to a declared tools capability.
- Model each declared service capability as loading, ready, blocked, or unhealthy with a bounded reason.
- Existing offline control makes all service bindings unavailable with the host's reason; mixed ready/unhealthy capabilities expose degraded behavior.
- Simulated restart visibly transitions through loading and recovers without starting a process.
- Send the bridge's existing `actions` and `action-result` messages; malformed configured outcomes become a valid refusal.
- Preserve dev-host behavior for packages without service facets and for built-in catalog previews.

## Files

- `packages/widget-cli/src/dev-shell.ts`, `dev-host.ts`, and a focused service-fixture/simulator module.
- Focused tests in `packages/widget-cli/test/dev-shell.spec.ts`, `dev-host.spec.ts`, and `conformance.spec.ts`.
- `apps/web/e2e/fixtures/notes-service/` for explicitly declared simulator bindings/responses.

## Validation

- Unit-test readiness transitions, offline precedence, unknown capability rejection, bridge message bounds, and malformed-response refusal.
- Run the focused widget-cli and widget-sdk tests before broader checks.

## Risks and rollback

- Fixture configuration must never widen capabilities or run package code; malformed declarations fail closed.
- Revert the dev-host simulator and its test fixture independently; no production service path or storage migration changes.
