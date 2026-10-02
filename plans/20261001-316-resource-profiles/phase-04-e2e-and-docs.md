# Phase 04 — E2E fixture with a fake provider, then docs

## Context

- Issue: [#316](https://github.com/digitopvn/clarkcant/issues/316) acceptance items for E2E, docs and ledger.
- The service-facet and package-job journeys (`apps/web/e2e/service-facet.spec.ts`, `package-job.spec.ts`) show how a
  package with a real service container is installed and driven.

## Requirements

- A fixture package with a UI facet and a service facet that requests `interactive-heavy` and declares one egress
  origin on loopback with a credential. A fake provider on that origin checks the header and answers deterministically.
- The journey stores a test-generated key for `package:<id>`, shows the granted profile in package details, presses the
  widget, reaches the fake provider through the egress broker, and proves the key is absent from the frame DOM, the
  bridge traffic, the widget state and browser storage, and from the container's environment.
- Docs EN and VI: `docs/widget-development{,.vi}.md` §14, `docs/widgets-and-extensions{,.vi}.md` §9 and §12,
  `docs/open-interfaces{,.vi}.md` for the browser-token route and the `tokens@1` bridge message. Ledger rows V07 and V12
  in `docs/conformance-traceability.md`; refresh the docs manifest.

## Files to modify/create

- `apps/web/e2e/fixtures/egress-service/` (new), `apps/web/e2e/fixtures/directory.json`, `apps/web/e2e/resource-egress.spec.ts` (new).
- The docs above, `docs/manifest.json` through `node tools/check-invariants.mjs --fix-manifest`.

## Steps

1. Fixture package, fake provider, journey.
2. Docs and ledger, manifest refresh.
3. Focused tests, `pnpm verify`, `pnpm verify:full`; a failing E2E is rerun alone to tell a flake from a failure.

## Validation

- `corepack pnpm test:e2e apps/web/e2e/resource-egress.spec.ts`
- `corepack pnpm verify` then `corepack pnpm verify:full`

## Risks and rollback

- The journey needs a Linux container engine; it follows the service-facet journey's assumptions (Linux CI runner).
- Roll back by reverting the fixture and docs.
