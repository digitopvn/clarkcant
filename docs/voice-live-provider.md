# Live-Provider Voice Testing (V17)

This document records the live-provider check for voice (V17), which tests that the real Gemini Live model can route a spoken command correctly when it does not match the deterministic registry.

## Status

**Opt-in test implemented.** The test requires:
- `CC_LIVE_PROVIDER=1` environment variable
- `GEMINI_API_KEY` in environment or node vault
- An active Gemini Live API account

The test is skipped (with a named reason) if these preconditions are not met, so it never blocks CI.

## What is tested

The live-provider voice test (`apps/web/e2e/voice-live.live.spec.ts`) verifies:

1. **Real model routing**: The Gemini Live model processes a spoken utterance that does not match the deterministic app-command registry (e.g., "mở cài đặt" / "open settings").

2. **Control app decision**: The model decides to call `control_app` with the appropriate intent (e.g., `settings.open` or `nav.home`).

3. **Socket delivery**: The `control_app` decision reaches the renderer through the voice socket's existing `{type: "app-intent"}` wire frame (`apps/runtime/src/voice-session.ts`), not a new transport.

4. **Executor parity**: The decision is executed through `runAppIntent`, the same executor a click or a typed command uses, landing on the same screen a header button would reach.

## What is NOT tested here

- **Per-test model interception**: This suite does not replace the model with a scripted one. That is proven by fixture-based tests (`apps/web/e2e/voice-agent-control.spec.ts`), which can inject scripted decisions repeatedly and deterministically.

- **Live session establishment**: The test does not prove that Gemini Live can open a session with audio capture from a real browser. That requires actual audio input, which CI environments and headless test runners cannot provide reliably.

## Infrastructure

### The live utterance endpoint

The route `/voice-live/utterance` (POST) allows tests to inject text that will be processed as if it were transcribed by the live model:

```
POST /voice-live/utterance
Authorization: Bearer {token}
Content-Type: application/json

{ "words": "mở cài đặt" }
```

This endpoint:
- Only exists when `CC_LIVE_PROVIDER=1` (i.e., not when running the voice fixture)
- Returns 404 on a fixture node or a node with no voice configured
- Is safe to have in production because it does not expose any capability that doesn't already exist (the voice session itself handles utterances)

### Why text instead of audio

The test injects text utterances rather than audio because:
1. The test environment (headless, CI) cannot provide reliable audio input
2. The text represents what the real Gemini Live model would transcribe
3. The agent's response path (what to do with the transcript) is what matters for proving `control_app` routing

The audio processing itself is proven by the real voice session (`apps/runtime/src/voice-session.ts`) when it receives a live provider credential.

## Running the tests

Run the live-provider voice tests with:

```bash
# Load the API key and run the tests
GEMINI_API_KEY=sk-... CC_LIVE_PROVIDER=1 pnpm test:live

# Or use the script directly
GEMINI_API_KEY=sk-... CC_LIVE_PROVIDER=1 pnpm exec playwright test --grep @live
```

The tests are skipped (not run) in the default `pnpm test:e2e` and `pnpm verify:full` suites.

## Evidence

When run successfully, the test produces:
- Two passing tests that demonstrate agent routing of spoken commands
- Screenshot evidence in `plans/reports/evidence/` showing the same screen state reached by click and voice

A sample run without the prerequisite credentials produces:

```
1 skipped | CC_LIVE_PROVIDER is not set to 1. Run with: CC_LIVE_PROVIDER=1 pnpm exec playwright test --grep '@live'
```

or

```
1 skipped | GEMINI_API_KEY is not set. This test requires a real Gemini Live API key to be available in the environment or the node's vault.
```

## References

- **V17 in conformance traceability**: `docs/conformance-traceability.md`
- **Fixture-based voice tests**: `apps/web/e2e/voice-agent-control.spec.ts` (fixture model, deterministic)
- **Deterministic registry tests**: `apps/web/e2e/voice-control.spec.ts` (app-command lookup)
- **Voice socket and session**: `apps/runtime/src/voice-session.ts`
- **Live adapter**: `packages/voice-adapters/src/gemini-live.ts`
- **Control app tool**: `apps/runtime/src/node-tools.ts` (`decideControlApp`)
- **Agent routing**: `apps/runtime/src/bootstrap/voice-bootstrap.ts`
