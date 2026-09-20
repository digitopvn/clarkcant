---
title: "Phase 6 — Voice capabilities, voice picker & preview (~8h)"
status: done
---

# Phase 6 — Voice capabilities, voice picker & preview (~8h)

### Mục tiêu

Provider-neutral voice choices; Gemini maps to actual Live speech config.

### Files

- update: `packages/voice-adapters/src/provider.ts`
- update: `protocol.ts`, `gemini-live.ts`
- update: `apps/runtime/src/voice-session.ts`
- update gateway + client API
- update Devices & Voice Settings

### Contract

```ts
type VoiceOption = {
  id: string;
  label: string;
  locale?: string;
  description?: string;
};

type VoiceCapabilities = {
  supportsVoiceSelection: boolean;
  voices: VoiceOption[];
  supportsPreview: boolean;
};
```

Provider owns options. React does not know Gemini voice names.

### Gemini

Extend setup generation config with selected `voiceName` under provider speech config. Keep current system instruction that voice is “voice, not mind”.

### API

- `GET /voice/capabilities`
- `POST /voice/preview` or host-local preview command with bounded text.
- Preview session does not append transcript/message to conversation.
- Changing voice applies next voice session.

### Tests

Wire shape, unsupported provider behavior, preview cleanup, credential never enters response.

---
