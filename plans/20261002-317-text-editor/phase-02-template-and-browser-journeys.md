# Phase 02 — pure-ui template, fixture wiring and browser journeys

## Context

- `packages/widget-cli/src/cli.ts` owns `init --template` (`blank|form|dashboard`).
- The scripted model (`apps/runtime/src/test-support/fixture-model.ts`, `CC_MODEL_FIXTURE=1`) places isolated fixture packages listed in `apps/web/e2e/fixtures/directory.json` and answers `agent` presses from the turn's note and data section.
- `compileWidgetAction` in `apps/runtime/src/application/action-bindings.ts` is the real binding compiler.
- Precedents: `apps/web/e2e/widget-artifacts.spec.ts` (bridge recording, host chrome), `apps/web/e2e/inbox-notifications.spec.ts` (simulated desktop preload bridge).

## Requirements

- `init --template pure-ui` copies the reference package's files (not `dist`, `test`) and gives the copy its own id, facet id and display name.
- The fixture model places the editor with an `agent` binding compiled by `compileWidgetAction` (`contextRefs: ["selection", "widget"]`) and passes the binding id in props.
- The fixture answers that binding deterministically from the data section the host read, quoting the excerpt and returning a fenced replacement.
- Browser journeys: web Save As round trip; desktop Replace original round trip with a simulated preload bridge; ask Clark and apply; no host path in bridge traffic; keyboard only; light/dark; 390 px; reduced motion.

## Files to modify/create

- `packages/widget-cli/src/cli.ts`, `packages/widget-cli/test/cli-usage.spec.ts` (or a new `pure-ui-template.spec.ts`)
- `apps/runtime/src/test-support/fixture-model.ts`
- `apps/web/e2e/fixtures/directory.json`
- `apps/web/e2e/text-editor.spec.ts`

## Steps

1. Add the template and its test (init, then conformance passes on the copy).
2. Add the directory entry and the two fixture branches.
3. Write the E2E spec; run it alone with the session ports; rerun a failing test alone before calling it a flake.

## Validation

- `corepack pnpm exec vitest run packages/widget-cli/test/pure-ui-template.spec.ts`
- `CC_E2E_NODE_PORT=9276 CC_E2E_WEB_PORT=4573 CC_E2E_NPM_REGISTRY_PORT=9278 corepack pnpm exec playwright test text-editor`

## Risks and rollback

- The desktop path in a browser uses a simulated preload; the shell's own dialog and atomic write are covered by `apps/desktop/test/file-bridge.spec.ts`. Report it as such.
- Shared files are edited append-only to merge with #318.

## Status

Completed on 2026-10-02.
