---
title: "#433 Context planner: query-aware memory and recap, progressive tool disclosure, shared retrieval"
status: in-review
created: 2026-10-04
issues: [433]
related: [402, 195, 210]
---

# Context planner (#433)

Source: issue [#433](https://github.com/digitopvn/clarkcant/issues/433). Pi 1.0 migration epic
[#402](https://github.com/digitopvn/clarkcant/issues/402) constrains phase 02: its A2 item asks the adapter to stop
mutating `agent.state.tools` directly, so the tool-set fix goes through the SDK's public `setActiveToolsByName`.

## Outcome

- A turn gets the memory and history that match what was asked, not only the newest rows, within fixed budgets.
- A fresh session's recap reads the newest messages (the old reader took the first 40 and recapped the oldest end of a
  long thread) and adds the few earlier messages of the same conversation that match the new message.
- Tool disclosure can narrow the tool list per turn by family, behind a flag that stays off by default, and narrowing
  is reversible because the adapter keeps an immutable baseline.
- Read-only background runs and dispatched task workers reuse one retrieval pass through a principal-scoped,
  digest-checked bundle of refs, read on demand through a `read_context` tool.
- A deterministic harness measures tool-schema tokens, prefix-cache reads/writes and wrong-tool rate for "all tools"
  against "progressive", so the default is a measured decision.

## Constraints

- No new store, no graph database, no migration: the planner is a projection over `memory_records`, `history_fts` and
  `messages`.
- Principal and scope filters stay inside SQL, before ranking; cross-principal rows cannot be fetched.
- Jev reranks a bounded top-K only, opt-in (`CLARKCANT_CONTEXT_DECIDER=jev`), never adds or removes a candidate and
  never grants authority. Without Jev the deterministic ranking stands.
- Every list and every text is bounded; omitted counts are stated in the brief.
- Memory is read per turn, so a deleted record is gone on the next turn.
- `CLARKCANT_CONTEXT_PLANNER=off` restores the previous recap and memory brief exactly.
- `CLARKCANT_TOOL_DISCLOSURE` defaults to `all`; `progressive` is opt-in until a live A/B confirms the offline numbers.
- `TurnMetrics` (strict contract) is not changed; planner telemetry goes to a callback the node writes to stderr.

## Non-goals

- Security-aware routing, conditional instructions and dynamic per-turn session rebuild (issue phases D, E and F):
  a separate follow-up PR. This PR addresses #433 without closing it.
- File/diff refs in bundles: only memory and message refs are bundled.
- Semantic (embedding) retrieval inside the planner: lexical BM25 plus overlap only; the semantic leg stays where it is.

## Phases

| Phase | Status | Depends on | Detail |
| --- | --- | --- | --- |
| 01 Query-aware recap and memory | in review | — | [phase-01-query-aware-context.md](phase-01-query-aware-context.md) |
| 02 Adapter tool baseline and progressive disclosure | in review | 01 | [phase-02-progressive-tools.md](phase-02-progressive-tools.md) |
| 03 Shared retrieval for background runs and task workers | in review | 01 | [phase-03-shared-retrieval.md](phase-03-shared-retrieval.md) |
| 04 Cache-economics measurement and docs | in review | 02 | [phase-04-measurement.md](phase-04-measurement.md) |

## Acceptance

- Focused vitest per phase; `pnpm verify`; `pnpm invariants`; relevant Playwright journeys on ports 19101–19104.
- Planner off → previous output byte-for-byte (tested, including at bootstrap wiring).
- Earlier messages reach the model as role-labelled data, never inside the turn guidance (injection test).
- Narrow → widen → narrow returns the full baseline and never anything outside it (tested on real-adapter stub).
- Measurement numbers recorded in the PR body and phase 04; live A/B named as an external gate.
- EN + VI docs for architecture and the new environment variables.
