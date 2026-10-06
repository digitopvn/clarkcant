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
- `packages/contracts/src/host-path.ts` (new): `absoluteHostPathSchema`, `hostPathWithin` — absolute, normalized
  paths for reach items and segment-wise folder containment.
- `packages/contracts/src/primitives.ts`: `rt_`, `rsess_`, `cand_`, `rxp_`, `dprov_` identifiers. `index.ts`: exports.
- `packages/contracts/test/{runtime-fabric,capability-discovery,reach-expansion,execution-envelope,host-path}.spec.ts`
  (new).
- `docs/adaptive-substrate.md` + `.vi.md` (new), pointers in `docs/README(.vi).md` and
  `docs/system-architecture(.vi).md` §1, `docs/manifest.json`.

## Steps

- [x] Contracts with pure validation helpers; versioned; no runtime behaviour; no runtime/vendor/model names.
- [x] Unit tests for the happy path and the refusals that carry the invariants.
- [x] Target-architecture doc EN/VI, marked not shipped, mapped onto the current diagram without redrawing it.
- [x] Child-issue drafts for Phases 1–10 under `child-issues/`.

## Validation

`corepack pnpm exec vitest run packages/contracts/test/runtime-fabric.spec.ts packages/contracts/test/capability-discovery.spec.ts packages/contracts/test/reach-expansion.spec.ts packages/contracts/test/execution-envelope.spec.ts packages/contracts/test/host-path.spec.ts`,
then `corepack pnpm verify`; `ak plan validate plans/261006-507-adaptive-substrate`.

## Risk / rollback

Additive: nothing imports the new contracts yet. Reverting the commit removes them and the docs.

## Remaining work

- The philosophy text is PR #506; items it does not yet carry are listed in a comment on PR #506.
- Resolving tags, branches and version ranges to the exact forms `AcquisitionSource` accepts belongs to the discovery
  providers (Phase 4); spending a `once` consent and storing consents belong to the reach-expansion resolver (Phase 3).
- `ExecutionEnvelope` folders reuse task resources, which name no node; binding them to a node belongs to #209.
- `system-architecture.png` names "Pi Session"; rename it to a runtime-neutral label when Phase 1 ships.
