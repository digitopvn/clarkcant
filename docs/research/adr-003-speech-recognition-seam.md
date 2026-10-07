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
   - A sentence the provider's ten-minute session limit cuts in half stays one utterance: the reopened session's
     reading is joined to what the closed one had heard, and audio said while reopening is held and sent on. If the
     session ended exactly as the sentence did and nothing more is said shortly after, the carried words are the whole
     sentence rather than the start of the next one.
   - A recognizer that cannot open within a bounded time, or fails mid-session, hands what it had not delivered back to
     the live transcription. The live reading is kept as the live session cut it, never split at a pause, and a cursor
     marks how far the recognizer delivered: a final moves it when its words are, in order and within a few characters,
     the beginning of what the live reading holds next, so a final may cover only the first part of a live utterance.
     Finals shorter than three words never move it, and a final whose live reading does not arrive soon expires. When the
     alignment is unclear, only the newest live sentence is answered. Every rule prefers answering words twice to losing
     them.
3. **A bounded, ranked, redacted session vocabulary.**
   - It is built on the node from:
     - projects;
     - the active manifest and branch;
     - symbols, paths and issues the conversation mentioned;
     - skills, extensions, and the current model and provider;
     - a built-in coding glossary with known mis-hearings as aliases.
   - Every term passes the shared `redactSecrets` and is dropped if redaction would touch it. No second set of secret
     patterns exists.
   - With the dedicated recognizer enabled, part of the vocabulary is sent to it (see below). The conversation's
     sentences only rank terms and never leave the node.
   - A provider adapter translates the vocabulary into its own field. Gemini gets canonical spellings only, because
     biasing a recognizer towards a known mis-hearing would defeat the purpose.
   - A recognizer's vocabulary is a bias, and a bias is a near-match made without evidence: measured on audio (issue
     #573), it wrote a listed term over a different word the person said. "Jeff" became `Jev`, "claude opus 3" became
     `claude-opus-4`, and `setUser` became `getUser` (and, with `getUser` withheld, `useState`). The transcription
     model takes no instruction that could limit this, and it reports no alternatives or confidence, so nothing after
     recognition can tell a substitution from what was said. The recognizer is therefore given only the kinds the
     normaliser itself near-matches - glossary words, providers and models:
     - a model id goes as its spoken family before the first numbered part (`claude-opus-4` as `claude-opus`), so the
       spelling is helped and the version is not chosen;
     - a short word that is not an acronym (`Jev`, `Pi`) is not sent, because real words and names sound like it;
     - symbols, paths, branches, packages, tools, commands and issues stay on the node. Their neighbours are other real
       names, and the normaliser restores their spelling only from an exact spoken form.
