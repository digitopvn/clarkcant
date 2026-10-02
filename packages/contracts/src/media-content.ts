/**
 * The media content policy: what an audio player or a document preview may be placed from, and the shape the node
 * stores once it has checked it.
 *
 * Two widgets read this module, and the node is the only thing that ever fetches for them. A model names a source — an
 * ArtifactRef, an attachment, or for audio an https URL — and the node checks it here, fetches it under these bounds,
 * stores it as an artifact and hands the page a host reference. The page never makes a request outside its node, so the
 * page's content security policy does not change and nothing a model wrote can make a reader's browser call somebody
 * else's server.
 *
 * Every refusal names the rule it broke ({@link MediaRefusalRule}), so a model that asked for something the policy does
 * not allow reads why in the same turn and a person reading the trail sees which rule held.
 */

import { ATTACHMENT_LIMITS } from "./attachments.ts";

/** The audio types the node plays, decided by the bytes rather than by what a server called them. */
export const AUDIO_MIME_TYPES = ["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"] as const;
export type AudioMimeType = (typeof AUDIO_MIME_TYPES)[number];

/** The document types the node previews as text. A PDF's text is recovered on the node; the rest are text already. */
export const DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
] as const;

export const MEDIA_CONTENT_LIMITS = {
  /** One audio file, the same ceiling as one attachment, so a fetched file never outgrows what a person could attach. */
  maxAudioBytes: ATTACHMENT_LIMITS.maxBytes,
  /** One hour. Longer audio is refused rather than stored and half-played. */
  maxAudioSeconds: 3_600,
  /** The whole fetch, redirects included. */
  fetchTimeoutMs: 30_000,
  /** Redirects followed, each one only within the origin the policy allowed. */
  maxRedirects: 3,
  /** Origins one node may allow; more is a configuration mistake rather than a policy. */
  maxOrigins: 32,
  /** A transcript or caption shown beside the player. */
  maxTranscriptChars: 4_000,
  /** One page of a document preview. */
  documentPageChars: 2_000,
  /** The most of a document a preview holds; past it the preview says it was cut. */
  maxDocumentChars: 20_000,
} as const;

/** The most pages a preview holds: the held text split into pages. */
export const MAX_DOCUMENT_PAGES = Math.ceil(MEDIA_CONTENT_LIMITS.maxDocumentChars / MEDIA_CONTENT_LIMITS.documentPageChars);

/** The rule a refused source broke. Stable words, so a test and a reader can both rely on them. */
export type MediaRefusalRule =
  | "source"
  | "https-only"
  | "credentials-in-url"
  | "origin-not-allowed"
  | "private-address"
  | "redirect-off-origin"
  | "too-many-redirects"
  | "too-large"
  | "too-long"
  | "duration-unknown"
  | "type-not-allowed"
  | "type-mismatch"
  | "timeout"
  | "fetch-failed"
  | "not-found";

export interface MediaRefusal {
  ok: false;
  rule: MediaRefusalRule;
  message: string;
}

export function mediaRefusal(rule: MediaRefusalRule, message: string): MediaRefusal {
  return { ok: false, rule, message: `${message} (media policy rule: ${rule})` };
}

/** The https origins this node may fetch audio from. Empty unless the operator names some. */
export interface MediaPolicy {
  origins: readonly string[];
}

export const EMPTY_MEDIA_POLICY: MediaPolicy = { origins: [] };

/**
 * Read the node's media policy from its setting: a comma-separated list of https origins.
 *
 * An entry that is not a bare https origin — a path, a query, credentials, another scheme — makes the whole setting
 * unusable rather than quietly dropped, because an operator who wrote `https://example.com/podcasts` meant a narrower
 * rule than the origin it would otherwise become.
 */
export function parseMediaPolicy(value: string | undefined): { ok: true; policy: MediaPolicy } | { ok: false; problems: string[] } {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  const problems: string[] = [];
  const origins = new Set<string>();
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      problems.push(`${entry} is not a URL`);
      continue;
    }
    if (url.protocol !== "https:") problems.push(`${entry} is not https`);
    else if (url.username !== "" || url.password !== "") problems.push(`${entry} carries credentials`);
    else if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "" || entry.endsWith("/")) {
      problems.push(`${entry} is not a bare origin; name it as ${url.origin}`);
    } else origins.add(url.origin);
  }
  if (origins.size > MEDIA_CONTENT_LIMITS.maxOrigins) problems.push(`at most ${String(MEDIA_CONTENT_LIMITS.maxOrigins)} origins may be allowed`);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, policy: { origins: [...origins].sort() } };
}

