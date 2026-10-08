---
title: "#714 miniapp state audit and shared status contract"
status: in-review
created: 2026-10-08
issues: [714]
related: [713, 711, 715, 709, 580]
---

# Miniapp states (#714)

Source: [#714](https://github.com/digitopvn/clarkcant/issues/714). Branch `feat/714-miniapp-states`.

## Outcome

Every built-in miniapp reads its own state machine through one shared status contract, so a state looks, sounds and
retries the same way on every card; failures are never drawn as successes and missing data is never drawn as zero.

## Constraints

- Map existing domain machines; do not replace them.
- Keep static snapshots (host cards) distinct from live views.
- Do not edit `command-card.tsx` or `use-block-actions.ts` (owned by #711/#715) or
  `credentials-manager-section.tsx` (#709/#580). Their changes are listed as follow-ups in the audit.
- #713 (`/usage`) builds on this contract: unknown, unavailable and unsupported values, stale values with an as-of
  time, and a reported value with its source.

## Non-goals

- No new wire field on existing blocks; the contract is read-side vocabulary.
- No export through the widget SDK yet (all workspace packages are private).

## Phases

1. [phase-01-audit-and-contract.md](phase-01-audit-and-contract.md) — merged in #730: audit matrix, contract, card
   changes, tests, docs.
2. [phase-02-command-cards-and-terminal.md](phase-02-command-cards-and-terminal.md) — in review: command cards,
   sign-in panel, credential card and terminal adopt the contract; `/logout` refusal text.

## Acceptance criteria

- Audit matrix with file:line evidence and gaps (phase 01).
- `packages/contracts/src/surface-status.ts` with phases, tones, marks, freshness, next action, retry, late-answer
  settling, announcement policy and reported values; domain tables typed against their schemas.
- Host cards with gaps apply it; regression tests fail on `main` and pass on the branch, including reload, late
  answers, EN and VI, mobile and reduced motion.
- DESIGN.md §8.3 and docs/widget-development.md §7 updated in EN and VI.
