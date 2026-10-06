# feat(runtime): core self-improvement through branch, PR, CI and release

Labels: `enhancement` · Parent: #507 (Phase 10)

## Summary

Let an approved `ImprovementHypothesis` about ClarkCant itself become ordinary repository work: branch/worktree,
implementation, tests/evals, optional independent review, PR, CI, merge, and the normal release/update path. Trusted
core is never hot-modified.

## Dependencies

- Phase 8 (hypotheses) and Phase 1 (runtime fabric to run the work).
- #495 (cross-project side work) for running it without taking over the foreground conversation.
- Repository governance: `AGENTS.md`, `REVIEW.md`, required checks, review attestation.

## Scope

- Hypothesis → task with explicit repository resource and envelope.
- Work runs in an isolated worktree through the canonical backend.
- Result reported as a PR with evidence; merge and release follow normal policy and human review where required.

## Acceptance criteria

- [ ] No path changes running trusted core outside the release/update path.
- [ ] Security policy and authority boundaries change only through reviewed PRs.
- [ ] The PR carries the hypothesis evidence, tests and verification results.
- [ ] Tests, `pnpm verify`, docs EN/VI.

## Non-goals

- Self-approval or self-merge of core changes.
- Hot-patching.
