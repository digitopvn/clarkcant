---
title: "Phase 14 — Motion polish, accessibility, performance & release gates"
status: done
---

# Phase 14 — Motion polish, accessibility, performance & release gates

### Motion pass

Build shared press/release, panel, popover and FLIP helpers. Do not `transition: all`.

Pin/detach should visually morph where geometry exists; if cross-window morph is not reliable, use deterministic fade/scale handoff without fake continuity.

### Accessibility

- keyboard-only journey;
- focus restore;
- minimum touch targets;
- screen-reader text alternatives;
- bounded live regions;
- reduced motion;
- contrast.

### Performance

- pointer Orb loop stays outside React state;
- heavy widgets lazy mount;
- offscreen suspend;
- no duplicated live subscriptions after detach;
- large table/chart bounds;
- first panel frame meaningful.

### Final commands

- `pnpm verify`
- `pnpm test:e2e`
- `pnpm verify:full`
- desktop smoke on supported macOS target

Update conformance status only with named tests/evidence.

---
