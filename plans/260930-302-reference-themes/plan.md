---
title: Pixel Arcade and Neo Brutalism reference packages
status: in-progress
issue: 302
---

# Reference themes

Outcome: ship installable Pixel Arcade and Neo Brutalism packages that prove the existing closed ThemeDocument contract across real host, built-in/declarative/isolated widgets, detached surfaces and compatible Orb defaults. Clark Default remains byte-identical.

Constraints: canonical generalized manifest, existing installer/compiler/bridge/CLI, no raw CSS/JS or remote resource escape, protected semantics and reduced motion authoritative. English/Vietnamese docs and portable fallback typography. Fonts are not bundled: the accepted issue explicitly allows a font-family profile; Pixel Arcade uses a mono display profile with readable system body fallback, avoiding a new font-asset contract or redistribution uncertainty.

Non-goals: gated publishing/discovery #301/#194, external accounts, new asset or theme schema, replacement visual/installer machinery. Do not claim a Windows screenshot proves macOS/Linux appearance.

Dependencies: M1–M4 #296–#299 landed; M5 #300/PR368 is under final verification and CI, docs web #61 open. D:/wt302 starts on reviewed #300 head 374e100a, with no edits to D:/wt300. Before #302 lands, #300 and its docs must land; reconcile/rebase to actual main and rerun affected verification. Related #201/#200, #192/#129 and #128; no competing reference-theme PR found in live search.

Acceptance: both themes pass CLI conformance and protected/contrast audits without code/style payloads; Clark Default baseline unchanged; both schemes and normal/narrow/reduced-motion journeys show consistent host/built-in/declarative/iframe/detached snapshots and Orb defaults; explicit personal Orb wins; distribution/license/source metadata accurately state system-font profiles and no bundled font. Full verification, required cross-platform CI, source review, paired official docs landing, criterion-by-criterion issue closure.

Phase: [packages, proof and delivery](phase-01-packages-and-proof.md).
