---
name: project-244-peer-delegation
description: Issue #244 second PR (2026-09-29) — counsel given on receiver-side consent model for NodeLink delegation and sender/receiver exactly-once shape
metadata:
  type: project
---

Issue digitopvn/clarkcant#244 (phase 5 of #197) second PR: an automation routes its task to a paired node via a
`delegate` envelope. Kongming advised (2026-09-29) that a receiver must hold its OWN owner's standing allowance
(stored as a Grant row with ownerPrincipalId = receiver's owner, sender = peer, receiver = self) and run the task
inside `intersectGrants(senderGrant, allowance)`; pairing alone is not consent. Also advised bounding the
`delegated` execution intent by allowed effect categories instead of "covers everything".

**Why:** AGENTS.md hard rule "a remote machine surface must never approve its own privileged action"; at the
time, `intentCovers(delegated)` returned true for every category and the receiver stored a sender-written
grant with no local decision. ownerPrincipalId is random per node, so "same owner" cannot be used.

**How to apply:** If later work touches grants/delegation, check whether the allowance model landed
(grep `allowance` in apps/runtime/src and packages/storage). If the user chose per-grant confirmation UI
instead, respect that decision. Real two-host transport stays issue #5.
