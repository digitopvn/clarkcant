# Voice on Gemini Live — implementation plan (PR P3)

**Date:** 2026-09-17 · **Repo:** `clarkcant` · **Depends on:** P1 (gate + seam), P2 (UI surfaces)
**Governing decision:** `docs/research/adr-001-gemini-live-provider.md`
**Measured facts:** `plans/reports/verification-260917-0957-gemini-live-handshake.md`

## Outcome

Audio captured in the browser reaches Gemini Live through the node, audio comes back and plays, and the UI reports the real state — listening, speaking, or blocked with a reason. Verified end to end in headless Chrome with a fake audio device.

## What already exists (do not rebuild)

The provider-neutral half of this feature is implemented and tested:

| Piece | Where | State |
| --- | --- | --- |
| `VoiceState` machine, media-focus arbitration | `packages/contracts/src/voice.ts` | done, tested |
| Transcript assembly, dedup, contiguity | `assembleUtterance`, `ingestTranscript` | done, tested |
| Intent routing (barge-in ≠ cancel) | `routeVoiceIntent` | done, tested |
| Session bookkeeping, mute/end semantics | `packages/voice-adapters/src/index.ts` | done, tested |
| Node gateway with bearer auth | `apps/runtime/src/gateway.ts` | done |
| Blocked-state surface | `VoiceSurface.tsx` | exists, must be replaced by a working control |

The gap is exactly one thing: **a transport**. `LiveVoiceAdapter` throws on every method.

## Architecture

```text
browser mic ──PCM16 16k──▶ ┐                        ┌──▶ browser speaker (PCM16 24k)
                           │  WebSocket /voice      │
                    node (holds GEMINI_API_KEY) ────┴──▶ Gemini Live WSS
```

The browser never sees a provider credential — not the permanent key, and not an ephemeral one. That is the property the blueprint's P9 gate actually protects ("Giữ permanent key ngoài renderer"). It is why the ephemeral-token flow is deferred rather than required: a node proxy satisfies the rule without it.

## Decisions to make in code

**1. Auth goes in the first frame, never the query string.**
A browser `WebSocket` cannot set an `Authorization` header, so the token has to travel some other way. The URL is the wrong place: it lands in server logs, proxy logs and browser history. So the client connects unauthenticated, and the **first message must be an auth frame**; the node attaches to the provider only after it validates. Any audio frame arriving before authentication is dropped and closes the socket. Kongming flagged this explicitly ("Đừng đặt bearer token vào query string của WebSocket").

**2. The WebSocket dependency must be declared, not borrowed.**
`ws@8.21.3` is already in the store transitively, and `apps/runtime/package.json` declares `fastify` + `@fastify/websocket` while importing neither and running a `node:http` server. Declaring `ws` directly on `apps/runtime` adds no download and no new transitive surface; the faster alternative — migrating the gateway to Fastify — is a much larger change than this feature warrants. **`@fastify/websocket` should be removed** in the same commit, since its description claim becomes satisfiable by the code we add.

**3. Provider ownership belongs to the adapter, not the gateway.**
The gateway routes bytes; it does not know Gemini exists. `GeminiLiveAdapter` owns the setup message, the audio format conversion and the mapping from provider events to `VoiceState` and `VoiceTranscriptFragment`. Swapping providers must stay a change in one package.

**4. Model id comes from configuration, defaulting to the measured one.**
`gemini-3.8-live` is pinned as the default, but read from the environment like `CC_MODEL_ID`, so a catalogue change is a configuration change rather than a code edit. The extended-thinking variant is a different id, not a parameter.

**4a. One live session per node; a second is refused with a reason (decided).**
The node holds a single session slot. A second tab that asks for voice is told the node already has a live session and who holds it, rather than being queued, silently shared, or allowed to open a second provider session against the same quota. This reuses the vocabulary the media-focus contract already has — a refusal that names the holder — so the surface can say which tab has the microphone instead of going quiet. It is deliberately not a configurable ceiling yet: a setting nobody can test is a setting nobody trusts, and the refusal is the honest behaviour for a single-user local node.

**4b. The transcript is live in the surface, and written to the timeline once per session (decided, revised).**
While the session is running the transcript is shown in the voice surface, fed by the provider's transcription events. When the **whole voice session ends**, the full verbatim transcript of both sides is written once through the same durable path typed text uses, so a spoken session survives a reload beside typed messages.

This replaces an earlier decision to persist each completed turn. The trade is deliberate and worth stating: a long session lands as one large message rather than a readable sequence of turns, and a crash or a closed tab loses the session rather than everything up to the last turn. In exchange there is no per-turn write, and therefore no duplicate-write risk when a provider transcription event is re-delivered.

