# Goal packet (from ak:goal-warmup) — 2026-09-29

## Outcome contract (LOCKED)

- **Intended result:** every open, non-externally-gated issue in `digitopvn/clarkcant` is implemented, merged to
  `main`, and closed with evidence. Each gated issue stays open with a comment naming exactly which prerequisite
  is missing.
- **In scope, in priority order (security first):**
  1. **Tier 0:**
     - Unblock the Windows required check (rebase PR #207, or edit the ruleset).
     - Land #205, and land #206/#207 (merge them, or close the duplicate).
     - Merge the #188 report.
     - Close #190.
     - Verify and close #93, #169, #171, #173 and #174, then #129.
  2. **Tier 1:**
     - The rest of #137.
     - A new issue for the P0 "Stop a running turn", then fix it.
  3. **Tier 2:** #198 core, #195, #197 phases 1–2, and #210 A–D together with #196 phases 1–2.
  4. **Tier 3:** #196 phases 3–5, #170, #172 and #192.
  5. **Tier 4:** #198 P1/P2 with #200, #197 phases 3–5, and #201.
  6. Official docs on `digitopvn/clarkcant-web` (EN and VI) for every user-visible change.
- **Out of scope:** #2, #3, #4, #5, #193, #194, #199, #209, and any live journey that needs outside accounts,
  hardware or hosts.
- **Acceptance signals:** every closed issue has:
  - a merged PR;
  - green CI, including `verify (windows-latest, node 24)`;
  - `pnpm verify` passing, plus `pnpm verify:full` and the relevant E2E for UI journeys;
  - a closing comment that checks each acceptance criterion;
  - a merged docs PR, or an `ai-handle` fallback issue.
- **Constraints:**
  - Follow AGENTS.md: product philosophy, pnpm only, no enums or namespaces, immutable migrations, Pi SDK only
    imported in `packages/pi-adapter`.
  - Conventional commits with no AI attribution.
  - Never weaken tests.
  - PR bodies carry no closing keywords; issues are closed manually with evidence.
  - Stop and ask on any conflict with the product philosophy.
- **Allowed substitutions:**
  1. For a partially gated issue, split the gated remainder into a `blocked,external-gate` sub-issue, then close
     the parent once its in-repo acceptance is met. This applies to:
     - #129: the real-audio voice half;
     - #170: cross-host proof;
     - #197: the live journey;
     - #210: phase E;
     - #172: the OAuth-expired and pairing producers;
     - #201: M6 marketplace;
     - #200: the live image-generation app;
     - #171: the GUI Electron click, if Playwright Electron cannot cover it.
  2. #206 and #207 may be combined, or the duplicate PR closed.
- **Decisions already made:**
  - #192: the agent picks 4–6 presets and keeps the global `orb.profile` preference.
  - #188: merge the report. Its P0 goes to phase 03. Other findings are recorded, not added to scope.
- **Agent authority:** merge a PR when CI is green, close finished issues, edit the `main` ruleset, create issues
  and sub-issues.
- **Decision owner:** user.

## Plan

- Path: `plans/260929-0002-open-issues-roadmap/plan.md` (13 phases; `ak plan validate` OK).
- Scout: `plans/reports/scout-260929-0002-open-issues.md`.
- Contract traceability: present in `plan.md`.

## Preflight

- **Blocking:** none.
- **Known:**
  - Local `pnpm invariants` fails 2 checks on Windows (#190). Phase 01 fixes this.
  - Whether HTTP pairing is enough for #170 is still unknown. If it is not enough, do not stop: open a separate
    issue stating the reason, the proposed resolution and what is needed from the user, then continue
    (user decision 2026-09-29).
- **Deferred:** nothing beyond the gated sub-issues that the substitutions allow.

## Scope guard (MUST follow during long-run)

At each phase boundary:

1. Diff the proposed deliverables against the locked contract.
2. On a material mismatch, pause for the user. Do not finish under a reduced scope.
3. Do not weaken, skip or delete tests to satisfy the stop condition.
4. Pause for a human decision instead of inventing product choices, such as a new product-philosophy conflict or
   an unlisted gated remainder.

## Codex opener

```text
/goal Implement, merge and close every open non-externally-gated issue in digitopvn/clarkcant, in the priority order of the plan.
Read first: plans/260929-0002-open-issues-roadmap/plan.md and goal-packet.md (LOCKED contract).
Constraints: AGENTS.md invariants; out of scope #2 #3 #4 #5 #193 #194 #199 #209; gated remainders only via the listed substitutions.
Validate after each checkpoint: pnpm verify (pnpm verify:full for UI journeys), green required CI incl. Windows, per-criterion closing comment, clarkcant-web docs PR.
Keep a brief progress log in plans/260929-0002-open-issues-roadmap/.
Stop when only gated issues remain open, each with a prerequisite comment, or when further work needs human input.
Follow the scope guard.
```

## Claude long-run opener

```text
Implement, merge and close every open non-externally-gated issue in digitopvn/clarkcant, following the phase order of plans/260929-0002-open-issues-roadmap/plan.md.
Read first: that plan.md and goal-packet.md. Honor the LOCKED outcome contract.
Validate: pnpm verify (plus verify:full and E2E for UI), green required CI including Windows, per-criterion closing comments, and merged clarkcant-web docs.
At each phase boundary apply the scope guard. Stop when done or when a human decision is required. Do not auto-expand scope.
```