/** Whether a host is written as an IP address or as `localhost`, so it names its own address rather than a DNS name. */
export function hostNamesAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * Check a URL a model named before anything is fetched: https, no credentials, and an origin the policy allows.
 *
 * The private-address rule is applied where the address is known, when the node resolves the name: a name is not an
 * address, and checking the name here would let one that resolves to loopback through.
 */
export function checkMediaUrl(raw: string, policy: MediaPolicy): { ok: true; url: URL } | MediaRefusal {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return mediaRefusal("source", "the audio URL is not a URL");
  }
  if (url.protocol !== "https:") return mediaRefusal("https-only", `audio is only fetched over https, and this URL is ${url.protocol.replace(/:$/, "")}`);
  if (url.username !== "" || url.password !== "") return mediaRefusal("credentials-in-url", "the audio URL carries credentials, which this node never sends");
  if (!policy.origins.includes(url.origin)) {
    return mediaRefusal(
      "origin-not-allowed",
      policy.origins.length === 0
        ? `${url.origin} is not allowed: this node's media policy allows no origins, so audio can only be played from a file on the node`
        : `${url.origin} is not one of the origins this node's media policy allows`,
    );
  }
  return { ok: true, url };
}

/** What a server may call an audio file, under the name this node uses for it. */
const AUDIO_TYPE_ALIASES: Readonly<Record<string, AudioMimeType>> = {
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/ogg": "audio/ogg",
  "audio/opus": "audio/ogg",
  "application/ogg": "audio/ogg",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/webm": "audio/webm",
};

/** A declared content type as an audio type this node plays, or undefined when it is not one. Parameters are ignored. */
export function normalizeAudioType(declared: string | undefined): AudioMimeType | undefined {
  const bare = (declared ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return AUDIO_TYPE_ALIASES[bare];
}

export function isAudioMimeType(value: unknown): value is AudioMimeType {
  return typeof value === "string" && (AUDIO_MIME_TYPES as readonly string[]).includes(value);
}

export function isDocumentMimeType(value: unknown): boolean {
  return typeof value === "string" && (DOCUMENT_MIME_TYPES as readonly string[]).includes(value);
}

/** A host reference to a file on the node: an artifact or an attachment, never a path or a URL. */
export const HOST_FILE_REF_PATTERN = "^(?:artifact|attachment):[A-Za-z0-9_-]{1,128}$";

export function hostFileRef(kind: "artifact" | "attachment", id: string): string {
  return `${kind}:${id}`;
}

export function parseHostFileRef(ref: unknown): { kind: "artifact" | "attachment"; id: string } | undefined {
  if (typeof ref !== "string" || !new RegExp(HOST_FILE_REF_PATTERN).test(ref)) return undefined;
  const at = ref.indexOf(":");
  return { kind: ref.slice(0, at) as "artifact" | "attachment", id: ref.slice(at + 1) };
}

/** A placed audio player, as the node stored it. */
export interface AudioProps {
  title: string;
  audioRef: string;
  mimeType: AudioMimeType;
  durationSeconds?: number;
  sizeBytes?: number;
  sourceOrigin?: string;
  transcript?: string;
}

export function readAudio(props: Record<string, unknown>): AudioProps | undefined {
  const { title, audioRef, mimeType, durationSeconds, sizeBytes, sourceOrigin, transcript } = props;
  if (typeof title !== "string" || parseHostFileRef(audioRef) === undefined || !isAudioMimeType(mimeType)) return undefined;
  return {
    title,
    audioRef: audioRef as string,
    mimeType,
    ...(typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds >= 0 ? { durationSeconds } : {}),
    ...(typeof sizeBytes === "number" && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? { sizeBytes } : {}),
    ...(typeof sourceOrigin === "string" ? { sourceOrigin } : {}),
    ...(typeof transcript === "string" && transcript !== "" ? { transcript } : {}),
  };
}

/** A placed document preview, as the node stored it: the text it recovered, already split into pages. */
export interface DocumentProps {
  name: string;
  mimeType: string;
  documentRef: string;
  pages: string[];
  /** The pages the PDF itself declares; absent for a text file. */
  sourcePages?: number;
  /** Characters the node recovered before it cut the preview. */
  totalChars: number;
  truncated: boolean;
  title?: string;
}

export function readDocument(props: Record<string, unknown>): DocumentProps | undefined {
  const { name, mimeType, documentRef, pages, sourcePages, totalChars, truncated, title } = props;
  if (typeof name !== "string" || !isDocumentMimeType(mimeType) || parseHostFileRef(documentRef) === undefined) return undefined;
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_DOCUMENT_PAGES || !pages.every((page) => typeof page === "string")) return undefined;
  if (typeof totalChars !== "number" || !Number.isSafeInteger(totalChars) || totalChars < 0 || typeof truncated !== "boolean") return undefined;
  return {
    name,
    mimeType: mimeType as string,
    documentRef: documentRef as string,
    pages: pages as string[],
    ...(typeof sourcePages === "number" && Number.isSafeInteger(sourcePages) && sourcePages > 0 ? { sourcePages } : {}),
    totalChars,
    truncated,
    ...(typeof title === "string" && title !== "" ? { title } : {}),
  };
}

