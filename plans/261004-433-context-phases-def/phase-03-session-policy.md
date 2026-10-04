# Phase 03 (F): session telemetry and reuse/rebuild policy

## Context

A conversation's session is reused until it fails, is evicted, or the model changes. #447 measured that per-turn
rebuilding costs about +92% (in-sample) because every rebuild writes a new cached prefix. The open question is whether
a rebuild at a well-chosen boundary — a cold cache, a large context, a change of subject — is cheaper than reuse.

## Requirements

- Telemetry per turn (`CLARKCANT_SESSION_POLICY=observe` or `rebuild`): session age, idle time, turns, context tokens
  and window, cache read/write tokens, turn cost, latency, topic shift (term overlap with the session's recent
  messages) and context lines changed. One stderr JSON line, counts only, never text.
- `decideSessionReuse`: deterministic thresholds — never on a session's first turn or while a turn runs; rebuild when
  the cache is cold (idle ≥ TTL), the context is large and the subject changed; Jev (`CLARKCANT_CONTEXT_DECIDER=jev`)
  only in the ambiguous shift band; otherwise reuse.
- Rebuild at turn start only: create a fresh session through the adapter, mark it fresh so the planned recap (and
  pinned instructions) brief it, swap, dispose the old one. The transcript is untouched.
- Offline harness: always-reuse vs policy vs per-turn rebuild on labelled sessions with idle gaps, priced with the
  #447 cache model; assumptions printed; only invariants asserted.
- Default `off`: no telemetry line, no rebuild — today's behaviour.

## Files

- `apps/runtime/src/session-policy.ts` (new) + spec; `jev-decider.ts`; `model-turn.ts`;
  `apps/runtime/test/session-economics.spec.ts` (new).

## Validation

`pnpm exec vitest run apps/runtime/test/session-policy.spec.ts apps/runtime/test/session-economics.spec.ts`.

## Risk and rollback

A wrong rebuild costs a cache write and some continuity; the recap mitigates it. Live latency, real cache hits and task
success need provider credentials (external gate). Rollback: leave `CLARKCANT_SESSION_POLICY` unset.
