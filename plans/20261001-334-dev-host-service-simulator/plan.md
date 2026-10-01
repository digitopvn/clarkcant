---
title: "#334: dev-host service readiness and offline simulation"
status: in-review
created: 2026-10-01
issues: [334]
related: [200, 221, 335]
---

# Dev-host service readiness and offline simulation

## Outcome

`clark widget dev` can exercise the existing widget bridge's action-availability and action-result messages against package-declared fixture responses, without launching a service or contacting a provider. Authors can inspect loading, ready, blocked, unhealthy/degraded and offline states and recover through a simulated restart.

## Constraints and non-goals

- Reuse the product's shared capability-readiness vocabulary and widget bridge messages.
- Keep package-frame isolation and denied-by-default capabilities; simulator fixtures grant no real capability.
- Do not launch service containers, access credentials, or make network requests to providers.
- Keep the change sequential with #335 because both use `dev-host.ts` and `dev-shell.ts`.

## Phases

1. [Service simulator and conformance](phase-01-service-simulator.md) — parse bounded package fixtures, expose per-capability readiness controls, and send/validate bridge availability and result messages.
2. [Browser evidence and docs](phase-02-browser-and-docs.md) — exercise the notes-service fixture through the actual CLI dev host, add blocked/offline conformance facts, update bilingual docs and the conformance ledger, and run the required gates.

## Acceptance

Meet every criterion in [issue #334](https://github.com/digitopvn/clarkcant/issues/334), including loading/blocked/degraded/offline/restart recovery E2E, malformed-response refusal, rendered-state conformance checks, accessibility, `pnpm verify`, `pnpm verify:full`, `pnpm invariants`, and Windows CI. After merge, update official bilingual docs or create its required `ai-handle` fallback issue.

## Dependencies

Reuse #221 readiness and existing action bridge protocol. #335 is independent but shares the dev-host files, so do not overlap changes.
