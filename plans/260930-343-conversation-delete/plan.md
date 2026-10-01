---
title: Delete a conversation and release its files
status: completed
issue: 343
---

# Conversation deletion

Outcome: one person-owned, policy-governed capability deletes a local conversation and its attachments and widget artifacts atomically; text, voice, clicks and REST share it.

Constraints: no machine self-approval; preserve shared bytes; no deletion while work may still write or effects are uncertain. Files are released only after database commit, with durable cleanup retries. Existing migrations stay immutable. English and Vietnamese internal and official docs must describe actual retention.

Non-goals: stop sharing (#355), external-host deletion, npm publication, broad orphan collection.

Decision: immediate deletion, no Undo copy, because retention and disk reclamation are the purpose. Existing policy chooses execute, ask or deny. A scoped, expiring permit follows existing app-intent confirmation when policy asks. Recheck policy and activity at execution.

Acceptance: atomic rollback leaves rows and bytes intact; four restrictive foreign keys handled; finalized unattached files included; shared files survive; machine surfaces refuse; replay, wrong target, expiry and tightened policy refuse; real 1280/390 light/dark, keyboard/reduced-motion E2E; focused tests, verify/full, review, merged implementation and bilingual website documentation.

Phase: [implementation and delivery](phase-01-delete-and-release.md).

Related: #313 file broker, #17 attachments, #354 person-only install policy, #355 outside this change.

Delivered: core PR #365 and web PR #59 merged; all required checks and website deploy passed. #343 and the test-only clock repair #366 closed with acceptance evidence: [closure](../reports/closure-260930-1641-343.md).
