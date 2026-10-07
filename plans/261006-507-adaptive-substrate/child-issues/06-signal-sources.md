# feat(packages): signal-source facet for extensible event ingress

Labels: `enhancement` · Parent: #507 (Phase 6)

## Summary

Let packages contribute event sources through a `signal-source` facet whose job ends at receive/poll/stream → verify →
normalize to a Clark `Signal`. The #197 core keeps durable receipt, dedupe, matching, intent runs, retries/dead-letter,
Task creation, provenance and recovery.

## Dependencies

- #197 (done) signal contract and core.
- Package manifest/facet model (`packages/contracts/src/install.ts`), trust lanes and declared reach.
- Phase 5 is useful but not required.
- Coordinates with #199, whose channel ingress shares the same delivery intake.

## Scope

- Facet declaration: ingress mode (webhook, poll, long-poll, stream, gateway, relay, local watcher), declared reach,
  verification requirements.
- Host-owned intake that runs the facet inside its trust lane and accepts only normalized Signals.
- Prove at least one new non-GitHub source end to end through the generic path.
- Preserve self-feedback suppression (`selfGenerated`) and provenance.

## Acceptance criteria

- [ ] A signal source cannot create tasks, schedule work or own a worker pool; it only yields Signals.
- [ ] Duplicate deliveries are recorded once; restarts do not lose or duplicate signals.
- [ ] The new source works on Windows, macOS and Linux or declares its degraded platforms.
- [ ] Tests, `pnpm verify`, widget/extension docs EN/VI updated.

## Non-goals

- Provider payloads in core contracts.
- One automation engine per provider.
