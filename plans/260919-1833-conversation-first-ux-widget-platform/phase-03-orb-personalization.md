---
title: "Phase 3 — Orb personalization + input/agent state (~9h)"
status: done
---

# Phase 3 — Orb personalization + input/agent state (~9h)

### Mục tiêu

Giữ Orb như signature, mở personalization an toàn và standardized ambient reactions.

### Files

- update: `packages/conversation-client/src/orb.ts`
- update: `Orb.tsx`, `orb-shader.ts`
- new: `orb-profile.ts`
- new: `input-modality.ts`
- update: `Conversation.tsx`, `VoiceOverlay.tsx`, `styles.ts`
- update design token tests + Orb tests

### Orb physics

Mở additive options:

```ts
physics?: {
  stiffness?: number;       // clamp 40..180
  damping?: number;         // clamp 4..24
  wobbleGain?: number;      // clamp 0..1
  pointerResponse?: number; // clamp 0..1.5
}
```

Không đọc storage trong renderer. `resolveOrbProfile(preferences)` trả immutable resolved options.

Presets:
- Clark;
- Calm;
- Jelly;
- Glass;
- Custom.

Custom palette chỉ cho named channels đang có; không shader source.

### Important implementation detail

`Orb.tsx` hiện effect dependency chỉ theme/pointerTarget dù options được read once. Thêm stable `profileRevision/profileKey` để renderer recreate khi profile đổi, nhưng không rebuild mỗi render/keystroke.

### Root interaction state

```text
data-input-modality = pointer | keyboard | touch | voice
data-agent-state    = idle | listening | thinking | tooling | responding | success | error
```

Pointer/keyboard/touch detector ở shell root, không đặt listeners trong từng button.

### Tests

- clamp physics;
- preset deterministic;
- profile update recreates Orb exactly once;
- reduced motion overrides custom speed/physics animation;
- WebGL fallback vẫn mang selected palette hợp lý;
- pointer movement không re-render conversation.

---
