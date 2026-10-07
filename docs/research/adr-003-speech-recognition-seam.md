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
   - With the dedicated recognizer enabled, the terms - including identifiers, paths, branch names and issue numbers
     extracted from the conversation - are sent to it as its vocabulary. The conversation's sentences only rank terms
     and never leave the node.
   - A provider adapter translates the vocabulary into its own field. Gemini gets canonical spellings only, because
     biasing a recognizer towards a known mis-hearing would defeat the purpose.
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
   - Casing lowers a letter only to restore a code-like term heard exactly, case aside: `RedactSecrets` becomes
     `redactSecrets`, "PNPM verify" becomes `pnpm verify` and "Git stash" becomes `git stash`. Code-like means mixed
     case, a digit, code punctuation, or a command. A model name with a digit is therefore written as the vocabulary
     spells it: "GPT-4o" becomes `gpt-4o` when the vocabulary has `gpt-4o`. A tool is judged by its spelling, not its
     kind, because installed skill and extension names are often plain words (`test`, `review`, `weather`). An
     ordinary word starting a sentence ("Rebase", "Worktree", "Test", a skill called `deploy`, a proper noun such as
     ClarkCant beside a repository called `clarkcant`) keeps its capital, and so does `pnpm` on its own ("dùng PNPM"
     stays as heard). A lowercase tool name that is code-like only for a hyphen or a digit (`follow-up`, `check-in`,
     `s3`) can also be an ordinary word, so it is lowered only with the evidence a plain word needs: "Follow-up with
     the team tomorrow" and "S3 is down" keep their capitals, while "Daily-notes skill chạy lỗi khi build" becomes
     `daily-notes skill ...`. A near match is never re-cased.
   - Commands are never changed except by casing, and no respelled word may complete one with its neighbours ("git re
     base" stays as heard). Only case is restored: `npm` never becomes `pnpm`, even when the vocabulary has pnpm
     (#574).
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

## Evidence

`corepack pnpm --filter @clarkcant/voice-adapters bench:transcription` runs the scorer over
`packages/voice-adapters/bench/vi-en-coding-corpus.json`. The corpus holds 84 utterances (code-switched Vietnamese and
English with Vietnamese context, including twelve negative entries that must come back unchanged) and 105 technical
terms. Its recognizer outputs are simulated: they are typical live-transcription errors written by hand, not
recordings. No canonical reference is changed by the normaliser.

| Stage | WER | CER | Technical Term Error Rate | Exact (strict) | Exact (audio-tolerant) | Changes | Abstained | Regressions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| raw | 22.8% | 3.8% | 77.1% | 26.2% | 42.9% | - | - | - |
| normalized | 3.7% | 0.8% | 16.2% | 77.4% | 84.5% | 64 | 1 | 0 |

Strict exact compares whole utterances after collapsing whitespace. Audio-tolerant exact also ignores case anywhere in
the utterance and trailing `. , ! ? ; : …`; punctuation inside the utterance still counts. Because it folds case
everywhere, it also forgives identifier casing (`useeffect` for `useEffect`), which the case-sensitive Technical Term
Error Rate still counts. The real recognizers measured in #468 capitalise the first word and close the sentence, so
strict exact was 0% for each of them even where every word was right.

Commands and versions are never worse after normalisation (commands go from 9/14 to 11/14, versions stay 2/2); symbols
go from 1/21 to 18/21, paths from 3/9 to 8/9, acronyms from 0/9 to 9/9. The residuals are deliberate:

- `git stash` heard as `git status` is not corrected, because commands are never guessed;
- "git re base" is not completed into `git rebase`, for the same reason;
- "Jeff" is not rewritten to Jev, because it is also a person's name;
- `npm` is not rewritten to `pnpm`, and an ordinary word starting a sentence keeps its capital;
- "PNPM" on its own is not lowered to `pnpm`, because a plain word is never lowered; "PNPM verify" is;
- issue numbers are not rewritten;
- out-of-vocabulary names are left alone;
- English prose with no technical anchor is left alone;
- the ambiguous `voiceSession` / `voice_session` span abstains.

The same command with `--audio <manifest> --recognizer gemini-transcribe-live|gemini-live` recognizes real recordings
and scores them beside the corpus, reporting finalization latency. Repeat `--recognizer` to run several recognizers
over the same recordings and score them side by side in one table, each as `<id>-audio`. That run needs
`GEMINI_API_KEY`, and stops with an "external gate" message without one. `--transcripts` also prints every utterance's
transcript per recognizer, raw and normalized, beside the reference, and marks which exact measure each one meets.
The conventional separator works:
`corepack pnpm --filter @clarkcant/voice-adapters bench:transcription -- --transcripts`.

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