The record is written through the typed-text path rather than beside it, so a voice session cannot become a second, unaudited way to write to the timeline.

**5. Turn boundaries are the provider's job, and the browser streams continuously (measured).**
Automatic activity detection is the documented default and it **works** — see `plans/reports/verification-260917-1018-live-audio-roundtrip.md`. There is no client-side voice-activity detector in this design, and no hold-to-talk mode. The browser streams microphone audio continuously, pauses included, and the provider commits a turn when it hears the end of speech. Activity handling defaults to `START_OF_ACTIVITY_INTERRUPTS`, so barge-in arrives as an `interrupted` event, and the listening/speaking states come from provider events rather than local inference.

This is a corrected conclusion. An earlier probe run appeared to show automatic detection does not work, which would have required a calibrated client-side detector plus a second interaction mode. The real cause was test audio ending on the last sample of speech, giving end-of-speech detection no silence to detect. A generated-audio test must append trailing silence; a real microphone provides it for free.

**6. Setup message shape is a tested contract.**
`responseModalities: ["AUDIO"]`, input audio transcription enabled so the transcript panel and intent routing have something to consume, and **no `thinking_level`**. The earlier report warned about that field; the reason is now concrete — extended thinking is selected by model id (`gemini-3.8-live-extended-thinking`), so sending a thinking parameter would either be ignored or contradict the pinned model.

**7. Audio formats are converted once, at the boundary.**
Gemini wants input PCM16 at 16 kHz and returns PCM16 at 24 kHz (measured: `audio/pcm;rate=24000`). The browser side should capture at whatever rate the device offers and resample to 16 kHz in the client, because the node should not be in the business of audio DSP for a stream it is proxying. Playback at 24 kHz likewise.



## Files

| Action | Path | Why |
| --- | --- | --- |
| add | `packages/voice-adapters/src/gemini-live.ts` | the transport + provider event mapping |
| add | `packages/voice-adapters/src/protocol.ts` | setup/message shapes as typed builders and parsers |
| edit | `packages/voice-adapters/src/index.ts` | re-export; correct the false `TODO(P9)` comment |
| add | `packages/voice-adapters/test/gemini-live.spec.ts` | setup shape, state mapping, no-key-to-browser |
| add | `packages/voice-adapters/test/transcript-persistence.spec.ts` | the finished utterance persists exactly once, even if events repeat |
| add | `apps/runtime/src/voice-session.ts` | upgrade handler, first-frame auth, byte piping |
| edit | `apps/runtime/src/main.ts` | attach the upgrade handler to the existing server |
| edit | `apps/runtime/package.json` | declare `ws`; drop the unused Fastify pair |
| add | `packages/conversation-client/src/voice-session.ts` | capture, resample, play, state reporting |
| edit | `packages/conversation-client/src/VoiceSurface.tsx` | the real control, with the blocked state kept as a real state |
| add | `packages/conversation-client/test/voice-session.spec.ts` | client state mapping, mute actually stops capture |
| add | `apps/web/e2e/voice.spec.ts` | headless Chrome, fake audio device |

## Verification

**Unit, no account needed:**
- the setup frame matches the contract exactly, and contains no credential;
- a forged server event cannot move the state machine into `speaking` without audio;
- `barge-in` yields audio only and does not cancel a running job (the T64 property, now through the transport);
- mute stops capture locally with no round trip;
- the session transcript is written to the timeline exactly once when the session ends, and not before;
- a second voice request is refused and the refusal names the tab that holds the session.

**Integration, no account needed:** a fixture WebSocket server that speaks the Gemini protocol, so the node's piping and auth gating are tested without quota. This mirrors how `FakePiAdapter` makes the model path testable.

**End to end, headless:** Playwright with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, so a synthetic microphone feeds real audio through the real node. Screenshot evidence of listening/speaking/blocked.

**One human check:** a real run against the live provider with the operator listening, because "audio came back and was audible" is not something a headless test can honestly assert. A WAV of the returned audio is captured as the artifact for that.

## Risks

| Concurrency | settled: one session per node, second request refused by name |
| Resampling quality in the client | capture at the device rate and resample once; a wrong rate shows up immediately as chipmunk or slowed audio, which is audible in the one human check |
| A voice session writing into the timeline | the record goes through the typed-text write path, so it cannot bypass the provenance screen the seam already enforces |
| Provider protocol drift | `protocol.ts` is the single place that knows the wire shape, and the compatibility lock records the tested model id and date |

## Decisions already taken

- **Concurrency:** one live session per node; a second request is refused with the holder named.
- **Transcript:** live in the voice surface for the session, written verbatim to the timeline once when the session ends.
- **Turn boundaries:** provider-side automatic activity detection; no client-side detector and no hold-to-talk mode.
