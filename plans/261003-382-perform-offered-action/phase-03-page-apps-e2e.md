# Phase 03: Page forwarding, reference apps, fixture, e2e

## Files

- `packages/conversation-client`:
  - a registry of mounted frame sessions;
  - the `widget-perform` stream event, and the same event from voice;
  - `reportWidgetPerform`.
- `examples/reference-apps/spreadsheet/widgets/main/{widget.json,main.js}`: offered action `format`, with input
  `{format, range?}`.
- `examples/reference-apps/text-editor/widgets/main/{widget.json,main.js}`: offered action `replaceSelection`, with
  input `{text}`.
- `apps/runtime/src/test-support/fixture-model.ts`: both widgets are placed through the real placement helper, and
  composer triggers call `perform_widget_action`.
- `apps/web/e2e/*`: one spec per reference app for the composer-typed path.

## Validation

Playwright runs with the ports `CC_E2E_*` 19071-19074.
