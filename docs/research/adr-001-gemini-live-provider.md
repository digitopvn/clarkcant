# ADR-001 — Voice runs on Gemini 3.8 Live behind a node-side proxy

**Status:** accepted · **Date:** 2026-09-17 · **Supersedes:** the GPT-Live provider choice in `docs/scope-lock.md:36`, `docs/system-architecture.md:83,241,282`, `docs/research-and-decisions.md` R29

## Context

The blueprint commits to a specific voice provider: "GPT-Live adapter đầu tiên, WebRTC + trusted backend" (`docs/system-architecture.md:83`), and the scope lock repeats it (`docs/scope-lock.md:36`). The provider is not presented there as an interchangeable detail.

`docs/implementation-plan.md:81` states the rule that governs this decision:

> Live access unavailable là blocker/ADR change, không âm thầm đổi thành STT+TTS rồi giữ tên live conversation.

and, more generally:

> scope change phải ADR, không quietly remove requirement.

The operator's goal for this repository requires **Gemini 3.8 Live**, and the operator holds working credentials for it. This ADR exists because that is a scope change and the quote above forbids making it silently.

## Decision

Voice uses **Gemini Live** as its provider, and the browser never talks to the provider directly. Audio flows browser → node → provider and back.

Two things changed relative to the blueprint, and they are separate changes that happen to travel together:

1. **Provider:** GPT-Live → Gemini Live, model id **`gemini-3.8-live`**.
2. **Transport:** browser-direct WebRTC to the provider → a node-proxied WebSocket carrying raw PCM.

## Why the provider changed

- The operator holds a Gemini key with live access; the GPT-Live account the blueprint assumed was never held. The blueprint's own escape hatch for exactly this is the ADR this document constitutes.
- The model id was resolved from the provider catalogue rather than from documentation or memory, in line with "Versions pin theo môi trường thực, không dùng tên model/API method từ trí nhớ" (`docs/implementation-plan.md` §3). The catalogue offers `gemini-3.8-live` and `gemini-3.8-live-extended-thinking`; this ADR pins the former, because the extended-thinking variant is a different model id rather than a tunable, and picking it would change latency and cost without a decision being made.

## Why the transport changed

The blueprint's "WebRTC + trusted backend" keeps a permanent provider key outside the renderer, which is the property that actually matters, and it is restated as a hard rule in the P9 gate:

> Giữ permanent key ngoài renderer … Short-lived SDK token exception goes through isolated auth bridge, never props/history.

A node-side WebSocket proxy preserves that property and needs no ephemeral-token flow at all, because the browser never sees a provider credential of any kind — not a permanent key, and not a scoped one. The trade is one extra hop in the audio path, which is the latency cost this ADR accepts.

Ephemeral tokens (the blueprint's "isolated auth bridge") remain available as a later optimisation. It is deliberately not built now: it is unverified for the current API version, and it is a smaller change than it looks because `VoiceProviderAdapter.connect({ tokenProvider })` already has the seam for it.

## Consequences

**Kept:** the provider-neutral seam (`VoiceProviderAdapter`, `VoiceState`, media-focus arbitration, transcript assembly, intent routing). None of those change; they are the parts that make this decision reversible.

**Changed:**

- `packages/voice-adapters` gains a real transport. `LiveVoiceAdapter` currently declares `provider = "gpt-live"` and throws on every method; its `TODO(P9)` comment also claims live access needs "a provider account … which this repository does not hold", which is **false for this machine** and must be corrected rather than left standing.
- The node gains a WebSocket upgrade path. That makes `apps/runtime/package.json`'s existing description — "command gateway over HTTP and WebSocket" — true instead of aspirational, and it is why `@fastify/websocket` may be dropped: the gateway is a `node:http` server, and the WebSocket dependency must be declared rather than borrowed transitively.
- `docs/scope-lock.md`, `docs/system-architecture.md` and `docs/conformance-traceability.md` (V17) must be updated to name Gemini, or they become the next set of comments that claim something the code does not do.

**Accepted risks:** one additional network hop in the audio path; a single node process multiplexing several live sessions if multiple tabs connect; and provider quota behaviour under sustained use, which is unverified.

**Not accepted:** silently presenting speech-to-text plus text-to-speech as a live conversation. The adapter keeps refusing that substitution, as it does today.

## Evidence

`plans/reports/verification-260917-0957-gemini-live-handshake.md` records the catalogue query that resolved the model id and a live handshake that completed a turn: setup accepted in 679 ms, 80,160 bytes of PCM at 24 kHz returned, `sessionResumptionUpdate` observed.
