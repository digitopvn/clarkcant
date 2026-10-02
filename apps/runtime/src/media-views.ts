import {
  ARTIFACT_LIMITS,
  ATTACHMENT_LIMITS,
  type AudioMimeType,
  type MediaPolicy,
  type MediaRefusal,
  MEDIA_CONTENT_LIMITS,
  SNAPSHOT_TEXT_LIMIT,
  type Instant,
  EMPTY_MEDIA_POLICY,
  clipWithMarker,
  parseMediaPolicy,
  hostFileRef,
  isDocumentMimeType,
  markHiddenCharacters,
  mediaRefusal,
  normalizeAudioType,
  paginateDocumentText,
  redactSecrets,
  stripBidiControls,
} from "@clarkcant/contracts";
import { type WidgetDeps, placeInstance } from "@clarkcant/core";
import { AUDIO, DOCUMENT } from "@clarkcant/data-canvas";
import {
  type Database,
  blobStillReferenced,
  getAttachment,
  getBrokerArtifact,
  insertBrokerArtifact,
  putArtifactGrant,
} from "@clarkcant/storage";
import { definitionDigest, validateProps } from "@clarkcant/widget-host";

import { join } from "node:path";

import { storedBytesForPrincipal } from "./artifact-broker.ts";
import { blobsDir, readBlob, removeBlob, writeBlob } from "./blobs.ts";
import { type FetchedAudio, checkAudioBytes, fetchAudio } from "./media-fetch.ts";
import type { ViewDescriptor, ViewRequest } from "./model-turn.ts";
import { countPdfPages, extractPdfText } from "./pdf-text.ts";
import { keptText, mediaViewBinding } from "./view-catalog.ts";

/**
 * The audio player and the document preview, as a model places them.
 *
 * Both take a source the node can vouch for and nothing the page would have to fetch: a model names an ArtifactRef or
 * an attachment from this conversation, or for audio an https URL the node's media policy allows. The node reads the
 * bytes, holds them to the media content policy, and stores what the renderer needs — a host reference, the type, the
 * duration, or a document's text already split into pages. Anything the node fills in is refused when a model supplies
 * it, so a placed widget never claims a type or a length nobody checked.
 */

export interface MediaViewDeps {
  dataDir: string;
  /** Read on every placement, so a changed setting applies to the next one. */
  policy: () => MediaPolicy;
  /** The fetch, replaced in tests; defaults to `fetchAudio` under the policy. */
  fetchAudio?: (url: string, policy: MediaPolicy, signal: AbortSignal | undefined) => Promise<FetchedAudio | MediaRefusal>;
}

/**
 * The node's media policy from `CC_MEDIA_ORIGINS`, a comma-separated list of https origins.
 *
 * Unset is the default and allows nothing. A setting that cannot be read allows nothing either, and says why once at
 * startup: an operator who mistyped an origin should learn it from the node rather than from every refused placement.
 */
export function mediaPolicyFromEnv(env: NodeJS.ProcessEnv, report: (line: string) => void): MediaPolicy {
  const parsed = parseMediaPolicy(env.CC_MEDIA_ORIGINS);
  if (!parsed.ok) {
    report(`media policy: CC_MEDIA_ORIGINS was not used, so no origin is allowed: ${parsed.problems.join("; ")}\n`);
    return EMPTY_MEDIA_POLICY;
  }
  if (parsed.policy.origins.length > 0) report(`media policy: audio may be fetched from ${parsed.policy.origins.join(", ")}\n`);
  return parsed.policy;
}

