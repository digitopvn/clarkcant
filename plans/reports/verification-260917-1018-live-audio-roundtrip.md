# Verification — Live audio round trip, and one wrong conclusion corrected

**Date:** 2026-09-17 · **Repo:** `clarkcant` · **Model:** `gemini-3.8-live`
**Method:** six throwaway Node probes (global `WebSocket`, no dependency added), reading the key from `.env` and never printing it.
**Verdict:** audio input and output both work end to end using the **documented default** automatic activity detection. Turn boundaries are the provider's job.

## 0. Correction first

An earlier version of this report claimed that automatic activity detection **does not work** for this model and that the client must signal turn boundaries itself. **That was wrong.** The provider was never at fault; the test audio was.

Every audio probe appended here now ends with 1.5 s of digital silence. With that one change, the default configuration produced a completed turn and an exact transcription in three out of three cases. The cause of the earlier failures is explained in §3 and is entirely on our side.

This matters beyond the record: the wrong conclusion would have added a client-side voice-activity detector with an uncalibrated energy threshold, plus two interaction modes to build and test, to solve a problem that does not exist. The prompt to check how ChatGPT Live and Gemini Live handle this is what surfaced it.

## 1. What the two products do

- **Gemini Live** performs server-side automatic activity detection by default, tunable through `realtimeInputConfig.automaticActivityDetection` (`startOfSpeechSensitivity`, `endOfSpeechSensitivity`, `prefixPaddingMs`, `silenceDurationMs`). It also offers a **Hybrid VAD** mode that pairs server-side start detection with client-side end detection to cut latency. Activity handling defaults to `START_OF_ACTIVITY_INTERRUPTS`, which is barge-in: user audio cuts off the model's response.
- **OpenAI Realtime** offers `server_vad` (energy based) and `semantic_vad` (model-estimated end of speech, with an `eagerness` control), enabled by default for speech-to-speech, and explicitly supports disabling them for **manual client-side turn control**.

So relying on the provider is the mainstream default, and client-side control is a supported option for latency, not a necessity. One useful warning from the same research: a public benchmark argues OpenAI's `semantic_vad` performs worse than `server_vad` in backchannel and quiet-speech cases, so vendor guidance is worth measuring rather than trusting. That is the same lesson as §0.

## 2. Confirmed wire facts

| Fact | Value |
| --- | --- |
| Endpoint | `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` |
| Setup accepted in | 679–852 ms |
| Input audio | raw PCM16, 16 kHz, little-endian, base64 in `realtimeInput.audio.data`, `mimeType: "audio/pcm;rate=16000"` |
| Output audio | raw PCM16 at 24 kHz (`audio/pcm;rate=24000`) |
| Transcription | `inputAudioTranscription` / `outputAudioTranscription` accepted as `{}` in `setup`; accurate enough to be the transcript the contract already models |
| Other server keys | `setupComplete`, `sessionResumptionUpdate`, `usageMetadata` |

## 3. Why the first four audio probes failed

The audio was correct. The stream was not: it ended on the **last sample of speech**, and end-of-speech detection needs a window of non-speech before it will commit a turn. Sending `audioStreamEnd` immediately did not substitute for that silence, which is why even a *forced* `clientContent` turn afterwards produced nothing — the audio had never been committed.

This is easy to get wrong with synthetic audio and it cannot happen with a real microphone, which streams continuously through the pauses between utterances. A test that generates audio in a file has to reproduce the silence a microphone provides for free.

## 4. The corrected measurement

Speech followed by 1.5 s of digital silence, default automatic detection:

| Case | Setup | Result |
| --- | --- | --- |
| **D** | documented default, no `audioStreamEnd` | **TURN COMPLETE**, 145,922 bytes audio, transcript exact |
| **E** | documented default, then `audioStreamEnd` | **TURN COMPLETE**, 111,840 bytes, transcript exact |
| **F** | explicit `START/END_SENSITIVITY_HIGH`, `silenceDurationMs: 500` | **TURN COMPLETE**, 96,960 bytes, transcript exact |

And for contrast, the same audio **without** trailing silence: no turn, no transcript, no error — the original failure, reproduced deliberately.

In every successful case the input transcription matched the spoken sentence verbatim: *"Hello, this is a test of the voice channel. Please reply with a short sentence."*

## 5. Design consequences

- **No client-side voice detection.** The provider detects speech start and end, which removes an energy threshold we would have had to calibrate for quiet rooms versus noisy ones, and removes a second interaction mode from the surface.
- **The browser streams microphone audio continuously**, including the pauses. Streaming only while the user "seems to be talking" is what broke the probes.
- **Barge-in is provider-side** through `START_OF_ACTIVITY_INTERRUPTS`, reported as `interrupted`, which is exactly the event the contract's `barge-in` intent needs.
- **UI state comes from provider events**: a committed turn (`turnComplete`), an interruption (`interrupted`), and the voice-activity field. No local inference is required to know whether the user is speaking.
- **Hybrid VAD stays unbuilt.** It is a latency optimisation for later; it is not on the path to the goal, and building it now would be the same mistake as the client-side detector, just postponed.

## 6. Persistence decision (revised)

Recorded here because it changes a decision made earlier in this work:

- **Previous:** transcript shown live in the surface, then persisted per turn.
- **Now:** the transcript is shown live in the surface, and when the **whole voice session ends** the full verbatim transcript of both sides is written to the session history once.

Consequences to accept knowingly: a long session lands as one large message rather than a readable sequence of turns, and a crash or a closed tab loses the whole session rather than everything up to the last turn. In exchange there is no per-turn write, and therefore no duplicate-write risk when a provider event repeats.

## 7. Unresolved

1. Whether `silenceDurationMs` behaves as documented on this model; probe F changed three settings at once, so it shows the explicit configuration works but does not isolate which field mattered. The default is fine, so this is not on the path to the goal.
2. Whether the same behaviour holds for `gemini-3.8-live-extended-thinking` and `gemini-3.1-flash-live-preview`. Untested.
3. End-to-end latency through the node proxy versus browser-direct is unmeasured; the proxy adds a hop, and the goal's acceptance is "audible and correct", not "as fast as possible".