/**
 * Split recovered text into a bounded preview.
 *
 * Kept to {@link MEDIA_CONTENT_LIMITS.maxDocumentChars} and cut into pages of
 * {@link MEDIA_CONTENT_LIMITS.documentPageChars}, preferring a break at a line or a space near the end of a page so a
 * page does not end in the middle of a word. Code points are never split.
 *
 * Only the kept prefix is split into code points; the rest is counted without being copied, so a large file costs a
 * count rather than an array of every character. `knownTotalChars` is the whole document's length when `text` is
 * only its beginning.
 */
export function paginateDocumentText(
  text: string,
  knownTotalChars?: number,
): { pages: string[]; totalChars: number; truncated: boolean } {
  let totalChars = 0;
  let prefixEnd = text.length;
  for (let index = 0; index < text.length; index += 1) {
    if (totalChars === MEDIA_CONTENT_LIMITS.maxDocumentChars && prefixEnd === text.length) prefixEnd = index;
    totalChars += 1;
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
  }
  if (knownTotalChars !== undefined && knownTotalChars > totalChars) totalChars = knownTotalChars;
  const kept = Array.from(text.slice(0, prefixEnd));
  const truncated = totalChars > kept.length;
  const pages: string[] = [];
  let at = 0;
  while (at < kept.length && pages.length < MAX_DOCUMENT_PAGES) {
    let end = Math.min(at + MEDIA_CONTENT_LIMITS.documentPageChars, kept.length);
    if (end < kept.length) {
      // Look back at most a fifth of a page for a line end, then a space.
      const floor = end - Math.floor(MEDIA_CONTENT_LIMITS.documentPageChars / 5);
      let cut = -1;
      for (let index = end; index > floor; index -= 1) if (kept[index - 1] === "\n") { cut = index; break; }
      if (cut === -1) for (let index = end; index > floor; index -= 1) if (kept[index - 1] === " ") { cut = index; break; }
      if (cut !== -1) end = cut;
    }
    pages.push(kept.slice(at, end).join(""));
    at = end;
  }
  if (pages.length === 0) pages.push("");
  return { pages, totalChars, truncated: truncated || at < kept.length };
}

/** The document page state a preview holds. */
export const DOCUMENT_PAGE_MIGRATION = {
  from: 1,
  to: 2,
  ops: [{ op: "default" as const, key: "page", value: 0 }],
};

/** The page a preview opens at, clamped to the pages it has now. Counted from 0, as stored. */
export function readDocumentPage(value: unknown, pageCount: number): number {
  const page = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).page : undefined;
  if (typeof page !== "number" || !Number.isFinite(page) || !Number.isSafeInteger(pageCount) || pageCount < 1) return 0;
  return Math.max(0, Math.min(Math.floor(page), pageCount - 1));
}
