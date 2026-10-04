# Phase 02: Node dispatch, transport, tools, voice

## Files

- `packages/core/src/widget-service.ts`: `checkBoundAction` accepts `perform`, and the view path refuses it.
- `packages/core/src/conductor.ts`: the `ModelTurnEvent` variant `widget-perform`.
- `apps/runtime/src/application/action-bindings.ts`:
  - compile a `perform` binding from the definition's declaration;
  - add its availability.
- `apps/runtime/src/application/widget-actions.ts`: `invokePerformAction`, which covers the gate, the input check,
  `decideExecution`, the ledger, the bounded wait and the outcome record.
- `apps/runtime/src/widget-perform-acks.ts`: `expect`, `settle` and `wait`, modelled on `host-control-acks.ts`.
- The app-intents routes and `machine-surfaces.ts`: `POST /app-intents/widget-perform/:performId`, person-only.
- `apps/runtime/src/routes/conversations.ts`: the SSE `widget-perform` frame.
- `apps/runtime/src/bootstrap/voice-bootstrap.ts`: forwards `widget-perform` to the voice socket.
- `apps/runtime/src/perform-widget-action-tool.ts`: the new tool, plus the shared dispatch helper that
  `invoke-capability-tool.ts` now uses.
- `apps/runtime/src/place-widget-tool.ts`: the new real placement tool.
- `apps/runtime/src/node-tools.ts`: registers both tools.

## Validation

Unit tests for:

- an undeclared action;
- a schema mismatch;
- no live surface;
- a frame that is not mounted;
- a timeout recorded as uncertain;
- a policy that asks or denies;
- a click on a `perform` binding being refused;
- `invoke_capability` still pressing the job binding.
