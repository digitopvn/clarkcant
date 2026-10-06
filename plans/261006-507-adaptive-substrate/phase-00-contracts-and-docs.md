---
phase: 0
title: contracts and target-architecture docs
status: completed
---

# Phase 00 — contracts and target-architecture docs

## Files

- `packages/contracts/src/runtime-fabric.ts` (new): `RuntimeDescriptor`, `RuntimeFeatures`, `RuntimeStatus`,
  `AgentRuntimeAdapter`, `SessionAuthority`, `maySessionAct`, `RuntimeSessionSynopsis`.
- `packages/contracts/src/capability-discovery.ts` (new): `CapabilityCandidate`, `AcquisitionSource`,
  `DiscoveryBudget`, `CapabilityQuery`, `CapabilityProvider`.
- `packages/contracts/src/reach-expansion.ts` (new): `AcquisitionPlan`, `ReachExpansionPlan`, `ReachConsent`,
  `reachConsentFor`, `reachWidening`, `consentDoesNotCover`.
- `packages/contracts/src/execution-envelope.ts` (new): `ExecutionEnvelope`, `DeliveryTarget`, `envelopeWidening`.
- `packages/contracts/src/primitives.ts`: `rt_`, `rsess_`, `cand_`, `rxp_` identifiers. `index.ts`: exports.
- `packages/contracts/test/{runtime-fabric,capability-discovery,reach-expansion,execution-envelope}.spec.ts` (new).
- `docs/adaptive-substrate.md` + `.vi.md` (new), pointers in `docs/README(.vi).md` and
  `docs/system-architecture(.vi).md` §1, `docs/manifest.json`.

## Steps

- [x] Contracts with pure validation helpers; versioned; no runtime behaviour; no runtime/vendor/model names.
- [x] Unit tests for the happy path and the refusals that carry the invariants.
- [x] Target-architecture doc EN/VI, marked not shipped, mapped onto the current diagram without redrawing it.
- [x] Child-issue drafts for Phases 1–10 under `child-issues/`.

## Validation

`corepack pnpm exec vitest run packages/contracts/test/runtime-fabric.spec.ts packages/contracts/test/capability-discovery.spec.ts packages/contracts/test/reach-expansion.spec.ts packages/contracts/test/execution-envelope.spec.ts`,
then `corepack pnpm verify`; `ak plan validate plans/261006-507-adaptive-substrate`.

## Risk / rollback

Additive: nothing imports the new contracts yet. Reverting the commit removes them and the docs.

## Remaining work

- The philosophy text is PR #506; items it does not yet carry are listed in the PR body of this phase.
- `system-architecture.png` names "Pi Session"; rename it to a runtime-neutral label when Phase 1 ships.
