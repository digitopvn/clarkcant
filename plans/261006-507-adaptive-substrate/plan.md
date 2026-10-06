---
title: "#507 adaptive agent substrate"
status: in-progress
created: 2026-10-06
issues: [507]
related: [402, 495, 209, 194, 451, 197, 199, 433, 264, 263, 496, 506]
---

# Adaptive agent substrate (#507)

Source: epic [#507](https://github.com/digitopvn/clarkcant/issues/507). The epic stays the product and architecture
owner; each implementation phase becomes its own child issue, drafted in [child-issues/](child-issues/) for filing.

## Outcome

Clark closes capability gaps by discovering, connecting, orchestrating and replacing the best available capabilities
behind one conversation, with the host keeping authority, durability and evidence. Phase 0 fixes the vocabulary as
typed contracts and target-architecture docs; no user-visible behaviour.

## Constraints

- One Clark, one conversation. No runtime/session/automation dashboard as the default mental model.
- One execution owner per Clark Run; no second scheduler, effect system or task lifecycle. Lifecycle work waits for
  [#402](https://github.com/digitopvn/clarkcant/issues/402).
- Discovery metadata never grants authority; widening reach needs one coherent consent (Jev/policy decides when).
- Contracts carry no runtime, vendor or model names.
- The philosophy text lives in PR [#506](https://github.com/digitopvn/clarkcant/pull/506) (`AGENTS.md`, `DESIGN.md`,
  `REVIEW.md`); this plan does not edit those files.

## Phases

0. [phase-00-contracts-and-docs.md](phase-00-contracts-and-docs.md) — completed (contracts + target-architecture docs).
1. Canonical runtime fabric — [draft](child-issues/01-runtime-fabric.md); blocked by #402.
2. Resource & capability graph — [draft](child-issues/02-capability-graph.md).
3. Capability gap resolver and reach expansion — [draft](child-issues/03-gap-resolver-reach-expansion.md).
4. External discovery providers — [draft](child-issues/04-external-discovery.md); depends on #194.
5. Standing intent v2 — [draft](child-issues/05-standing-intent-v2.md).
6. Signal-source ecosystem — [draft](child-issues/06-signal-sources.md).
7. Delivery router — [draft](child-issues/07-delivery-router.md); depends on #199.
8. Session insights / improvement observer — [draft](child-issues/08-improvement-observer.md).
9. Skill evolution — [draft](child-issues/09-skill-evolution.md).
10. Core self-improvement workflow — [draft](child-issues/10-core-self-improvement.md).

## Dependency order

```text
Phase 0 ─┬─ Phase 2 (local/package/peer inventory) ── Phase 3 ── Phase 4 (+ #194, #451)
         │                       ▲
#402 ── Phase 1 ─────────────────┘ (runtime inventories) ── Phase 8 ── Phase 9
         │                                                     └────── Phase 10
#197 ── Phase 5 ── Phase 6
          └─────── Phase 7 (+ #199)
```

Phases 2 (non-runtime providers), 5 (schedule and envelope storage) and 6 may start before #402 lands, provided they
add no execution lifecycle. #495 dispatches through Phase 1's fabric once it exists.

## Acceptance

The epic's acceptance criteria and definition of done; each child issue carries its own gate.
