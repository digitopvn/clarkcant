import { z } from "zod";

import { instantSchema, sequenceSchema } from "./primitives.ts";
import { actionProposalSchema, semanticViewSchema } from "./widgets.ts";

/**
 * Voice and media coordination.
 *
 * Two rules keep voice from becoming a second, unaudited control path:
 *
 * 1. Voice produces the same intents as typing. A spoken correction changes a
 *    task revision; it does not start a parallel task. Barge-in yields audio
 *    only, and deliberately does not cancel the job (acceptance test T64).
 * 2. Microphone, camera, and speaker have exactly one owner at a time, decided
 *    by an explicit focus service. Nothing silently listens.
 *
 * The provider is an adapter, never the source of truth: app state is durable,
 * the voice session is not.
 */

export const voiceStateSchema = z.enum([
  "idle",
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "reconnecting",
  "ended",
  "failed",
]);
export type VoiceState = z.infer<typeof voiceStateSchema>;

/**
 * Who currently controls a media device.
 *
 * `duck` and `pause` are separate because lowering volume for an assistant is a
 * very different act from muting a call participant.
 */
export const mediaOwnerKindSchema = z.enum([
  "assistant-voice",
  "media-playback",
  "call",
  "other-widget",
]);
export type MediaOwnerKind = z.infer<typeof mediaOwnerKindSchema>;

export const mediaFocusStateSchema = z.strictObject({
  microphoneOwner: mediaOwnerKindSchema.optional(),
  cameraOwner: mediaOwnerKindSchema.optional(),
  speakerOwners: z.array(mediaOwnerKindSchema).max(8),
  /** Whether the assistant voice is currently ducked by another owner. */
  ducked: z.boolean(),
  /** Set when a request was refused, so the UI can explain rather than go quiet. */
  conflictOwner: mediaOwnerKindSchema.optional(),
  /** User has explicitly muted assistant capture. Local, not model-controlled. */
  assistantMuted: z.boolean(),
});
export type MediaFocusState = z.infer<typeof mediaFocusStateSchema>;

export type FocusRequest = {
  owner: MediaOwnerKind;
  device: "microphone" | "camera" | "speaker";
  /** Whether this owner is willing to share, and how. */
  intent: "exclusive" | "share-ducked" | "background";
};

export type FocusDecision =
  | { granted: true; resulting: MediaFocusState }
  | { granted: false; code: "MEDIA_FOCUS_CONFLICT"; heldBy: MediaOwnerKind; message: string };

/**
 * Decide media focus.
 *
 * Microphone and camera are exclusive: two owners of a live microphone is the
 * failure mode this exists to prevent. Speaker access is shareable because
 * ducking is a legitimate answer, and a call and an assistant both playing audio
 * is a real user situation rather than a bug.
 */
export function requestMediaFocus(
  current: MediaFocusState,
  request: FocusRequest,
): FocusDecision {
  if (request.device === "speaker") {
    if (request.intent === "exclusive" && current.speakerOwners.length > 0) {
      const holder = current.speakerOwners[0];
      if (holder !== undefined && holder !== request.owner) {
        return {
          granted: false,
          code: "MEDIA_FOCUS_CONFLICT",
          heldBy: holder,
          message: `speaker is already owned by ${holder}`,
        };
      }
    }
    const owners = current.speakerOwners.includes(request.owner)
      ? current.speakerOwners
      : [...current.speakerOwners, request.owner];
    return {
      granted: true,
      resulting: {
        ...current,
        speakerOwners: owners,
        ducked: owners.length > 1,
      },
    };
  }

  const field = request.device === "microphone" ? "microphoneOwner" : "cameraOwner";
  const holder = current[field];

  if (request.device === "microphone" && current.assistantMuted && request.owner === "assistant-voice") {
    return {
      granted: false,
      code: "MEDIA_FOCUS_CONFLICT",
      heldBy: "assistant-voice",
      message: "assistant capture is muted by the user; unmute is a local control",
    };
  }

  if (holder !== undefined && holder !== request.owner && request.intent === "exclusive") {
    return {
      granted: false,
      code: "MEDIA_FOCUS_CONFLICT",
      heldBy: holder,
      message: `${request.device} is already owned by ${holder}`,
    };
  }

  const backgroundOnly = request.intent === "background" && holder !== undefined && holder !== request.owner;
  if (backgroundOnly) {
    return {
      granted: false,
      code: "MEDIA_FOCUS_CONFLICT",
      heldBy: holder,
      message: `${request.owner} may not take ${request.device} in background mode while ${holder} owns it`,
    };
  }

  return {
    granted: true,
    resulting: { ...current, [field]: request.owner },
  };
}

