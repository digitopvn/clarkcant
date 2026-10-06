# ADR-003 — Speech recognition is its own seam, and transcripts are made canonical deterministically

**Status:** accepted · **Date:** 2026-10-06 · **Related:** [ADR-001](adr-001-gemini-live-provider.md), [ADR-002](adr-002-gemini-tts-flash.md), issue #468 · Vietnamese: [adr-003-speech-recognition-seam.vi.md](adr-003-speech-recognition-seam.vi.md)

## Context

The person's words reached the runtime only as a side effect of the live conversation: Gemini Live transcribes the
audio it hears, and that transcription was the only source. A conversational model is not tuned for a Vietnamese
sentence that carries English identifiers. In practice, "sửa lỗi stale closure trong useEffect" arrived as "stale
closer trong use effect". "pnpm" arrived as "p n p m". Symbols came back split into words, and casing was lost. The
agent then answered a sentence the person did not say.

ADR-001 forbids silently presenting speech-to-text plus text-to-speech as a live conversation. Nothing in this ADR does
that: the live session stays the voice. What changes is where the person's words come from, and what is done to
them before they mean anything.

## Decision

1. **Two seams beside the live one.**
   - `SpeechRecognitionAdapter` (`packages/voice-adapters/src/recognition.ts`) covers start, streaming PCM16, interim
     and final utterances, context updates, and language and span-confidence metadata. That metadata is carried only
     when a provider really reports it, and is never invented.
   - `SpeechSynthesisAdapter` is the request/response seam for speech outside a live session; ADR-002's client is its
     first implementation.
   - The contracts (`RecognitionContext`, `RecognizedUtterance`, `SpeechRecognitionCapabilities`,
     `RecognitionProvenance`) live in `packages/contracts/src/voice.ts`.
2. **A dedicated recognizer, opt-in.**
   - `GeminiTranscribeLiveAdapter` implements the seam against the documented Live transcription model
     `gemini-3.5-transcribe-live`
     ([docs](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe), checked 2026-10-06):
     - `inputAudioTranscription` in `VERBATIM` mode, with `customVocabulary`;
     - empty `languageCodes`, so the provider detects code-switching itself;
     - `interimInputTranscription` as a replacing hypothesis and `inputTranscription` as the final;
     - `audioStreamEnd` to finalize.
   - The credential is the node-side key the live session already uses, and it travels in the connection URL, never
     in a message body.
   - It is enabled per node with `CC_VOICE_RECOGNIZER=gemini-transcribe`. When it is on:
     - the audio goes to both;
     - Live keeps speaking and keeps hearing barge-in;
     - the recognizer's interims are shown, and only its settled final is dispatched.
   - A recognizer that cannot open, or fails mid-session, hands the sentence in progress back to the live
     transcription.
3. **A bounded, ranked, redacted session vocabulary.**
   - It is built on the node from:
     - projects;
     - the active manifest and branch;
     - symbols, paths and issues the conversation mentioned;
     - skills, extensions, and the current model and provider;
     - a built-in coding glossary with known mis-hearings as aliases.
   - Every term passes the shared `redactSecrets` and is dropped if redaction would touch it. No second set of secret
     patterns exists.
   - Conversation text only ranks terms and never leaves the node.
   - A provider adapter translates the vocabulary into its own field. Gemini gets canonical spellings only, because
     biasing a recognizer towards a known mis-hearing would defeat the purpose.
4. **A deterministic normaliser, not a model.**
   - The rules are casing, spacing, alias and one-edit near-match. Each needs evidence: Vietnamese in the sentence, or
     a technical anchor outside the span.
   - Casing never lowers a letter.
   - Commands are never changed except by casing.
   - A span that could be two terms is left as heard, and the abstention is recorded.
   - Each change is recorded as bounded provenance.
5. **Settle once, and retry deliberately.**
   - A final utterance is settled on an ordered queue and dispatched once per utterance id, through the same `ask`
     path a live transcript takes. Approvals, questions, app intents and widget actions therefore see the canonical
     text.
   - An ambiguous or low-confidence technical span may have that one utterance recognized again from its own bounded
     audio buffer, with a context focused on the candidates.
   - The readings are compared by a fixed rule. The original wins ties, and so does any retry that heard a different
     sentence.
   - The retry is bounded in time. No transcript is sent to Jev, which decides between bounded options and is not a
     transcript rewriter.

## Why the dedicated recognizer is not the default yet

Which recognizer hears Vietnamese–English coding speech best is an empirical question. This environment cannot answer
it without audio and a key, so the benchmark harness exists to answer it. Until an audio run says otherwise, the
default stays the path that already works. The normaliser improves that path as well: on the text corpus below, the
live baseline gains most of what normalisation can give. A provider picker in the interface would ask the person to
make a decision they cannot evaluate, so there is none.

## Evidence

`corepack pnpm --filter @clarkcant/voice-adapters bench:transcription` runs the scorer over
`packages/voice-adapters/bench/vi-en-coding-corpus.json`. The corpus holds 68 utterances (code-switched Vietnamese and
English with Vietnamese context) and 94 technical terms. Its recognizer outputs are simulated: they are typical
live-transcription errors written by hand, not recordings.

| Stage | WER | CER | Technical Term Error Rate | Exact utterances | Changes | Abstained | Regressions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| raw | 27.2% | 4.5% | 80.9% | 16.2% | - | - | - |
| normalized | 4.5% | 1.0% | 16.0% | 75.0% | 62 | 1 | 0 |

Commands and versions are never worse after normalisation (9/11 and 2/2 both before and after); symbols go from 0/19 to
15/19, paths from 0/6 to 5/6, acronyms from 0/9 to 9/9. The residuals are deliberate:

- `git stash` heard as `git status` is not corrected, because commands are never guessed;
- issue numbers are not rewritten;
- out-of-vocabulary names are left alone;
- English prose with no technical anchor is left alone;
- the ambiguous `voiceSession` / `voice_session` span abstains.

The same command with `--audio <manifest> --recognizer gemini-transcribe-live|gemini-live` recognizes real recordings
and scores them beside the corpus, reporting finalization latency. That run needs `GEMINI_API_KEY`, and stops with an
"external gate" message without one.

## Consequences

**Kept:**

- `VoiceProviderAdapter`, `GeminiLiveAdapter` and the default live path;
- the wire to the browser: interims are ordinary non-final user `transcript` frames, and a canonical sentence is a
  final one;
- mute, end and media focus, which now reach the recognizer too.

**External gates:**

- live validation of `gemini-3.5-transcribe-live` against real audio;
- the audio-level provider comparison.

**Follow-up:** further recognizers (for example Soniox or Deepgram, or a local one) are one adapter each plus one entry
in the benchmark CLI.
