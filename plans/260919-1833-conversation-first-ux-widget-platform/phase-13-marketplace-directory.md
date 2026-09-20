---
title: "Phase 13 — Package Marketplace/directory (~7h)"
status: done
---

# Phase 13 — Package Marketplace/directory (~7h)

### Mục tiêu

Discovery layer over existing package/install primitives, not a second package manager.

### Sources

First-class:
- local path for development;
- git exact ref;
- npm exact version.

Directory stores/indexes metadata and source references; artifact install still resolves exact source/version/digest.

### UI

Conversation search returns `ui.marketplace-results`.
Settings Extensions & Widgets shows:
- installed;
- updates;
- enabled state;
- package facets;
- source/version/risk;
- marketplace search.

### Risk lanes

- UI-only isolated;
- isolated + network;
- tool/service;
- native Pi extension trusted/high-risk.

### Autonomous install

Explicit “install X” can satisfy product-level consent in Autonomous mode, but still:
- resolve exact plan;
- validate digest/deps/isolation;
- audit;
- stage/healthcheck;
- rollback on failure;
- obey hard auth/platform boundary.

Do not skip install-plan integrity just because confirmation UI is skipped.

### Directory publish metadata

As defined in `docs/widget-development.md`: previews, source, license, permissions, compatibility, conformance report.

---