/**
 * Release a device. Muting and ending must actually stop the transport, so this
 * returns the state the caller must apply rather than just bookkeeping.
 */
export function releaseMediaFocus(
  current: MediaFocusState,
  release: { owner: MediaOwnerKind; device: "microphone" | "camera" | "speaker" },
): MediaFocusState {
  if (release.device === "speaker") {
    const owners = current.speakerOwners.filter((owner) => owner !== release.owner);
    return { ...current, speakerOwners: owners, ducked: owners.length > 1 };
  }
  const field = release.device === "microphone" ? "microphoneOwner" : "cameraOwner";
  if (current[field] !== release.owner) return current;
  const next: MediaFocusState = { ...current };
  delete next[field];
  return next;
}

/* ------------------------------------------------------------------ *
 * Transcript and intents
 * ------------------------------------------------------------------ */

/**
 * A transcript fragment.
 *
 * Partial results from a streaming recogniser arrive out of order and repeat.
 * `utteranceId` plus `fragmentIndex` lets the correlator assemble one utterance
 * from many fragments without duplicating text, which is a precondition for
 * "corrected myself" being one task revision rather than two tasks.
 */
export const voiceTranscriptFragmentSchema = z.strictObject({
  voiceSessionId: z.string().min(1).max(128),
  utteranceId: z.string().min(1).max(128),
  fragmentIndex: z.int().nonnegative(),
  isFinal: z.boolean(),
  text: z.string().max(8000),
  /** Role of the speaker, so assistant audio is never re-ingested as user input. */
  role: z.enum(["user", "assistant", "system"]),
  confidence: z.number().min(0).max(1).optional(),
  at: instantSchema,
  sequence: sequenceSchema,
});
export type VoiceTranscriptFragment = z.infer<typeof voiceTranscriptFragmentSchema>;

export type AssemblyResult = {
  text: string;
  duplicateFragments: number;
  complete: boolean;
};

/**
 * Assemble an utterance from fragments.
 *
 * Fragments are keyed by index and the highest `isFinal` wins, so a late
 * non-final fragment cannot overwrite a final one and a replayed fragment cannot
 * duplicate text.
 */
export function assembleUtterance(
  fragments: readonly VoiceTranscriptFragment[],
): AssemblyResult {
  const byIndex = new Map<number, VoiceTranscriptFragment>();
  let duplicates = 0;

  for (const fragment of fragments) {
    const existing = byIndex.get(fragment.fragmentIndex);
    if (!existing) {
      byIndex.set(fragment.fragmentIndex, fragment);
      continue;
    }
    duplicates += 1;
    if (!existing.isFinal && fragment.isFinal) {
      byIndex.set(fragment.fragmentIndex, fragment);
    }
  }

  const ordered = [...byIndex.values()].sort((a, b) => a.fragmentIndex - b.fragmentIndex);
  const contiguous = ordered.every((fragment, index) => fragment.fragmentIndex === index);

  return {
    text: ordered.map((fragment) => fragment.text).join(""),
    duplicateFragments: duplicates,
    // An utterance is complete when the last fragment is final and the indices are
    // contiguous. Earlier fragments staying non-final is normal for a streaming
    // recogniser: the final one closes the utterance, and requiring every fragment to be
    // final would make a completed utterance look permanently partial.
    complete: ordered.length > 0 && ordered[ordered.length - 1]!.isFinal && contiguous,
  };
}

/**
 * How a utterance relates to the task that is already running.
 *
 * This mapping is the whole reason voice is not a parallel control plane.
 * `barge-in` changes audio only; the running job keeps going. `correction`
 * produces a new task revision. `cancel` is the only one that stops work.
 */
export const voiceIntentKindSchema = z.enum([
  "new-task",
  "correction",
  "barge-in",
  "status-question",
  "cancel",
  "widget-action",
  "acknowledgement",
]);
export type VoiceIntentKind = z.infer<typeof voiceIntentKindSchema>;

