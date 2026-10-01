---
title: Widget appearance snapshot and live adaptation
status: completed
issue: 299
---

# Widget appearance

Outcome: widgets use the existing normalized public AppearanceSnapshot at initial render and after appearance changes, including detached windows, without remounting or changing semantic content.

Constraints: one existing compiler/theme model; read-only snapshot with no raw theme/package/host access; nonce/source-checked and versioned bridge; DOM-independent SDK core and optional DOM adapter; default adaptive and explicitly disclosed fixed appearance; protected host chrome and reduced motion remain authoritative. Existing presentations, props, provenance and fallback text stay immutable. No storage migration.

Non-goals: Theme Lab/CLI (#300), reference theme/font assets (#302), marketplace distribution (#301/#194), provider/external journeys.

Dependencies: #296/PR304, #297/PR305 and #298/PR347 landed. Worktree D:/wt299 fast-forwarded to b9c4985 after #343/PR365 landed. Do not commit the old agent brief or evidence.

Acceptance: initial iframe snapshot; live change with stable frame identity; same detached revision through the host relay; adaptive built-ins and declarative Mini Apps; fixed-mode disclosure; no semantic/model churn; immutable and bounded snapshot with no privilege expansion. Focused tests, key mutation checks, 1280/390 light/dark/reduced-motion E2E, verify/full, reviewed PR with all CI green, bilingual internal and official docs, acceptance closure.

Phase: [bridge, renderers and delivery](phase-01-bridge-renderers-and-delivery.md).

Delivered: core PR #367 b589e906 and official docs PR #60 83a4ff37; successful Deploy 36706936732. All CI on head 0e458532 passed. [Acceptance evidence](../reports/closure-260930-1812-299.md).
