---
title: "Phase 9 — Conversation-first / JIT onboarding (~6h)"
status: done
---

# Phase 9 — Conversation-first / JIT onboarding (~6h)

### Mục tiêu

Fresh user sees Orb + one CTA, then conversation. Provider/model/key asked only when needed.

### Replace

Delete web state machine provider/model/key from `App.tsx`.

First run:
1. Welcome + Orb.
2. Get Started.
3. Conversation.

### JIT setup

Use:
- readiness;
- `packages/core/src/onboarding.ts` checkpoints;
- host-owned setup/question/credential cards.

Examples:
- first real model task → model/provider setup;
- first voice → mic/credential/voice setup;
- first browser task → browser profile/OS setup.

### Tests

- no credentials required to reach conversation;
- preconfigured node asks nothing;
- missing model task creates actionable setup, not dead end;
- resume after reload.

---