export const voiceIntentSchema = z.strictObject({
  intentId: z.string().min(1).max(128),
  voiceSessionId: z.string().min(1).max(128),
  utteranceId: z.string().min(1).max(128),
  kind: voiceIntentKindSchema,
  /** Task this intent relates to, when the utterance referenced current work. */
  taskId: z.string().min(1).max(128).optional(),
  /** Revision the speaker believed was current. */
  expectedTaskRevision: z.int().nonnegative().optional(),
  text: z.string().min(1).max(8000),
  /** For widget actions, the same proposal shape a click would produce. */
  actionProposal: actionProposalSchema.optional(),
  /** Semantic view of the focused instance, so voice and click agree. */
  focusedSurface: semanticViewSchema.optional(),
  at: instantSchema,
});
export type VoiceIntent = z.infer<typeof voiceIntentSchema>;

export type IntentRouting =
  | { effect: "audio-only"; cancelsJob: false; createsTaskRevision: false }
  | { effect: "new-task"; cancelsJob: false; createsTaskRevision: false }
  | { effect: "task-revision"; cancelsJob: false; createsTaskRevision: true }
  | { effect: "cancel-task"; cancelsJob: true; createsTaskRevision: false }
  | { effect: "status-answer"; cancelsJob: false; createsTaskRevision: false }
  | { effect: "widget-invocation"; cancelsJob: false; createsTaskRevision: false };

/**
 * Route a voice intent.
 *
 * `barge-in` deliberately does not cancel anything: interrupting the assistant's
 * audio is a conversational act, not a stop button. Only an explicit cancel
 * stops a job, and that is asserted by acceptance test T64.
 */
export function routeVoiceIntent(intent: VoiceIntent): IntentRouting {
  switch (intent.kind) {
    case "barge-in":
      return { effect: "audio-only", cancelsJob: false, createsTaskRevision: false };
    case "acknowledgement":
      return { effect: "audio-only", cancelsJob: false, createsTaskRevision: false };
    case "new-task":
      return { effect: "new-task", cancelsJob: false, createsTaskRevision: false };
    case "correction":
      return { effect: "task-revision", cancelsJob: false, createsTaskRevision: true };
    case "cancel":
      return { effect: "cancel-task", cancelsJob: true, createsTaskRevision: false };
    case "status-question":
      return { effect: "status-answer", cancelsJob: false, createsTaskRevision: false };
    case "widget-action":
      return { effect: "widget-invocation", cancelsJob: false, createsTaskRevision: false };
  }
}

/**
 * Whether a text fallback is required.
 *
 * Voice is never the only path: if the provider is unreachable the transcript
 * panel and composer stay usable, and the UI says so instead of appearing to
 * listen.
 */
export function voiceFallbackRequired(state: VoiceState): { required: boolean; message: string } {
  if (state === "failed" || state === "reconnecting") {
    return {
      required: true,
      message:
        "live voice is unavailable; the transcript and text composer still work and no audio is being captured",
    };
  }
  return { required: false, message: "" };
}

/**
 * Barge-in timing target.
 *
 * The blueprint sets a local playback stop target of 150 ms after detected
 * onset, measured separately from detection latency. Reporting both numbers is
 * required; quoting only the total would hide which half is slow.
 */
export const voiceTimingSchema = z.strictObject({
  onsetDetectedAtMs: z.number().nonnegative(),
  playbackStoppedAtMs: z.number().nonnegative(),
  detectionLatencyMs: z.number().nonnegative().optional(),
  replyFirstAudioMs: z.number().nonnegative().optional(),
});
export type VoiceTiming = z.infer<typeof voiceTimingSchema>;

/**
 * One voice a provider offers.
 *
 * `id` is the provider's own name for it — `Kore`, in Gemini's case — and it is a value this
 * application passes back rather than interprets. `label` is what a surface shows; keeping them
 * separate is what lets a provider change its display name without the stored preference moving.
 */
export const voiceOptionSchema = z.strictObject({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
  /** BCP-47 tag, when the provider states one. Absent means the provider did not say. */
  locale: z.string().min(1).max(35).optional(),
  /** How the provider describes it, when it describes it at all. Never invented here. */
  description: z.string().min(1).max(300).optional(),
});
export type VoiceOption = z.infer<typeof voiceOptionSchema>;

/**
 * What a voice provider can actually do.
 *
 * The provider owns this, and the surface renders only what it says. That is the whole point of the
 * contract: a picker hard-coded with one provider's voice names would offer a list to a provider that
 * has never heard of them, and the failure would arrive as a session that connects and then says
 * nothing.
 *
 * `supportsVoiceSelection: false` is a real answer with a real consequence: the surface shows no
 * selector, or one that is disabled with the reason, rather than a control that changes nothing.
 */
