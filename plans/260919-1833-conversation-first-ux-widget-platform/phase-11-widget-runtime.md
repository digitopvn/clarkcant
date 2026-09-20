---
title: "Phase 11 — Isolated Widget SDK runtime & host (~10h)"
status: done
---

# Phase 11 — Isolated Widget SDK runtime & host (~10h)

### Mục tiêu

Remove `bridge-codec-implemented-runtime-pending`: implement actual browser runtime/MessagePort handshake.

### Files

- `packages/widget-sdk`: client runtime
- `packages/widget-host`: frame host/session
- conversation-client isolated widget renderer
- reference fixture under `examples/`

### Runtime

Implement:
- init handshake with source window + nonce + negotiated MessagePort;
- props subscribe;
- state revision updates;
- event emit;
- action invoke;
- capability request;
- host focus/resize/requestPin/requestDetach/openExternal;
- semantic publish with available actions;
- lifecycle mount/suspend/resume/dispose.

### Isolation

- opaque origin/default no same-origin;
- CSP from installed manifest;
- exact source window;
- bounded messages;
- resource budgets;
- host chrome outside frame;
- no host storage/secret/Node.

### Tests

Security + lifecycle + stale revision + forged nonce + cleanup + offscreen suspension.

---
