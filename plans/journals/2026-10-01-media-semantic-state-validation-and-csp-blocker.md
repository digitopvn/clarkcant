---
title: Media semantic state validation and CSP blocker
date: 2026-10-01
summary: "Validated the #329 media state implementation; local-video browser acceptance remains blocked pending CSP direction in #374."
---

# Media semantic state validation and CSP blocker

## What happened

Implemented the media semantic-state work for #329 in `D:\wt329`: bounded/versioned gallery and playback state, media selection events, host semantic readers, and a shared playback coalescer. Gallery inspection and carousel pin restoration are covered by browser journeys. A real local-video pause journey exposed Chromium rejecting the host-created blob URL under the existing page CSP.

## Decision

Kept the CSP unchanged because issue #329 explicitly requires it. Removed the failing video journey rather than shipping a red test, documented the evidence, and created #374 to resolve the product/security choice. #329 remains incomplete until its required video browser criterion is resolved and verified.

## Validation

`pnpm verify` passed, including 5,004 tests (34 skipped). `pnpm verify:full` passed with 352 browser tests and 3 existing skips. The gallery, carousel pin-restore, and YouTube journeys passed. The plan validator and `git diff --check` passed. No E2E listeners remained on ports 9076, 4373, and 9078.

## Next steps

Keep #329 open pending #374. #322 remains sequenced after #329 in the widget plan, so continue with independent dev-host issue #334, which the same plan marks as safe to do early. Do not include generated browser evidence under `plans/reports/evidence/` in commits.

AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
