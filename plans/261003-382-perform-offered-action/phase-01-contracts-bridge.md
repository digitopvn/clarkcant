# Phase 01: Contracts, bridge, session

## Files

- `packages/contracts/src/widgets.ts`:
  - `offeredActionSchema`;
  - `widgetDefinitionSchema.offeredActions`;
  - proposal kind `perform`.
- `packages/widget-sdk/src/index.ts`:
  - `ACTIONS_PERFORM_EXTENSION`;
  - `action.perform` (host to widget) and `action.performed` (widget to host);
  - `actions.offer()` and `actions.canPerform()` in the author API.
- `packages/widget-sdk/src/runtime.ts`: runs the registered handler and answers. An unknown name, or a handler that
  throws, is a refusal.
- `packages/widget-host/src/session.ts`: `FrameSession.perform()` advertises the extension and has one bounded wait
  per perform id. A frame that is not ready or has been disposed is refused, and an answer nobody asked for is refused.
- Every switch over `proposal.kind` stays exhaustive.

## Validation

- Unit tests for the session's perform: refused before ready, answered, timed out, and an unsolicited answer.
- Unit tests for the runtime: an offered action answers, an unknown one is refused.
- A contracts test for the definition field.