export const voiceCapabilitiesSchema = z.strictObject({
  /** The provider's own id, so a surface can say which provider is answering. */
  provider: z.string().min(1).max(120),
  supportsVoiceSelection: z.boolean(),
  /** Empty when the provider does not support selection, or when it supports it but offers nothing. */
  voices: z.array(voiceOptionSchema).max(200),
  /**
   * Whether a short spoken sample can be produced before a session is opened.
   *
   * Separate from selection because they are separate abilities: a provider may accept a voice name
   * at connect and still have no way to say one sentence without opening a full session.
   */
  supportsPreview: z.boolean(),
  /** Why a capability is off, when it is. Shown beside the control rather than hidden. */
  note: z.string().max(300).optional(),
});
export type VoiceCapabilities = z.infer<typeof voiceCapabilitiesSchema>;

/* ------------------------------------------------------------------ *
 * Speech recognition: the ears, separate from the mouth
 * ------------------------------------------------------------------ */

/**
 * The most terms a recognition context carries.
 *
 * Bounded on purpose: the context is derived from the person's working state, and the whole repository is never
 * what a recognizer should be biased towards. A hundred is also where the first dedicated provider documents its
 * best results, which is a measured ceiling rather than one chosen for taste.
 */
export const MAX_RECOGNITION_TERMS = 100;
/** Longest term kept. A longer one is a sentence or a blob, and neither is vocabulary. */
export const MAX_RECOGNITION_TERM_LENGTH = 80;

/** A BCP-47 tag as a recognizer reports or accepts it. Loose on purpose: providers disagree on region casing. */
const languageTagSchema = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u);

/**
 * Where a term came from.
 *
 * `command` is separate from `glossary` because a command can have an effect: a recognizer may be biased towards
 * one, but the normaliser never rewrites a near miss into one (`git status` and `git stash` are both commands, and a
 * guess between them is a guess about what runs).
 */
export const recognitionTermKindSchema = z.enum([
  "repository",
  "package",
  "path",
  "branch",
  "symbol",
  "issue",
  "tool",
  "model",
  "provider",
  "command",
  "glossary",
]);
export type RecognitionTermKind = z.infer<typeof recognitionTermKindSchema>;

export const recognitionTermSchema = z.strictObject({
  /** The canonical spelling: what the conversation should read when this term was said. */
  text: z.string().min(1).max(MAX_RECOGNITION_TERM_LENGTH),
  kind: recognitionTermKindSchema,
  /**
   * Known mis-hearings that map to this term and to nothing else, such as "stale closer" for "stale closure".
   *
   * Deterministic and short: an alias is a fact about how one term is misheard, not a rewrite rule for sentences.
   */
  aliases: z.array(z.string().min(1).max(MAX_RECOGNITION_TERM_LENGTH)).max(8).optional(),
  /** Relevance to the current session, 0 to 1. Ordering, not confidence. */
  weight: z.number().min(0).max(1),
});
export type RecognitionTerm = z.infer<typeof recognitionTermSchema>;

/**
 * What a recognizer may be told about the person's working context.
 *
 * Provider-neutral: each adapter translates it into its own vocabulary or keyterm field. Every term has already
 * passed the shared secret redaction before it is placed here, because some recognizers are external services.
 *
 * `languageHints` are hints and never a lock. A Vietnamese sentence carrying English technical words is the normal
 * case this exists for, and a recognizer locked to one language rewrites the other one.
 */
export const recognitionContextSchema = z.strictObject({
  version: z.literal(1),
  languageHints: z.array(languageTagSchema).max(4),
  terms: z.array(recognitionTermSchema).max(MAX_RECOGNITION_TERMS),
});
export type RecognitionContext = z.infer<typeof recognitionContextSchema>;

/** A stretch of an utterance the recognizer scored, as character offsets into `text`. */
export const recognitionSpanSchema = z.strictObject({
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
  confidence: z.number().min(0).max(1),
  /** The language the recognizer heard in this span, when it says. */
  language: languageTagSchema.optional(),
});
export type RecognitionSpan = z.infer<typeof recognitionSpanSchema>;

/**
 * One utterance as a recognizer reports it.
 *
 * An interim result is a hypothesis that replaces the one before it for the same `utteranceId`; `revision` orders
 * them. Only a final result can become a message, and a final result for an utterance that was already settled is a
 * duplicate rather than a second sentence.
 */
