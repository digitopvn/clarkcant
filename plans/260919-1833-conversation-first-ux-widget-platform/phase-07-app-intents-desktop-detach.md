---
title: "Phase 7 — Shared app-control intents + desktop window/detach (~12h)"
status: done
---

# Phase 7 — Shared app-control intents + desktop window/detach (~12h)

### Mục tiêu

Click/chat/voice gọi cùng typed registry for app chrome.

### Merge/supersede

Absorb old Issue #17 phase 5–7 rather than implementing a parallel registry.

### Intent families

- settings.open / settings.close / settings.select
- model.select / model.cycle
- execution.mode.set
- voice.start / voice.end / voice.mute
- window.mode.set
- window.resizePreset / window.restore / window.focus
- widget.pin / unpin / detach / attach / focus
- marketplace.open/search/install

### Desktop named bridge

Add explicit methods only:
- `setWindowMode`
- `resizeWindowPreset`
- `restoreWindow`
- `focusWindow`
- `detachWidget`
- `attachWidget`

No `invoke(channel,...)`.

### Modes

normal / expanded / compact / orb.

Bounds live in main process. Client requests semantic mode, not arbitrary pixels by default. Advanced resize can be bounded.

### Detach

Extend surface ownership contract to include detached host surface. Same instance, same owner lease.

Detached window receives only widget host bootstrap + instance ref, not full privileged conversation context.

Close detached → release/move ownership and restore pin/inline preview.

### Tests

- same intent result from click/chat/voice source;
- desktop smoke reads actual `BrowserWindow.getBounds()`;
- detach does not duplicate owner/media;
- forged renderer cannot call arbitrary IPC.

---