/** A source this conversation holds: its bytes, the type the node recorded for it, and the name it goes by. */
interface HeldSource {
  ref: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

const AUDIO_INPUT_KEYS = new Set(["title", "artifactId", "attachmentId", "url", "transcript"]);
const DOCUMENT_INPUT_KEYS = new Set(["title", "artifactId", "attachmentId"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function refuse(definitionId: string, refusal: MediaRefusal | string): never {
  throw new Error(`${definitionId} cannot be shown: ${typeof refusal === "string" ? refusal : refusal.message}`);
}

function checkKeys(definitionId: string, props: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(props).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    refuse(
      definitionId,
      `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not something a model sets; name the source (${[...allowed].join(", ")}) and the node reads the type, size and length from the file`,
    );
  }
}

/** Exactly one of the sources, as a model named it. */
function oneSource(definitionId: string, props: Record<string, unknown>, keys: readonly string[]): { key: string; value: string } {
  const named = keys.filter((key) => props[key] !== undefined);
  if (named.length !== 1) refuse(definitionId, mediaRefusal("source", `name exactly one source: ${keys.join(", ")}`));
  const key = named[0] as string;
  const value = props[key];
  if (typeof value !== "string" || value.trim() === "") refuse(definitionId, mediaRefusal("source", `${key} must be a non-empty string`));
  if (key !== "url" && !ID_PATTERN.test(value)) refuse(definitionId, mediaRefusal("source", `${key} is not an id this node issues`));
  return { key, value };
}

/**
 * Read a file this conversation holds, for the person who placed the widget.
 *
 * One answer for absent, someone else's, another conversation's and unsealed, as the content routes give: the
 * difference would let a model ask which ids exist.
 */
function heldSource(db: Database, dataDir: string, request: ViewRequest, source: { key: string; value: string }): HeldSource | MediaRefusal {
  const missing = mediaRefusal("not-found", `there is no file with that ${source.key} in this conversation`);
  if (source.key === "artifactId") {
    const record = getBrokerArtifact(db, source.value);
    if (
      record === undefined ||
      record.ownerPrincipalId !== request.principal.principalId ||
      record.conversationId !== request.conversationId ||
      record.state !== "sealed" ||
      record.blobPath === undefined
    ) {
      return missing;
    }
    const blob = readBlob({ dataDir, blobPath: record.blobPath });
    if (!blob.ok) return mediaRefusal("not-found", blob.message);
    return { ref: hostFileRef("artifact", record.artifactId), name: record.name, mimeType: record.mimeType, bytes: blob.bytes };
  }
  const record = getAttachment(db, source.value, request.principal.principalId);
  if (record === undefined || record.conversationId !== request.conversationId) return missing;
  const blob = readBlob({ dataDir, blobPath: join(blobsDir(dataDir), record.blobPath.split(/[/\\]/).at(-1) ?? "") });
  if (!blob.ok) return mediaRefusal("not-found", blob.message);
  return { ref: hostFileRef("attachment", record.attachmentId), name: record.filename, mimeType: record.mime, bytes: blob.bytes };
}

/** Code points in UTF-8 bytes, counted without decoding: every byte that does not continue a sequence starts one. */
function utf8CodePoints(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if ((byte & 0xc0) !== 0x80) count += 1;
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 1 : 0;
  return count - bom;
}

/** Bounds the media props schemas set, checked before work that would only be refused afterwards. */
const MAX_AUDIO_TITLE = 200;
const MAX_DOCUMENT_NAME = 255;
const MAX_SOURCE_PAGES = 100_000;

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${String(minutes)}:${String(whole % 60).padStart(2, "0")}`;
}

function surface(definition: typeof AUDIO, snapshot: ReturnType<typeof placeInstance>["snapshot"]) {
  return { type: "surface" as const, definitionRef: { id: definition.id, version: definition.version }, snapshot };
}

export function audioView(deps: WidgetDeps, media: MediaViewDeps): ViewDescriptor {
  return {
    id: AUDIO.id,
    label: AUDIO.semanticDescription,
    notes:
      `props.title names the audio. Name exactly one source: props.artifactId or props.attachmentId (a file in this conversation), ` +
      `or props.url, an https URL on an origin this node's media policy allows (none unless the operator named some). ` +
      `An optional props.transcript (at most ${String(MEDIA_CONTENT_LIMITS.maxTranscriptChars)} characters) is shown beside the player. ` +
      `The node fetches and checks the file: mp3, ogg, wav or webm, at most ${String(MEDIA_CONTENT_LIMITS.maxAudioBytes)} bytes and ` +
      `${String(MEDIA_CONTENT_LIMITS.maxAudioSeconds)} seconds. It never plays by itself.`,
    shownText: `Shown: ${AUDIO.id}. The person presses play; the host keeps where they paused.`,
    build: async (request) => {
      const props = request.props;
      checkKeys(AUDIO.id, props, AUDIO_INPUT_KEYS);
      const title = typeof props.title === "string" ? props.title.trim() : "";
      if (title === "") refuse(AUDIO.id, "props.title names the audio and is required");
      const transcript = props.transcript;
      if (transcript !== undefined && typeof transcript !== "string") refuse(AUDIO.id, "props.transcript must be text");
      // Props the fetch cannot change are checked before anything is fetched.
      if (Array.from(title).length > MAX_AUDIO_TITLE) refuse(AUDIO.id, `props.title is longer than ${String(MAX_AUDIO_TITLE)} characters`);
      if (typeof transcript === "string" && transcript.length > MEDIA_CONTENT_LIMITS.maxTranscriptChars) {
        refuse(AUDIO.id, `props.transcript is longer than ${String(MEDIA_CONTENT_LIMITS.maxTranscriptChars)} characters`);
      }
      const source = oneSource(AUDIO.id, props, ["artifactId", "attachmentId", "url"]);

      let audio: FetchedAudio;
      let audioRef: string;
      let fetched: { artifactId: string; blobPath: string; digest: string } | undefined;
      if (source.key === "url") {
        const result = await (media.fetchAudio ?? ((url, policy, signal) => fetchAudio(url, { policy }, signal)))(source.value, media.policy(), request.signal);
        if (!result.ok) refuse(AUDIO.id, result);
        audio = result;
        if (request.signal?.aborted === true) refuse(AUDIO.id, "the turn was stopped before the audio was placed");
        const used = storedBytesForPrincipal(deps.db, request.principal.principalId);
        if (used + audio.bytes.byteLength > ATTACHMENT_LIMITS.principalQuotaBytes) {
          refuse(AUDIO.id, "the person's storage on this node is full, so the audio was not stored");
        }
        const extension = audio.mimeType === "audio/mpeg" ? "mp3" : audio.mimeType.slice("audio/".length);
        const written = writeBlob({ dataDir: media.dataDir, bytes: audio.bytes, extension });
        fetched = { artifactId: deps.newId("art"), blobPath: written.blobPath, digest: written.digest };
        audioRef = hostFileRef("artifact", fetched.artifactId);
      } else {
        const held = heldSource(deps.db, media.dataDir, request, source);
        if (!("bytes" in held)) refuse(AUDIO.id, held);
        const declared = normalizeAudioType(held.mimeType);
        if (declared === undefined) {
          refuse(AUDIO.id, mediaRefusal("type-not-allowed", `that file is ${held.mimeType}, not an audio type this node plays (mp3, ogg, wav or webm)`));
        }
        const checked = checkAudioBytes(held.bytes, declared, "node");
        if (!checked.ok) refuse(AUDIO.id, checked);
        audio = checked;
        audioRef = held.ref;
      }

      const stored: Record<string, unknown> = {
        title,
        audioRef,
        mimeType: audio.mimeType,
        // Tenths of a second: enough to say how long it plays, without a float's noise.
        durationSeconds: Math.round(audio.durationSeconds * 10) / 10,
        sizeBytes: audio.bytes.byteLength,
        ...(source.key === "url" ? { sourceOrigin: audio.origin } : {}),
        ...(typeof transcript === "string" && transcript.trim() !== "" ? { transcript } : {}),
      };
      const discardFetched = (): void => {
        if (fetched !== undefined && !blobStillReferenced(deps.db, fetched.blobPath)) removeBlob({ dataDir: media.dataDir, blobPath: fetched.blobPath });
      };
      const schema = validateProps(AUDIO, stored);
      if (!schema.ok) {
        discardFetched();
        refuse(AUDIO.id, `its props do not fit its schema: ${schema.problems.join(", ")}`);
      }
      const fallback = clipWithMarker(
        // A transcript keeps any hidden character it has; the text a reader gets writes each as a visible marker.
        `Audio: ${title} (${formatDuration(audio.durationSeconds)})${typeof transcript === "string" && transcript.trim() !== "" ? `. Transcript: ${markHiddenCharacters(transcript).text}` : ""}`,
        SNAPSHOT_TEXT_LIMIT,
      );
      const packageDigest = definitionDigest(AUDIO);
      try {
        const { snapshot } = placeInstance(deps, {
          definition: AUDIO,
          packageDigest,
          ownerPrincipalId: request.principal.principalId,
          props: stored,
          messageId: request.messageId,
          textAlternative: keptText(AUDIO.id, request.caption, fallback),
          presentationRef: `catalog:${AUDIO.id}`,
          bind: (instanceId) => {
            if (fetched !== undefined) storeFetched(deps, request, fetched, audio, title, instanceId);
            return [mediaViewBinding(deps, AUDIO, packageDigest, instanceId)];
          },
        });
        return surface(AUDIO, snapshot);
      } catch (error) {
        discardFetched();
        throw error;
      }
    },
  };
}

