# feat(skills): evolve skills through immutable candidates, evals, canary and rollback

Labels: `enhancement` · Parent: #507 (Phase 9)

## Summary

Turn an accepted `ImprovementHypothesis` into an immutable candidate skill revision, evaluate it against the active
revision, canary it, promote it, monitor it, and roll back on regression — reusing package generation, refresh and
rollback boundaries.

## Dependencies

- Phase 8 (hypotheses).
- Package generations and rollback (`packages/contracts/src/install.ts`).
- Phase 3 reach gate: a candidate that widens permissions, network or data reach takes the normal approval path.
- Phase 1 for cross-runtime evaluation (author with one runtime, review with another, replay with a third).

## Scope

- Candidate revision storage; never in-place mutation.
- Eval suite vs control with deterministic evidence aggregation; heterogeneous runtimes where useful to reduce
  overfitting to one runtime.
- Canary, promotion, monitoring, rollback.
- Auto-promotion only later, within explicit user policy and bounded reach.

## Acceptance criteria

- [ ] Every skill change is an immutable revision with its evals and evidence.
- [ ] A regression rolls back to the previous generation.
- [ ] Reach-widening candidates cannot promote without consent.
- [ ] Model consensus is never treated as proof; evidence is.
- [ ] Tests, `pnpm verify`, docs EN/VI.

## Non-goals

- Hot-editing active skills.
- Changes to trusted core (Phase 10).
