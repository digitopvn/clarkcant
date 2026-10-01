# Phase 02 — Widget bridge, SDK and dev-host simulation

## Context

- The host bridge is an opaque-origin MessagePort contract in `packages/widget-sdk/src/index.ts` and `packages/widget-host/src/session.ts`.
- Follow the versioned `artifacts@1` extension pattern. A JobRef is a pointer, never authorization; every operation rechecks the originating binding.
- `packages/widget-cli` owns the fixture-backed dev host and `clark widget test` conformance.

## Requirements

- Add a versioned `jobs@1` extension with `jobs.get(ref)`, `jobs.cancel(ref)` and `jobs.subscribe(ref, handler)`.
- The host reauthorizes each request against the current principal, instance, binding and package generation. A remounted instance can read its current job snapshot.
- Subscription delivery is bounded and resumes from persisted state; unsubscribe/dispose releases host listeners/timers.
- Dev host fixtures simulate queued/running progress, completion, failure and cancel. Label all results as simulated and never call real services/providers.

## Files to modify/create

- `packages/widget-sdk/src/index.ts` and SDK tests.
- `packages/widget-host/src/session.ts` and session tests.
- `packages/conversation-client/src/WidgetFrame.tsx` plus its host/runtime wiring and tests.
- `packages/widget-cli/src/dev-host.ts`, `dev-shell.ts`, `conformance.ts`, corresponding tests and package fixtures.
- Browser E2E for action-to-JobRef, progress, unmount/remount, widget cancel, and unavailable/invalid refs.

## Steps

1. Add bridge schemas and SDK behavior with tests for missing extension, duplicate subscriptions, disposal and bounded messages.
2. Wire the trusted host callback to the runtime job owner; keep bearer credentials and direct network access out of the frame.
3. Add deterministic dev-host fixture controls and conformance checks; verify blocked/failed states are readable and not blank/spinning forever.
4. Run focused host/SDK/dev-host tests and the widget browser journey at keyboard, theme and mobile viewport coverage.

## Validation

- `corepack pnpm exec vitest run packages/widget-sdk packages/widget-host packages/conversation-client/test/widget-jobs.spec.ts packages/widget-cli/test`
- `corepack pnpm run test:widget-browser`
- The focused browser E2E must verify progress provenance, persistence through remount, cancellation and refusal across binding ownership.

## Risks and rollback

- Stale frames must not attach to a replacement package generation. Bind subscriptions and requests to the exact frame nonce and persisted origin tuple.
- Avoid unbounded polling/listeners; cap active subscriptions and stop them on dispose.
- Roll back by reverting bridge/runtime changes together so no side depends on an unsupported extension.