/** A fetched file, kept as a sealed external artifact of the conversation, in the same transaction as its player. */
function storeFetched(
  deps: WidgetDeps,
  request: ViewRequest,
  fetched: { artifactId: string; blobPath: string; digest: string },
  audio: FetchedAudio,
  title: string,
  instanceId: string,
): void {
  const now = new Date(deps.now());
  const createdAt = now.toISOString() as Instant;
  const extension = audio.mimeType === "audio/mpeg" ? "mp3" : audio.mimeType.slice("audio/".length);
  // A file name every platform accepts: no path separators, reserved characters or control characters.
  const safe = Array.from(title, (char) => (char.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(char) ? " " : char)).join("");
  const name = redactSecrets(stripBidiControls(`${safe.slice(0, 200).trim() || "audio"}.${extension}`));
  insertBrokerArtifact(deps.db, {
    artifactId: fetched.artifactId,
    ownerPrincipalId: request.principal.principalId,
    kind: "external",
    state: "sealed",
    conversationId: request.conversationId,
    instanceId,
    name,
    mimeType: audio.mimeType satisfies AudioMimeType,
    sizeBytes: audio.bytes.byteLength,
    digest: fetched.digest,
    blobPath: fetched.blobPath,
    stagingRef: undefined,
    createdAt,
    expiresAt: undefined,
    originNodeId: deps.nodeId,
  });
  putArtifactGrant(deps.db, {
    artifactId: fetched.artifactId,
    instanceId,
    principalId: request.principal.principalId,
    access: "read",
    createdAt,
    expiresAt: new Date(now.getTime() + ARTIFACT_LIMITS.grantTtlMs).toISOString() as Instant,
  });
}