4. **A deterministic normaliser, not a model.**
   - The rules are casing, spacing, alias and one-edit near-match. Each needs evidence: Vietnamese in the sentence, or
     a technical anchor outside the span.
   - Near-match only corrects a spoken slip in one word of a glossary, provider or model name. It never reaches a
     symbol, path, branch or package, whose one-edit neighbours are other real names (`setUser` and `getUser`), never
     a word with a digit in it ("claude opus 3" is another version, not a slip of `claude-opus-4`), and never applies
     to text already written as code.
   - Part of a longer written word (`live` in `gemini-live.tsx`) is never touched, and punctuation a spelling carries
     is not written twice.
   - A real word or a person's name is never an alias: "Jeff" stays "Jeff".
   - Casing never lowers a letter.
   - Commands are never changed except by casing, and no respelled word may complete one with its neighbours ("git re
     base" stays as heard).
   - A span that could be two terms is left as heard, and the abstention is recorded.
   - A canonical sentence comes back exactly as it is. The benchmark checks this on every reference, including negative
     entries built from near neighbours, embedded names, a person's name and other model versions.
   - Each change is recorded as bounded provenance.
5. **Settle once, and retry deliberately.**
   - A final utterance is settled on an ordered queue and dispatched once per utterance id, through the same `ask`
     path a live transcript takes. Approvals, questions, app intents and widget actions therefore see the canonical
     text.
   - An ambiguous or low-confidence technical span may have that one utterance recognized again from its own bounded
     audio buffer, with a context focused on the candidates.
   - The readings are compared by a fixed rule. The original wins ties, and so does any retry that heard a different
     sentence.
   - The retry is bounded in time, and a retry past its bound is aborted, closing the session it opened. No
     transcript is sent to Jev, which decides between bounded options and is not a transcript rewriter.

## Why the dedicated recognizer is not the default yet

Which recognizer hears Vietnamese–English coding speech best is an empirical question. This environment cannot answer
it without audio and a key, so the benchmark harness exists to answer it. Until an audio run says otherwise, the
default stays the path that already works. The normaliser improves that path as well: on the text corpus below, the
live baseline gains most of what normalisation can give. A provider picker in the interface would ask the person to
make a decision they cannot evaluate, so there is none.

Vocabulary bias is a second reason. A recognizer that writes a listed term over what was said sends a wrong model
version or a wrong symbol to Clark as if the person had said it, one layer before the normaliser's guarantees apply.
The narrowed vocabulary above removes the cases measured so far, at a cost: identifiers the vocabulary used to carry
are now heard unaided (see the audio check below). The recognizer stays opt-in until an audio run on real speech shows
both no substitutions and an accuracy worth that trade.

## Evidence

`corepack pnpm --filter @clarkcant/voice-adapters bench:transcription` runs the scorer over
`packages/voice-adapters/bench/vi-en-coding-corpus.json`. The corpus holds 76 utterances (code-switched Vietnamese and
English with Vietnamese context, including eight negative entries that must come back unchanged) and 100 technical
terms. Its recognizer outputs are simulated: they are typical live-transcription errors written by hand, not
recordings. No canonical reference is changed by the normaliser.

| Stage | WER | CER | Technical Term Error Rate | Exact utterances | Changes | Abstained | Regressions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| raw | 24.9% | 4.2% | 77.0% | 23.7% | - | - | - |
| normalized | 4.0% | 0.9% | 16.0% | 76.3% | 61 | 1 | 0 |

Commands and versions are never worse after normalisation (9/12 and 2/2 both before and after); symbols go from 1/20 to
17/20, paths from 3/9 to 8/9, acronyms from 0/9 to 9/9. The residuals are deliberate:

- `git stash` heard as `git status` is not corrected, because commands are never guessed;
- "git re base" is not completed into `git rebase`, for the same reason;
- "Jeff" is not rewritten to Jev, because it is also a person's name;
- issue numbers are not rewritten;
- out-of-vocabulary names are left alone;
- English prose with no technical anchor is left alone;
- the ambiguous `voiceSession` / `voice_session` span abstains.

The same command with `--audio <manifest> --recognizer gemini-transcribe-live|gemini-live` recognizes real recordings
and scores them beside the corpus, reporting finalization latency. That run needs `GEMINI_API_KEY`, and stops with an
"external gate" message without one. It also reports every utterance whose recognized text holds a session term the
person did not say, and exits with status 3 when there is one. The corpus marks three entries `vocabulary-bias` (a
person's name, another model version, a near-neighbour symbol), and the run names any of them the manifest left
unrecorded.

**Audio check of the vocabulary bias, 2026-10-07.** Synthetic speech (Gemini TTS in a Vietnamese developer's voice,
not human recordings) of the three `vocabulary-bias` entries and six ordinary ones, each recognized twice by
`gemini-3.5-transcribe-live` with the corpus vocabulary:

| Vocabulary sent | Substitutions on the 3 bias entries | Ordinary entries with every term right |
| --- | --- | --- |
| every ranked term (before #573) | 6 of 6 runs | 12 of 12 runs |
| glossary, providers, model families (now) | 0 of 6 runs | 8 of 12 runs |

With the narrowed vocabulary, `redactSecrets` was heard as "Redux Secrets" and `@clarkcant/voice-adapters` as
"@clack/voice adapters" in both runs. Both are visible mis-hearings rather than another real name. The sample is
small (n=2), synthetic and not a measure of real speech.

## Consequences

**Kept:**

- `VoiceProviderAdapter`, `GeminiLiveAdapter` and the default live path;
- the wire to the browser: interims are ordinary non-final user `transcript` frames, and a canonical sentence is a
  final one. The page's fold settles the line in progress with its final, so an interim and its correction are one
  line;
- mute and end, which now reach the recognizer too (a mute also finalizes the sentence before it). Media focus is
  unchanged and does not involve the recognizer.

**Default path:** the normaliser runs on the default live transcription as well, against the same session vocabulary.
Without the dedicated recognizer nothing is sent anywhere new: the vocabulary stays on the node.

**External gates:**

- live validation of `gemini-3.5-transcribe-live` against real audio;
- the audio-level provider comparison.

**Follow-up:** further recognizers (for example Soniox or Deepgram, or a local one) are one adapter each plus one entry
in the benchmark CLI.
