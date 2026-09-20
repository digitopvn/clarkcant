---
title: "Phase 10 — Default agentic widget catalog (~9h)"
status: done
---

# Phase 10 — Default agentic widget catalog (~9h)

### P0 definitions

- `ui.question@1`
- `ui.form@1`
- `ui.task@1`
- `ui.artifact@1`
- improved `ui.diff@1`
- `ui.browser@1`
- `ui.computer@1`

### Architecture

Create a new host/UI pack rather than stuffing every semantic widget into `data-canvas`; data-canvas stays data visualization.

Question/form supports voice semantic selection/submission.

Task morphs progress→summary in same logical component.

Artifact reuses attachments/blob refs.

Browser/computer use host-owned preview/action leases.

### Definition gates

Every widget ships fixtures:
loading, empty, live, cached/offline where relevant, error, read-only, compact/expanded.

Every widget publishes text representation + semantic action state.

### E2E journeys

- agent asks question → click answer / voice answer same result;
- form draft survives rerender;
- task Stop;
- artifact reopen;
- diff keyboard;
- browser takeover/stop.

---
