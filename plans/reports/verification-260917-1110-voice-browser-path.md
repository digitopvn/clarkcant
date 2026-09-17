# Verification — the browser half of live voice, and three failures that were the browser's

**Date:** 2026-09-17 · **Branch:** `feat/p3-voice-gemini-live`
**Evidence:** `plans/reports/evidence/voice-01-listening-with-transcript.png`, `voice-02-after-ending.png`, `voice-03-recorded-after-reload.png`
**Verdict:** the browser-to-node path works end to end: capture leaves the page, audio returns and is scheduled for playback, and the transcript is written into the conversation.

## 1. What is real and what is substituted

| Piece | Real? |
| --- | --- |
| Chromium microphone (synthetic device, real capture path) | real |
| Capture, worklet, resampling, socket, playback | real |
| The node, its authentication, its single-session rule | real |
| The conversation the transcript is written into | real |
| The provider | **substituted** — `CC_VOICE_FIXTURE=1` |

The provider is the one substituted part, so this run needs no account and spends no quota. The adapter that talks to Gemini was verified separately against the live endpoint: `plans/reports/verification-260917-1018-live-audio-roundtrip.md` records a real round trip with an exact input transcription. Neither document alone is a full end-to-end claim, and together they are the honest pair.

## 2. The measured result

From the browser, after starting a session:

```text
voiceState: "listening" | captureFrames: 46 | audioFrames: 25 | problem: none
```

46 frames left the page and 25 came back. The assertion that matters most is `captureFrames > 0`: the fixture provider answers **only after** it has received a second of audio, so a transcript in the UI cannot appear unless audio genuinely travelled from the browser. A capture path wired to nothing fails this rather than passing quietly.

## 3. Three failures, and all three were the browser

Getting here took three attempts, each defeated by something that reports no error.

**3.1 A `blob:` URL is not `'self'`.**
The worklet was first built from a string and loaded from a blob URL, which is the standard trick for avoiding bundler configuration. It failed:

```text
AbortError: Failed to load worklet module script: blob:http://127.0.0.1:4273/...
(a dependency or cross-origin script failed to load)
```

The app's policy is `script-src 'self'`, and a blob URL is not `'self'`. The right response was to ship a real same-origin file rather than add `blob:` to the policy: the policy is a protection, and trading it for a build convenience is the wrong direction.

**3.2 An inlined asset is a `data:` URL, and that is not `'self'` either.**
The real file was then loaded through a bundler-resolved URL — and still failed, because Vite inlines assets below its size limit as `data:` URLs:

```text
Failed to load worklet module script: data:text/javascript;base64,LyogZ2xvYmFsIEF1ZGlvV29ya2xldFByb2Nlc3Nvciw...
```

Fixed by telling Vite never to inline this one file (`assetsInlineLimit` returning `false` for it), so it is emitted as `dist/assets/voice-capture-worklet-*.js`. Both failures produced the same symptom and the same absence of a useful error; the only way to tell them apart was to print the URL that failed to load.

**3.3 A suspended `AudioContext` captures nothing and says nothing.**
The audio context was being created after `await`ing the socket handshake, which puts it outside the user gesture that requested audio, and a browser may then leave it suspended. A suspended context produces no audio, raises no error, and looks exactly like a working session: the surface reported "listening" while nothing was captured.

Two changes: the context is now created **synchronously** in the gesture before anything is awaited, and if it still will not run the session **fails with a sentence a person can act on** rather than reporting a state it cannot honour.

## 4. What this changed in the product, not just in the tests

- The surface exposes `data-voice-capture-frames` and `data-voice-audio-frames`. These exist because "the microphone is open" and "audio is leaving" are different claims, and a voice interface that cannot tell them apart cannot report honestly.
- The e2e asserts capture frames separately from the reply, so a future failure says which half broke.
- `voiceSocketUrl` refuses a plain `ws://` connection to a non-loopback host. The credential travels in the first frame, so an unencrypted socket to a remote node would put it on the wire in clear text; the node already refuses a public bind without an explicit acknowledgement, and the client now matches that.
- No CSP was weakened. The existing policy already permitted `ws://127.0.0.1:*`, so voice needed no change to it.

## 5. Unresolved

1. Only the fixture provider is exercised in CI. A live run against Gemini from a real browser is the operator's listening check, not something CI can claim.
2. The silence window and sensitivity of the provider's own activity detection are untuned; the defaults were used, and the measurement is in the round-trip report.
3. Playback is verified as *scheduled*, not as *audible*. Nothing in a headless browser can honestly assert that a person would hear it, which is why the operator check exists.
