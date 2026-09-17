# Verification — Gemini Live handshake and model id

**Date:** 2026-09-17 · **Repo:** `/Volumes/GOON/www/digitop/clarkcant` · **Base commit:** `c9219fc`
**Scope:** resolve the two assumptions the Kongming report marked low-confidence, before any voice code is written.
**Verdict:** both resolved by direct provider contact, not by documentation reading.

---

## 1. Why this report exists

`plans/reports/kongming-260916-1841-model-block-seam-voice-and-order.md` §9 recorded two assumptions as **low confidence** and named them as things that would change the answer:

1. That the model called "Gemini 3.8 Live" exists under a concrete id.
2. That a provider account with live access is available.

It also raised a third: whether ephemeral tokens still work on `v1alpha`. That one stays open and is now less urgent, because the recommended design routes audio through the node rather than through the browser.

This report replaces assumptions 1 and 2 with observed facts so the implementation is not written on top of them.

## 2. Model id — RESOLVED

`GET https://generativelanguage.googleapis.com/v1beta/models` against the operator's key returned **58 models**. The live-capable subset is:

| id | note |
| --- | --- |
| `gemini-3.8-live` | the model the goal names; used in the probe below |
| `gemini-3.8-live-extended-thinking` | same family, extended thinking variant |
| `gemini-3.1-flash-live-preview` | earlier preview |
| `gemini-3.5-transcribe-live` | transcription, not conversation |
| `gemini-3.5-live-translate-preview` | translation, not conversation |

**Decision:** pin `gemini-3.8-live`. The id is resolved from the catalogue rather than hardcoded from a product name, which is what the report asked for. `gemini-3.8-live-extended-thinking` is a separate id, not a parameter, so the earlier warning — "don't send `thinking_level`" — still holds and is now explained: the variant is chosen by model id.

## 3. Live handshake — PASS

Probe: `/tmp/cc-live-probe.mjs` (throwaway, outside the repo; no dependency added, it uses the global `WebSocket` in Node 22+). It opened the WebSocket, sent `setup`, sent one text turn, and read the response. The key was read from `.env` and never printed.

```text
=== VERDICT: PASS ===
model gemini-3.8-live completed a turn
server message keys: setupComplete, sessionResumptionUpdate, serverContent, usageMetadata
setup complete after ms: 679
audio bytes received: 80160 mime: audio/pcm;rate=24000
model text: ""
```

What this proves, and what it does not:

- **Proved:** the key has live access; `setup` with `responseModalities: ["AUDIO"]` is accepted; a turn completes; the model returns **80,160 bytes of raw PCM at 24 kHz**, which is the documented output format. Setup latency was 679 ms.
- **Proved incidentally:** the server emits `sessionResumptionUpdate`, so session resumption is available if a dropped socket needs to be resumed rather than restarted.
- **Not proved:** that audio *input* is accepted, that the ephemeral-token path works, and that quota is sufficient for sustained use. The probe sent text, not audio, and used the server-to-server key path.
- **Not proved:** anything about the browser. This ran in Node, which is where the proxy design puts the credential anyway.

The output modality being `AUDIO` with empty text output is the expected shape for a Live session configured for audio, and it means the adapter should not expect a text transcript on the same channel without asking for it.

## 4. What this changes

| Previous state | Now |
| --- | --- |
| `packages/voice-adapters/src/index.ts` declares `readonly provider = "gpt-live"` | The goal requires Gemini. This is a **silent provider deviation** from the blueprint's GPT-Live decision and must be recorded as a deviation, not swapped quietly. |
| Live model id unknown, flagged low confidence | `gemini-3.8-live`, resolved from the catalogue. |
| Provider account availability unknown | Confirmed working, with a completed audio turn. |
| `TODO(P9)` said "opening a live audio session needs a provider account … which this repository does not hold" | That comment is now **factually wrong for this machine** and must be corrected when the transport lands. The blocker is the missing WebSocket transport and token bridge, not the account. |

## 5. Unresolved questions

1. Does the node need to serve several browser tabs on `/voice` at once, and if so what is the concurrent Live session ceiling? This is a node setting, not a transport detail.
2. Ephemeral tokens on `v1alpha`: still unverified. It does not block the node-proxy design, and it only becomes relevant if browser-direct connections are ever wanted.
3. Sustained-use quota and cost for `gemini-3.8-live` are unknown; the probe consumed one short turn.
