# Phase 04: cache-economics measurement and docs

## Context

The issue requires a measurement before dynamic context or tool selection becomes a default. A tool-set change
rebuilds the system prompt, which is the cached prefix; fewer schema tokens can still cost more if every change
writes a new cache entry.

## Requirements

- Deterministic harness (`apps/runtime/test/context-economics.spec.ts` with corpus `context-economics-corpus.ts`):
  labelled multi-turn conversations, the real tool catalogue's names and representative schema sizes, the real
  disclosure planner.
- Measures per mode (`all`, `progressive`): schema tokens per turn, simulated prefix-cache read and write tokens
  (write on any prefix change, read otherwise), cost at representative prices, wrong-tool rate (a needed tool not
  active), and recap relevance (the labelled earlier decision present in the recap).
- Prints a table; asserts only invariants (wrong-tool rate in `all` is 0, progressive never activates outside the
  registered set), never a number chosen to pass.
- Live A/B (latency, real cache, task success) is an external gate: needs provider credentials and is not run here.
- Docs EN + VI: `docs/system-architecture*.md` §7.2/§7.3, `docs/mini-app/jev-configuration*.md` env table; manifest.

## Validation

`pnpm exec vitest run apps/runtime/test/context-economics.spec.ts`; `node tools/check-invariants.mjs --fix-manifest`;
`pnpm verify`.

## Result (2026-10-04, offline estimate)

38 labelled turns, 30 runtime tools (~8,805 schema tokens), assumptions printed by the spec:

| Mode | Schema tok/turn | Cache write | Cache read | Tool-set changes | Cost vs all | Wrong-tool turns |
|---|---|---|---|---|---|---|
| all | 8,805 | 102,747 | 346,052 | 0 | 0% | 0/38 |
| progressive | 5,530 | 125,530 | 198,836 | 7 | +8.4% | 1/38 |
| per-turn | 5,520 | 252,842 | 71,138 | 23 | +98.2% | 2/38 |

Recap carrying the labelled earlier decision: first-40 1/3, latest-12 1/3, planned 3/3. The harness found that the
planner excluded all 40 read messages from the earlier-message search although the recap repeats only 12; the
exclusion now uses `recapWindow`. Decision: `CLARKCANT_TOOL_DISCLOSURE` stays `all` by default.

## Risk and rollback

Simulated numbers can mislead; they are labelled as offline estimates and the default stays off.
