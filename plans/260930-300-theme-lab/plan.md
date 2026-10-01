---
title: Theme Lab, customization and package author CLI
status: in-progress
issue: 300
---

# Theme Lab

Outcome: a person can browse installed themes and preview real production components without losing the conversation; an author can initialize, develop, test and pack a data-only theme through the existing clark package CLI.

Constraints: conversation remains primary; use current ThemeDocument/AppearanceSnapshot/compiler/audits, manifest and immutable package artifact path. EN/VI product copy and docs. No executable themes, raw CSS, remote styling resources or privilege expansion. Preview examples must be explicitly labelled, and must never execute real approvals or model turns. Customize controls must affect actual appearance, with reduced motion and protected semantics authoritative.

Non-goals: gated marketplace publishing #301/#194, reference themes/font distribution #302, provider or external journeys. No replacement package lifecycle or theme schema.

Dependencies: #296/PR304, #297/PR305, #298/PR347 and #299/PR367 landed; #299 docs PR60 deployed and issue closed. D:/wt300 branch codex/300-theme-lab now starts on actual main b589e906; the committed base was proven byte-identical to 0e458532 before moving the branch with soft reset, preserving all uncommitted #300 edits. Related #201/#200/#128; no conflicting open implementation PR found.

Acceptance: all #300 scope and four issue criteria, including init/dev/test/pack; production conversation/composer/control/card/widget/Settings/modal/approval/error/status/Orb preview; normal/narrow/compact, both schemes and reduced motion; token/recipe inspector; arbitrary third-party contrast/protected/reduced/typography/assets/manifest/no-executable conformance; Settings theme, Browse, color scheme and actual accent/density/motion/Orb customization with reset. Focus restoration and conversation draft/history preservation. Focused tests and browser journeys, verify:full, review, all CI, bilingual official docs landing and acceptance closure.

Phase: [authoring, utility surface and delivery](phase-01-authoring-utility-and-delivery.md).