export const recognizedUtteranceSchema = z.strictObject({
  voiceSessionId: z.string().min(1).max(128),
  utteranceId: z.string().min(1).max(128),
  revision: z.int().nonnegative(),
  isFinal: z.boolean(),
  text: z.string().max(8000),
  /** Languages the recognizer detected, most dominant first. Absent when it does not say. */
  languages: z.array(languageTagSchema).max(4).optional(),
  /** Whole-utterance confidence, when the provider reports one. Never invented. */
  confidence: z.number().min(0).max(1).optional(),
  /** Span confidence, when the provider reports it. */
  spans: z.array(recognitionSpanSchema).max(128).optional(),
  /**
   * How the utterance was closed. `provider` is the recognizer's own end of utterance; `session-end` is the last
   * hypothesis kept because the connection ended before the recognizer finished it, which is better than losing a
   * sentence that was heard.
   */
  settledBy: z.enum(["provider", "session-end"]).optional(),
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(120),
  /** Whether a recognition context was applied to the session that produced this. */
  contextApplied: z.boolean(),
  at: instantSchema,
  sequence: sequenceSchema,
});
export type RecognizedUtterance = z.infer<typeof recognizedUtteranceSchema>;

/**
 * What a recognizer can do, as it reports it.
 *
 * `contextUpdate` is the honest answer to "can the vocabulary change mid-session": `live` applies at once,
 * `next-connection` applies when the recognizer next connects, and `none` never.
 */
export const speechRecognitionCapabilitiesSchema = z.strictObject({
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(120),
  interimResults: z.boolean(),
  languageDetection: z.boolean(),
  confidence: z.enum(["none", "utterance", "span"]),
  vocabulary: z.boolean(),
  maxVocabularyTerms: z.int().nonnegative().max(MAX_RECOGNITION_TERMS),
  contextUpdate: z.enum(["none", "next-connection", "live"]),
  /** Whether a completed utterance's audio can be recognized again on its own. */
  utteranceRetry: z.boolean(),
});
export type SpeechRecognitionCapabilities = z.infer<typeof speechRecognitionCapabilitiesSchema>;

/** Most normalisation changes recorded for one utterance. More than this is itself a sign to stop correcting. */
export const MAX_NORMALIZATION_CHANGES = 32;

/**
 * One deterministic change the transcript normaliser made.
 *
 * Recorded so the canonical text can always be explained: what was heard, what it became, and by which rule.
 */
export const transcriptNormalizationChangeSchema = z.strictObject({
  from: z.string().min(1).max(MAX_RECOGNITION_TERM_LENGTH * 2),
  to: z.string().min(1).max(MAX_RECOGNITION_TERM_LENGTH),
  rule: z.enum(["casing", "spacing", "alias", "near-match"]),
  kind: recognitionTermKindSchema,
});
export type TranscriptNormalizationChange = z.infer<typeof transcriptNormalizationChangeSchema>;

/**
 * Bounded provenance for one settled utterance.
 *
 * Diagnostics, not a second transcript store: it says which recognizer produced the words, how sure it was, what was
 * normalised and whether the utterance was re-recognized - and it never carries audio. The canonical text itself is
 * the conversation message and lives there.
 */
export const recognitionProvenanceSchema = z.strictObject({
  utteranceId: z.string().min(1).max(128),
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(120),
  contextApplied: z.boolean(),
  termCount: z.int().nonnegative().max(MAX_RECOGNITION_TERMS),
  languages: z.array(languageTagSchema).max(4).optional(),
  confidence: z
    .strictObject({
      utterance: z.number().min(0).max(1).optional(),
      lowestSpan: z.number().min(0).max(1).optional(),
      lowSpans: z.int().nonnegative(),
    })
    .optional(),
  normalization: z.array(transcriptNormalizationChangeSchema).max(MAX_NORMALIZATION_CHANGES),
  /** Technical spans the normaliser saw more than one reading for and left as heard. */
  abstained: z.int().nonnegative(),
  retry: z
    .strictObject({
      reason: z.enum(["low-confidence-technical-span", "ambiguous-technical-span"]),
      outcome: z.enum(["kept-original", "used-retry", "unavailable", "failed"]),
    })
    .optional(),
  /** Time from the final result to the canonical text, which is the latency the normaliser and a retry add. */
  settleMs: z.number().nonnegative().optional(),
});
export type RecognitionProvenance = z.infer<typeof recognitionProvenanceSchema>;
