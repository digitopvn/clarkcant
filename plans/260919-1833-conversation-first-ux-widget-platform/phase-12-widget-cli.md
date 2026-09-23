---
title: "Phase 12 — Widget Developer CLI, dev host & conformance (~8h)"
status: done
---

# Phase 12 — Widget Developer CLI, dev host & conformance (~8h)

Canonical behavior: `docs/widget-development.md`.

### CLI target

```text
clark widget init
clark widget dev
clark widget test
clark widget pack
clark widget publish   # publish command may initially prepare directory submission
```

### `init`

Templates:
blank/dashboard/form/editor/media/MCP-App-adapter.

### `dev`

Standalone local isolated host:
- HMR;
- fixtures;
- 320/conversation/compact/expanded;
- dark/light;
- reduced motion;
- offline/read-only;
- semantic inspector;
- action log;
- capability simulator;
- a11y checks.

### `test`

Conformance:
- schema;
- bridge security;
- keyboard;
- reduced motion;
- text fallback;
- local/effect action;
- dedup;
- state migration;
- pin/detach;
- voice/click parity.

### `pack`

Immutable artifact + digest + manifest report + preview metadata.

Developer can use local path without directory account.

---
