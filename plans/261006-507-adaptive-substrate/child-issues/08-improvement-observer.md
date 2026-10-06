# feat(runtime): session insights and improvement observer over observable evidence

Labels: `enhancement` · Parent: #507 (Phase 8)

## Summary

Build a host-owned observer that normalizes execution and session telemetry across Clark and the runtimes in the
fabric, detects recurring weaknesses from observable evidence, and proposes explainable `ImprovementHypothesis`
records only when enough evidence exists.

## Dependencies

- Phase 1 for cross-runtime telemetry (`RuntimeSessionSynopsis`, session history trait); Clark-only evidence may start
  earlier.
- #433 Context Planner for bounded retrieval; existing redaction and data-class boundaries.
- Task/Run evidence, effect ledger, Inbox.

## Scope

- Events: task completed/failed, user correction, capability failure or missing, runtime/model fallback, repeated
  retry, repeated approval, effect unknown, context miss, cost/latency outlier, recurring routing error.
- Bounded, redacted, provenance-bearing history; no hidden chain-of-thought.
- Hypothesis contract (evidence refs, counts, proposed change, confidence) and presentation as a conversation message.

## Acceptance criteria

- [ ] Hypotheses cite the evidence that motivated them (e.g. "5/14 reviews needed a correction for X").
- [ ] One failed run never changes active behaviour on its own.
- [ ] Session data stays bounded and classified; secrets never enter observer storage.
- [ ] Tests, `pnpm verify`, docs EN/VI.

## Non-goals

- Automatic mutation of skills or core.
- Reading model reasoning that is not observable output.
