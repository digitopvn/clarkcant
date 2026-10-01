---
title: Conversation deletion and retention boundaries
date: 2026-09-30
summary: "Implemented #343, verified rollback and policy boundaries, and prepared bilingual official docs."
---

# Conversation deletion and retention boundaries

Conversation deletion uses one person-owned capability and existing execution policy. Migration 39 adds principal/target/expiry-bound permits and durable file cleanup. Both release helpers participate in the deletion transaction, and physical unlinking waits for commit. Independent saved memory, shared bytes, session logs and audit/replication history remain; there is no Undo copy because the requested outcome is retention and quota reclamation.

Mutation checks exposed the intended failures for bypassed policy/person-only guards, pre-commit unlinking and omitted migration. Restored code passed 84 focused tests, five targeted browser journeys and verify:full (4,917 tests plus 315 E2E). The first full check caught stale docs/manifest.json; regenerating the four changed document hashes fixed it without weakening checks.

PR clarkcant#365 awaits remaining CI before merge. Official API and retention docs EN/VI are prepared in clarkcant-web#59, kept draft until implementation lands. Next roadmap work is #299's read-only appearance snapshot through widget and detached-host bridges. AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
