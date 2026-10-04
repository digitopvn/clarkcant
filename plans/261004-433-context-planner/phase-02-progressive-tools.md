# Phase 02: adapter tool baseline and progressive disclosure

## Context

`RealPiAdapter.setActiveTools` filtered the *current* tool list, so a second, wider call could not bring back a tool a
first call removed: narrowing was one-way. #402 A2 asks the adapter to stop assigning `agent.state.tools` directly. The
fake adapter accepted any name, including unregistered ones.

## Requirements

- Real adapter: capture the session's tool names at creation as an immutable baseline; `setActiveTools` activates the
  baseline ∩ requested names through `session.setActiveToolsByName` (which also rebuilds the "Available tools" prompt),
  then re-appends tools added by `registerTool`. Never a name outside the baseline. Worker narrowing unchanged.
- Fake adapter: only registered names can become active; `activeToolNames(sessionId)` test seam.
- Progressive disclosure behind `CLARKCANT_TOOL_DISCLOSURE=progressive` (default `all`): tool families keyed by name,
  EN/VI keyword hints per family, an always-on core, families used last turn stay on, unknown tools always on, no hint
  → optional Jev family choice (`CLARKCANT_CONTEXT_DECIDER=jev`), else everything.
- Telemetry per turn (mode, active count, families, reason) through `onContextTelemetry`, written by the node to stderr
  as one JSON line; `TurnMetrics` unchanged.

## Files

- `packages/pi-adapter/src/real.ts`, `packages/pi-adapter/src/fake.ts`, `packages/pi-adapter/test/pi-adapter.spec.ts`,
  `apps/runtime/src/tool-disclosure.ts` (new), `apps/runtime/src/jev-decider.ts`, `apps/runtime/src/model-turn.ts`,
  `apps/runtime/src/bootstrap/model-bootstrap.ts`, `apps/runtime/test/tool-disclosure.spec.ts` (new).

## Validation

`pnpm exec vitest run packages/pi-adapter apps/runtime/test/tool-disclosure.spec.ts apps/worker`.

## Risk and rollback

Changing the tool set rebuilds the system prompt and invalidates the provider's prefix cache; that is why the flag is
off by default and phase 04 measures it. Rollback: leave the flag unset; the adapter fix is independent and safe.
