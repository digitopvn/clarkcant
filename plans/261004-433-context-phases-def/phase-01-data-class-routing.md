# Phase 01 (D): data classes in context and model routing

## Context

The background router (`model-router.ts`) filters profiles by role, credential, health, tool support, context window
and token ceiling, then lets Jev choose. Nothing filters by what the work contains. The planner's `ContextBlock` has no
`sensitivity` or `estimatedTokens`, so a credential-shaped memory note can reach the foreground model, a routed
background model, or Jev's candidate list. Grants and artifact offers already use `public | internal | confidential |
secret`.

## Requirements

- Contracts: one `dataClassSchema` (reused by grants and artifact offers), an ordered rank, `trustClassSchema`
  (`local | first-party | approved-third-party | untrusted`), optional `allowedDataClasses` and `trustClass` on
  `UserModelProfile`, and `allowedDataClassesFor(profile)`: explicit list ∩ trust-class ceiling; unlabelled profile →
  `public, internal, confidential`.
- Deterministic text classifier `dataClassOfText`: credential shapes (JWT, bearer, prefixed token, named secret) →
  `secret`; personal shapes (email, phone, home path) → `confidential`; otherwise `internal`.
- `ContextBlock` gains `sensitivity` and `estimatedTokens` (chars/4). Planner inputs take the receiving model's allowed
  classes; blocks above are withheld before rerank and layout, counted, and the brief says how many were withheld.
  Jev is offered only `public`/`internal` candidates.
- Bundles: refs carry class and token estimate; `reader(bundle, principal, allowed)` withholds refs above `allowed`.
- Routing: `filterBackgroundCandidates({ dataClass })` rejects profiles that cannot receive it in both role passes;
  `verify` re-checks the data class after Jev. Background runs build the bundle first, route with the maximum class of
  request and refs, then narrow the reader to the chosen (or fallback) model's allowed classes. Task workers route with
  the goal's class and narrow their bundle to the launched model.
- Off: planner off → no context withholding (byte-for-byte), routing filter still applies (profile settings narrow).

## Files

- `packages/contracts/src/data-class.ts` (new), `models.ts`, `grants.ts`, `nodelink.ts`, `index.ts`, tests.
- `apps/runtime/src/context-planner.ts`, `context-bundle.ts`, `model-router.ts`, `model-turn.ts`,
  `task-dispatch.ts`, `worker-model.ts`, `bootstrap/context-wiring.ts`, `bootstrap/model-bootstrap.ts`,
  `bootstrap/runtime-bootstrap.ts`, tests.

## Validation

`pnpm exec vitest run packages/contracts apps/runtime/test/context-planner.spec.ts apps/runtime/test/context-bundle.spec.ts apps/runtime/test/model-router.spec.ts apps/runtime/test/context-wiring.spec.ts`.

## Risk and rollback

Withholding can hide a note the person wanted used; the brief states the count and the note stays readable through
memory tools. Rollback: `CLARKCANT_CONTEXT_PLANNER=off` for context; profile fields are optional.
