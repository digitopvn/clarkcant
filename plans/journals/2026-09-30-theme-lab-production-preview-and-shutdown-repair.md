---
title: Theme Lab production preview and shutdown repair
date: 2026-09-30
summary: Final local verification passed; exact-head CI and paired documentation delivery remain pending.
---

# Theme Lab production preview and shutdown repair

Theme Lab and its CLI share the canonical package manifest, appearance compiler, protected audits and production components. Final local verify:full on 53b6c443 passed 4,954 unit tests and 328 browser journeys; 34 conditional unit skips and three externally gated browser cases remain explicit.

Real visual review while preparing #302 caught two defects that token-only checks missed: the author runtime had not installed the component stylesheet, and new controls used undefined class names. Separate red/green browser regressions now prove actual canvas styles, button/field recipes and dimensions. The prior stylesheet full run was stopped before completion and was never counted as passing. The final code was re-reviewed; exact-head CI and official docs landing remain required before closure.

The full suite also exposed #369: deferred dispatch accessed SQLite after shutdown. A focused lifecycle guard and deterministic real-SQLite tests preserve existing boot recovery without writing into closed storage. The repair remains a separate commit in PR368.

Reference themes use existing closed font-family profiles with no bundled font files or new styling/resource contract. AgentWiki publish skipped; this is a local execution record, not shipped product authority.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
