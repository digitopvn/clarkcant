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
