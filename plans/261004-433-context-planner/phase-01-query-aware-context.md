# Phase 01: query-aware recap and memory

## Context

`memoryBrief` sends the 12 newest memory rows whatever the turn asks. `recapFor` sends the last 12 messages of what the
history reader returned, and the node's reader called `messagesSince(db, conversationId, 0, 40)`, which is the *first*
40 messages; in a thread longer than 40 the recap described the beginning, not where the person is.

## Requirements

- New `apps/runtime/src/context-planner.ts`: `ContextBlock`, `ContextVisibility` (`hide | short | full`),
  `ContextPlan`, query term extraction (EN/VI, diacritic-insensitive), `planMemoryBrief`, `planRecap`.
- Memory: candidates are the principal's eligible rows (node scope or this conversation) read by SQL with a cap of 200;
  rows matching the query go first at full length, short if the budget is tight; the rest follow newest first exactly
  as before. No match → the previous brief byte-for-byte.
- Recap: newest 12 messages; the last two are pinned full; older lines that do not match a query that matched
  something are shortened. Up to 4 earlier messages of the same conversation that match the query (BM25 in
  `history_fts`, principal and conversation in SQL) are added under their own heading, with the count omitted.
- Optional Jev rerank (`decideContextFocus`): only when two or more candidates are within `RANK_GAP_RATIO`, top-K ≤ 8,
  redacted snippets, decisive answers only, moves the chosen candidate first and nothing else.
- Kill switch `CLARKCANT_CONTEXT_PLANNER=off`.

## Files

- `apps/runtime/src/context-planner.ts` (new), `apps/runtime/src/jev-decider.ts`, `apps/runtime/src/model-turn.ts`,
  `apps/runtime/src/bootstrap/model-bootstrap.ts`, `apps/runtime/test/context-planner.spec.ts` (new).

## Steps

1. Pure planner functions and env parsing.
2. Model turn passes the turn's text as the query to the memory brief and to a recap planner hook.
3. Bootstrap: reader uses `latestMessages`, carries message ids; planner wired unless off.
4. Tests: ordering, budgets, no-match identity, deleted memory gone next turn, cross-principal invisibility, Jev
   rerank only reorders, off switch.

## Validation

`pnpm exec vitest run apps/runtime/test/context-planner.spec.ts apps/runtime/test/session-recap.spec.ts
apps/runtime/test/memory.spec.ts`.

## Risk and rollback

Risk: a relevant-first order could hide a newer record behind an older matching one; bounded by the omitted count and
`search_history`. Rollback: `CLARKCANT_CONTEXT_PLANNER=off`, or revert the commit (no data changes).
