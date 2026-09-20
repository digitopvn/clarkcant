---
title: "Phase 8 — Compact/orb voice modes + wake-word seam (~10h)"
status: done
---

# Phase 8 — Compact/orb voice modes + wake-word seam (~10h)

### Mục tiêu

Voice is same Clark, with expanded/compact/orb presentations and optional local wake.

### UI

- Expanded: current VoiceOverlay.
- Compact: state + waveform + mute/end/expand.
- Orb: signature Orb + state only; transcript on request.

Collapsing never restarts provider session.

### Wake seam

Create interface before choosing detector dependency:

```ts
interface WakeWordDetector {
  start(onWake: () => void): Promise<void>;
  stop(): Promise<void>;
  status(): WakeStatus;
}
```

Rules:
- local detector where supported;
- wake listener has explicit UI state;
- ambient audio is not sent to Gemini merely for wake detection;
- wake activation opens voice session;
- “tắt voice / về chat” calls local host intent immediately.

Package/platform spike decides actual detector. If no acceptable local detector on release platform, ship toggle unavailable with reason rather than remote always-listening fallback.

### Tests

Fixture detector + browser client; macOS smoke for lifecycle; no duplicate microphone owner.

---