export function documentView(deps: WidgetDeps, media: MediaViewDeps): ViewDescriptor {
  return {
    id: DOCUMENT.id,
    label: DOCUMENT.semanticDescription,
    notes:
      `Name exactly one source: props.artifactId or props.attachmentId, a PDF or text file in this conversation; an optional props.title. ` +
      `The node reads its text and shows at most ${String(MEDIA_CONTENT_LIMITS.maxDocumentChars)} characters in pages, and says when it was cut. ` +
      `It is a text preview: pictures and layout are not shown.`,
    shownText: `Shown: ${DOCUMENT.id}. The person pages through the text; the host keeps the page they are on.`,
    build: (request) => {
      const props = request.props;
      checkKeys(DOCUMENT.id, props, DOCUMENT_INPUT_KEYS);
      const title = props.title;
      if (title !== undefined && typeof title !== "string") refuse(DOCUMENT.id, "props.title must be text");
      const source = oneSource(DOCUMENT.id, props, ["artifactId", "attachmentId"]);
      const held = heldSource(deps.db, media.dataDir, request, source);
      if (!("bytes" in held)) refuse(DOCUMENT.id, held);
      if (!isDocumentMimeType(held.mimeType)) {
        refuse(DOCUMENT.id, mediaRefusal("type-not-allowed", `that file is ${held.mimeType}; a preview reads a PDF or a text file`));
      }

      let text: string;
      let knownTotalChars: number | undefined;
      let sourcePages: number | undefined;
      if (held.mimeType === "application/pdf") {
        const extracted = extractPdfText(held.bytes);
        if (!extracted.ok) refuse(DOCUMENT.id, `its text could not be read: ${extracted.reason}`);
        text = extracted.text;
        const counted = countPdfPages(held.bytes);
        sourcePages = counted === undefined || counted < 1 ? undefined : Math.min(counted, MAX_SOURCE_PAGES);
      } else {
        // Only the beginning a preview can show is decoded (a code point is at most four bytes); the rest is counted.
        const head = held.bytes.subarray(0, MEDIA_CONTENT_LIMITS.maxDocumentChars * 4);
        text = new TextDecoder("utf-8", { fatal: false }).decode(head, { stream: true });
        if (head.byteLength < held.bytes.byteLength) knownTotalChars = utf8CodePoints(held.bytes);
      }
      const preview = paginateDocumentText(text, knownTotalChars);
      const stored: Record<string, unknown> = {
        ...(typeof title === "string" && title.trim() !== "" ? { title: title.trim() } : {}),
        // A name a schema can hold: long names are clipped by code point, never mid-character.
        name: Array.from(held.name).slice(0, MAX_DOCUMENT_NAME).join(""),
        mimeType: held.mimeType,
        documentRef: held.ref,
        pages: preview.pages,
        ...(sourcePages === undefined ? {} : { sourcePages }),
        totalChars: preview.totalChars,
        truncated: preview.truncated,
      };
      const schema = validateProps(DOCUMENT, stored);
      if (!schema.ok) refuse(DOCUMENT.id, `its props do not fit its schema: ${schema.problems.join(", ")}`);
      const pageWord = preview.pages.length === 1 ? "page" : "pages";
      const fallback =
        `Document: ${markHiddenCharacters(held.name).text} — a text preview in ${String(preview.pages.length)} ${pageWord}` +
        `${sourcePages === undefined ? "" : ` of a ${String(sourcePages)}-page PDF`}${preview.truncated ? ", cut short" : ""}.`;
      const packageDigest = definitionDigest(DOCUMENT);
      const { snapshot } = placeInstance(deps, {
        definition: DOCUMENT,
        packageDigest,
        ownerPrincipalId: request.principal.principalId,
        props: stored,
        messageId: request.messageId,
        textAlternative: keptText(DOCUMENT.id, request.caption, fallback),
        presentationRef: `catalog:${DOCUMENT.id}`,
        bind: (instanceId) => [mediaViewBinding(deps, DOCUMENT, packageDigest, instanceId)],
      });
      return surface(DOCUMENT, snapshot);
    },
  };
}
