# Verification — the whole path with nothing substituted, in headless Chrome

**Date:** 2026-09-17 · **Branch:** `main` at the time of the run · **Commit under test:** `4f7d5b1`
**Supersedes the limitation stated in** `verification-260917-1110-voice-browser-path.md`, where the provider was substituted by a fixture.

---

## What was run

Headless Chrome capturing from a synthetic audio device, through the real application, through the node's `/voice` proxy, to **Gemini 3.8 Live**, and back.

| Piece | Substituted? |
| --- | --- |
| Chromium microphone | synthetic **device**, real capture path (AudioWorklet, 16 kHz, socket) |
| The application | real — `VoiceSurface`, `GatewayClient`, the shipped bundle served by `vite preview` |
| The node | real — `apps/runtime`, its auth, its single-session rule |
| **The provider** | **not substituted — Gemini 3.8 Live** |
| The conversation | real — the node's own database |

Chrome was launched with `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream` and `--use-file-for-fake-audio-capture`, so the microphone played a real spoken sentence (generated with `say`) rather than a tone. No fixture provider was loaded.

## Result

- The session opened and the surface reported `đang nghe` (listening), captured in `voice-live-05-app-with-gemini.png`.
- **The transcript shown in the app is the live model's own transcription of the microphone**: `Bạn: "Hello, please answer in one short sentence."`, repeated because Chrome loops the capture file. It is not a scripted string, and it could not appear unless audio traversed browser → node → provider.
- Audio came back: the same pipeline measured through the node returned **96,000 bytes = 2.00 seconds of PCM16 at 24 kHz**, written to `voice-live-04-gemini-reply.wav`. Through the app, `data-voice-audio-frames` was non-zero.
- State transitions observed through the node client: `idle → connecting → listening → speaking → ended`.
- **The transcript reached the conversation.** Read back from the node's own database:

```text
1. user:      cho tui xem biểu đồ
2. assistant: system-card | … | surface | widget
3. user:      Hello, please answer in one short sentence. Hello, please answer in one short sentence. …
```

The third row is the spoken session, recorded once at the end, through the same write path typed text uses.

## What this closes, and what it does not

**Closes:** the goal's requirement that audio captured in the browser reach Gemini 3.8 Live through the node and come back with the UI reporting the correct state, verified in headless Chrome with a synthetic microphone. The earlier reports verified the provider (raw protocol) and the browser pipeline (fixture provider) separately; this run verifies them together, with the provider real.

**Does not close:** whether a person would hear it. Nothing headless can assert audibility, which is why the returned audio is saved rather than described. `voice-live-04-gemini-reply.wav` is on disk in this directory for the operator to listen to. It is **not committed**: the repository's policy is that generated evidence stays on disk and out of the index, and a decision to commit audio would extend that policy rather than follow it.

## Cost and repeatability

This run spent provider quota, so it is not a committed test and does not run in CI. CI keeps the fixture provider (`CC_VOICE_FIXTURE=1`), which verifies the same browser and node paths without an account. Running this check again is a deliberate act rather than a side effect of a push.

## Method note

Two throwaway scripts were used and are not in the repository: one driving the node's socket directly, and one driving the app in Playwright. Both were removed. Their value is the measurement above, not the code.
