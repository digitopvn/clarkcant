---
title: "#433 Context planner phases D, E, F: data-class routing, conditional instructions, session reuse policy"
status: in-review
created: 2026-10-04
issues: [433]
related: [402, 447]
---

# Context planner, phases D–F (#433)

Source: issue [#433](https://github.com/digitopvn/clarkcant/issues/433) phases D, E and F. Phases A–C landed in
PR #447 (`plans/261004-433-context-planner/`), which added the planner, progressive tool disclosure, shared bundles
and the offline cache-economics harness this plan reuses. Pi 1.0 migration [#402](https://github.com/digitopvn/clarkcant/issues/402)
constrains phase 03: a rebuild must go through the adapter's public session API, never Pi internals.

## Outcome

- **D.** Every context block carries a deterministic data class (`public` / `internal` / `confidential` / `secret`,
  the vocabulary grants already use) and a token estimate. Blocks above what a model may receive are withheld before
  Jev sees a candidate and before any provider prompt, and background routing hard-filters model profiles by the
  data class of the work before Jev chooses; the chosen model is verified again before dispatch.
- **E.** Projects can declare instructions that switch on by state (project, path glob, operation, capability, role,
  referenced skill). Pinned instructions are re-stated every turn while their condition holds, so recap or compaction
  cannot drop them; unpinned ones are stated once per session. They complement `/skill` references.
- **F.** Per-turn session telemetry (age, idle time, context and cache tokens, cost, latency, topic shift, context
  lines changed) and a deterministic reuse/rebuild policy, Jev only in its ambiguous band, off by default and measured
  offline before it can be turned on.

## Constraints

- Data-class filtering is deterministic, runs before Jev and before any provider, and only narrows. Jev grants
  nothing: it chooses among already-eligible models and already-permitted candidates.
- Retrieved text and project instructions stay framed with their source; instructions grant no tool or authority.
- Every list, file read, text and budget is bounded.
- `CLARKCANT_CONTEXT_PLANNER=off` keeps the previous recap/memory behaviour byte for byte (no data-class withholding
  in context); routing still honours a profile's own data-class settings, which only narrow.
- `CLARKCANT_CONDITIONAL_INSTRUCTIONS=off` and `CLARKCANT_SESSION_POLICY=off` (default for F) restore today's
  behaviour exactly.
- A rebuild happens only at a turn boundary, never under a running turn; the transcript lives in the database and the
  new session is briefed with the planned recap, so no conversation state is lost.
- No migration: data classes are derived, model-profile fields are optional JSON fields of the stored pool.
- Only `packages/pi-adapter` imports the Pi SDK; no enums, namespaces or parameter properties.

## Non-goals

- A UI for model-profile data classes (settable through the existing model-pool API; a panel is follow-up work).
- A per-record sensitivity column or person-assigned labels; classes are derived from text shapes.
- Turning the rebuild policy on by default: that needs a live A/B with provider credentials (external gate).

## Phases

| Phase | Status | Depends on | Detail |
| --- | --- | --- | --- |
| 01 (D) Data classes in context and routing | done | #447 | [phase-01-data-class-routing.md](phase-01-data-class-routing.md) |
| 02 (E) Conditional instructions | done | 01 | [phase-02-conditional-instructions.md](phase-02-conditional-instructions.md) |
| 03 (F) Session telemetry and reuse/rebuild policy | done (off by default; live A/B gated) | 01, 02 | [phase-03-session-policy.md](phase-03-session-policy.md) |

Order: D first, because E's instructions and F's rebuilt recap are both context that must pass the same data-class
ceiling; E before F, because a rebuilt session must re-state pinned instructions.

## Acceptance

- Focused vitest per phase; `pnpm verify`; `pnpm invariants`.
- D: a secret-shaped memory never reaches a default-ceiling model or Jev; routing never widens the eligible set; the
  chosen model's ceiling is re-checked before a worker reads a bundle; fallback still starts the work.
- E: a pinned instruction is present on every turn while its condition holds and gone when it does not; unpinned once
  per session; off restores today's prompt.
- F: off is today's behaviour; a rebuild never happens while a turn runs and the next prompt carries the planned recap;
  the offline harness prints reuse vs policy vs per-turn costs with labelled assumptions.
- EN + VI docs for architecture, environment variables and model-profile fields; conformance ledger if a claim changes.
