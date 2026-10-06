# feat(runtime): resolve capability gaps and ask once before reach expands

Labels: `enhancement` · Parent: #507 (Phase 3)

## Summary

Treat a missing capability as a resolvable gap: search least-reach first, compile any required widening into one
`ReachExpansionPlan` (`packages/contracts/src/reach-expansion.ts`), ask once through the host-owned approval surface,
acquire/connect/enable through the existing canonical paths, verify, and resume the original task automatically.

## Dependencies

- Phase 2 (capability graph).
- Jev/policy owns whether a question is needed; the existing Interaction Manager / approval surface renders it.
- Uses existing task parking (`waitingCapabilityRef`, `waitingInstallPlanId`) for resume; if resumption needs run
  lifecycle beyond that, integrate with #402's backend rather than adding one.
- Install/connection paths: existing package install (`InstallPlan` consent), service connections.

## Scope

- Gap triggers: capability missing, approach failed, low confidence, runtime unavailable/quota-constrained, result
  insufficient, user asks, recurring gap (from Phase 8).
- Least-reach ladder and preference order (already available, no new credential, no install, smaller reach, stronger
  provenance, compatibility, cost, latency). The ranking strategy is replaceable.
- One coherent consent surface (host-owned mini app) showing goal, recommendation, alternatives, actions, filesystem
  scope, network origins, data recipients, credentials by name, trust lane, and `once | task | standing` choices.
- Consent binding via `ReachConsent` / `consentDoesNotCover`; standing preferences remembered through Jev/policy memory.
- Verify the acquired capability (readiness) before resuming; report failures truthfully.

## Acceptance criteria

- [ ] Clark acts inside existing grants without extra confirmation.
- [ ] Several technical widenings are presented as one plan, not one prompt per step.
- [ ] Consent applies only to the consented reach; a request that reaches further asks again.
- [ ] Acquisition succeeds or fails truthfully; the task resumes only after verification, without the user restating it.
- [ ] A model, widget or remote surface cannot approve its own plan.
- [ ] Browser E2E for the journey (pointer, keyboard, voice parity where supported), `pnpm verify:full`; docs EN/VI.

## Non-goals

- Internet discovery providers (Phase 4).
- Ad-hoc confirmations outside Jev/policy.
- Auto-acquiring trusted-native code without consent.
