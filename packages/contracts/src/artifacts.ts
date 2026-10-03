import { z } from "zod";

import { ATTACHMENT_LIMITS, ATTACHMENT_MIME_ALLOWLIST, looksLikePathOrUrl } from "./attachments.ts";
import { artifactIdSchema, digestSchema } from "./primitives.ts";

/**
 * Artifact references: how a widget holds a file without holding a file.
 *
 * A widget that edits a document, exports a chart or reads a file the person chose never receives a path, a file
 * handle or a URL. It receives an `ArtifactRef`: an opaque id plus the facts a widget needs to show and use the file
 * (its kind, type, size, display name and, once the bytes are fixed, their digest). Three rules follow from that, and
 * each exists because the obvious alternative leaks something:
 *
 * 1. **A ref is a pointer, not a permission.** Holding an id grants nothing. Every use is re-checked by the host
 *    against the owner principal, the widget instance's grant, the grant's expiry and revocation, and the artifact's
 *    own state (`decideArtifactAccess`). A ref copied into another widget, another principal's request or a prompt is
 *    refused there with a reason.
 * 2. **The host holds the location.** A file the person picked on their own machine is an `external` artifact: the
 *    node keeps a snapshot of its bytes, and only the host's own chrome (the desktop shell) remembers where it came
 *    from. Nothing in a ref, a bridge message, widget props, widget state, a log or a prompt can name that place.
 * 3. **Bytes decide the type, and the attachment rules decide what is allowed.** The allowlist, the per-file ceiling
 *    and the per-principal quota are the attachment pipeline's, reused rather than restated, so a file cannot become
 *    acceptable by arriving through a widget instead of the composer.
 */

export const ARTIFACT_REF_VERSION = 1;

/**
 * Where an artifact came from, which decides what may be done with it.
 *
 * - `attachment`: a file the person attached to the conversation, handed to a widget. Reserved: no host flow produces
 *   one yet, and a ref of this kind is described here so the wire shape does not change when one does.
 * - `working`: bytes a widget is writing. Writable by the one instance that created it, expires unless finalized.
 * - `finalized`: a working artifact whose bytes are now fixed. Immutable, carries a digest, and follows its
 *   conversation's lifetime.
 * - `external`: a snapshot of a file the person picked through host chrome. Immutable, carries a digest; where it was
 *   read from is held by the host and never by the widget.
 */
export const artifactKindSchema = z.enum(["attachment", "working", "finalized", "external"]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** Whether the bytes may still change. `writable` only for a `working` artifact. */
export const artifactStateSchema = z.enum(["writable", "sealed"]);
export type ArtifactState = z.infer<typeof artifactStateSchema>;

export const ARTIFACT_LIMITS = Object.freeze({
  /** One write through the bridge. 256 KiB of bytes, which base64 inflates to about 342 KiB of message. */
  chunkBytes: 262_144,
  /** One read through the bridge. The same bound as a write, for the same reason. */
  maxReadBytes: 262_144,
  /** One artifact. The attachment ceiling, so an artifact can always be attached. */
  maxBytes: ATTACHMENT_LIMITS.maxBytes,
  /** How long a working artifact lives after its last write, unless it is finalized. */
  workingTtlMs: 24 * 60 * 60 * 1000,
  /**
   * How long a widget instance's grant lasts. A write extends the grant of the instance writing. The grant a widget holds
   * on a file it wrote and finalized does not run out: that file follows its conversation, and so does its creator's
   * access to it.
   */
  grantTtlMs: 24 * 60 * 60 * 1000,
  /**
   * Bytes one widget instance may hold in artifacts it created or was handed, inside the principal's quota. 128 MiB, so
   * one widget that saves often cannot take the whole quota the composer's attachments share with it.
   */
  instanceQuotaBytes: 134_217_728,
  nameMaxChars: ATTACHMENT_LIMITS.filenameMaxChars,
  /**
   * Characters (code points) in a name a widget proposes when it attaches a file, extension included. Shorter than
   * `nameMaxChars` because the name labels a chip in the composer, and so a name of any characters stays within it.
   */
  proposedNameMaxChars: 100,
  /** Entries in a picker's accept list. */
  maxAccept: 16,
});

/**
 * Base64 characters a chunk may be.
 *
 * Exported so the bridge, the route and the host agree on the same bound without each recomputing it.
 */
export const ARTIFACT_CHUNK_BASE64_MAX = Math.ceil(ARTIFACT_LIMITS.chunkBytes / 3) * 4;

/** A display name: a file name, never a path or a URL. */
export const artifactNameSchema = z
  .string()
  .min(1)
  .max(ARTIFACT_LIMITS.nameMaxChars)
  .refine((value) => !looksLikePathOrUrl(value), { error: "must be a file name, not a path or a URL" });

/** A MIME pattern a picker may ask for: `type/subtype` or `type/*`. */
export const artifactAcceptSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z][a-z0-9.+-]*\/(\*|[a-z0-9][a-z0-9.+-]*)$/, { error: "must be a MIME type such as text/plain or image/*" });

export const artifactRefSchema = z
  .strictObject({
    v: z.literal(ARTIFACT_REF_VERSION),
    artifactId: artifactIdSchema,
    kind: artifactKindSchema,
    mimeType: z.string().min(3).max(120),
    sizeBytes: z.int().nonnegative(),
    name: artifactNameSchema,
    /** Present once the bytes are fixed, and only then: a writable artifact has no digest to promise. */
    digest: digestSchema.optional(),
  })
  .superRefine((ref, context) => {
    if (ref.kind === "working" && ref.digest !== undefined) {
      context.addIssue({ code: "custom", path: ["digest"], message: "a working artifact has no digest yet" });
    }
    if (ref.kind !== "working" && ref.digest === undefined) {
      context.addIssue({ code: "custom", path: ["digest"], message: `a ${ref.kind} artifact carries its digest` });
    }
  });
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

/**
 * Every reason the host refuses a use of a ref.
 *
 * Each names the thing that was wrong, because an author debugging a widget needs to know whether to ask the person
 * again (expired grant), stop (revoked), or fix their code (range, chunk, type).
 */
export const ARTIFACT_REFUSAL_CODES = [
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_CROSS_PRINCIPAL",
  "ARTIFACT_NOT_GRANTED",
  "ARTIFACT_GRANT_EXPIRED",
  "ARTIFACT_GRANT_REVOKED",
  "ARTIFACT_EXPIRED",
  "ARTIFACT_NOT_WRITABLE",
  "ARTIFACT_NOT_FINALIZED",
  "ARTIFACT_RANGE_INVALID",
  "ARTIFACT_CHUNK_TOO_LARGE",
  "ARTIFACT_OFFSET_MISMATCH",
  "ARTIFACT_TOO_LARGE",
  "ARTIFACT_QUOTA_EXCEEDED",
  "ARTIFACT_INSTANCE_QUOTA_EXCEEDED",
  "ARTIFACT_NOT_CREATOR",
  "ARTIFACT_TYPE_MISMATCH",
  "ARTIFACT_TYPE_UNSUPPORTED",
  "ARTIFACT_TYPE_NOT_ACCEPTED",
  "ARTIFACT_NAME_NOT_ALLOWED",
  "ARTIFACT_BYTES_MISSING",
] as const;
export type ArtifactRefusalCode = (typeof ARTIFACT_REFUSAL_CODES)[number];

export type ArtifactRefusal = { ok: false; code: ArtifactRefusalCode; message: string };

/** The HTTP status a refusal travels with, decided once rather than at each route. */
export function artifactRefusalStatus(code: ArtifactRefusalCode): number {
  switch (code) {
    case "ARTIFACT_NOT_FOUND":
      return 404;
    case "ARTIFACT_CROSS_PRINCIPAL":
    case "ARTIFACT_NOT_GRANTED":
    case "ARTIFACT_GRANT_EXPIRED":
    case "ARTIFACT_GRANT_REVOKED":
    case "ARTIFACT_NOT_CREATOR":
      return 403;
    case "ARTIFACT_EXPIRED":
    case "ARTIFACT_BYTES_MISSING":
      return 410;
    case "ARTIFACT_NOT_WRITABLE":
    case "ARTIFACT_NOT_FINALIZED":
    case "ARTIFACT_OFFSET_MISMATCH":
    case "ARTIFACT_QUOTA_EXCEEDED":
    case "ARTIFACT_INSTANCE_QUOTA_EXCEEDED":
      return 409;
    case "ARTIFACT_TOO_LARGE":
    case "ARTIFACT_CHUNK_TOO_LARGE":
      return 413;
    case "ARTIFACT_TYPE_MISMATCH":
    case "ARTIFACT_TYPE_UNSUPPORTED":
    case "ARTIFACT_TYPE_NOT_ACCEPTED":
      return 415;
    case "ARTIFACT_RANGE_INVALID":
    case "ARTIFACT_NAME_NOT_ALLOWED":
      return 400;
  }
}

/** What the host knows about an artifact when it decides a use. */
export interface ArtifactAccessSubject {
  ownerPrincipalId: string;
  state: ArtifactState;
  /** ISO instant. Absent means it does not expire on its own. */
  expiresAt?: string | undefined;
  /** Where it came from. A `finalized` artifact's creator keeps reading it after the grant's own time runs out. */
  kind?: ArtifactKind | undefined;
  /** The widget instance that created it or was handed it. */
  instanceId?: string | undefined;
}

/** One widget instance's grant on one artifact. */
export interface ArtifactGrantView {
  instanceId: string;
  principalId: string;
  access: "read" | "write";
  expiresAt: string;
  revokedAt?: string | undefined;
}

/**
 * Decide whether one widget instance may use one artifact now.
 *
 * Pure, and the only place the rule lives: the node calls it on every read, write, finalize, export request and
 * attach, so a ref that was valid a minute ago is re-judged rather than remembered. The order is fixed and tested —
 * whose it is first, then whether it still exists, then whether this instance was ever granted it, then whether that
 * grant still stands — because the sentence a person or an author reads has to name the first thing that was wrong.
 */
/** The answer for a file that is not here, and for one that is not the asker's: the two must read the same. */
export const ARTIFACT_NOT_ON_NODE = "that artifact is not on this node";

export function decideArtifactAccess(input: {
  principalId: string;
  instanceId: string;
  need: "read" | "write";
  artifact: ArtifactAccessSubject | undefined;
  grant: ArtifactGrantView | undefined;
  nowMs: number;
}): { ok: true } | ArtifactRefusal {
  const { artifact, grant } = input;
  if (artifact === undefined) {
    return { ok: false, code: "ARTIFACT_NOT_FOUND", message: ARTIFACT_NOT_ON_NODE };
  }
  if (artifact.ownerPrincipalId !== input.principalId) {
    return { ok: false, code: "ARTIFACT_CROSS_PRINCIPAL", message: "that artifact belongs to another principal" };
  }
  if (artifact.expiresAt !== undefined && Date.parse(artifact.expiresAt) <= input.nowMs) {
    return {
      ok: false,
      code: "ARTIFACT_EXPIRED",
      message: "that working artifact expired before it was finalized; its bytes have been or will be removed",
    };
  }
  if (grant === undefined || grant.instanceId !== input.instanceId) {
    return { ok: false, code: "ARTIFACT_NOT_GRANTED", message: "this widget was never granted that artifact" };
  }
  if (grant.principalId !== input.principalId) {
    return { ok: false, code: "ARTIFACT_CROSS_PRINCIPAL", message: "that grant was issued to another principal" };
  }
  if (grant.revokedAt !== undefined) {
    return { ok: false, code: "ARTIFACT_GRANT_REVOKED", message: "this widget's access to that artifact was revoked" };
  }
  /*
   * A file the widget wrote and finalized follows its conversation, so the widget that wrote it keeps reading it for as
   * long as it is there: its grant's time is the time a writer has between writes, not a lifetime. A file the person
   * chose is theirs to hand over again, so that grant does run out.
   */
  const creatorOfSealed = artifact.kind === "finalized" && artifact.instanceId === input.instanceId && input.need === "read";
  if (!creatorOfSealed && Date.parse(grant.expiresAt) <= input.nowMs) {
    return {
      ok: false,
      code: "ARTIFACT_GRANT_EXPIRED",
      message:
        artifact.kind === "external"
          ? "this widget's access to that file ended 24 hours after the person chose it; ask the person to choose the file again"
          : "this widget's access to that artifact has expired",
    };
  }
  if (input.need === "write" && (grant.access !== "write" || artifact.state !== "writable")) {
    return {
      ok: false,
      code: "ARTIFACT_NOT_WRITABLE",
      message: "that artifact is not writable by this widget; create a working artifact to write new bytes",
    };
  }
  return { ok: true };
}

/**
 * Bound one read.
 *
 * A length past the end is shortened rather than refused, so a reader can ask for a chunk and learn it reached the
 * end; an offset past the end, a negative offset or an oversized length is refused, because it is a bug in the reader.
 */
export function checkArtifactRange(input: {
  offset: unknown;
  length: unknown;
  sizeBytes: number;
}): { ok: true; offset: number; length: number; eof: boolean } | ArtifactRefusal {
  const { offset, length } = input;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    return { ok: false, code: "ARTIFACT_RANGE_INVALID", message: "offset must be a non-negative integer" };
  }
  if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > ARTIFACT_LIMITS.maxReadBytes) {
    return {
      ok: false,
      code: "ARTIFACT_RANGE_INVALID",
      message: `length must be an integer from 1 to ${ARTIFACT_LIMITS.maxReadBytes}`,
    };
  }
  if (offset > input.sizeBytes) {
    return {
      ok: false,
      code: "ARTIFACT_RANGE_INVALID",
      message: `offset ${offset} is past the end of a ${input.sizeBytes} byte artifact`,
    };
  }
  const available = Math.min(length, input.sizeBytes - offset);
  return { ok: true, offset, length: available, eof: offset + available >= input.sizeBytes };
}

/** Whether a sniffed type satisfies a picker's accept list. An empty list accepts anything the allowlist does. */
export function artifactAcceptMatches(accept: readonly string[], mimeType: string): boolean {
  if (accept.length === 0) return true;
  const [type] = mimeType.split("/");
  return accept.some((pattern) => pattern === mimeType || (pattern.endsWith("/*") && pattern.slice(0, -2) === type));
}

/** The types a widget may create or pick: the attachment allowlist, so every artifact can be attached. */
export const ARTIFACT_MIME_ALLOWLIST: readonly string[] = ATTACHMENT_MIME_ALLOWLIST;

/**
 * The file extensions each allowed type is saved under, the first being the one the host writes.
 *
 * The desktop shell's picker keeps its own copy (`PICKABLE_TYPES` in `apps/desktop/src/file-bridge.mjs`), because the
 * shell's main process is plain JavaScript that does not load this package; a test holds the two to the same lists.
 */
export const ARTIFACT_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "text/plain": ["txt", "text", "log"],
  "text/markdown": ["md", "markdown"],
  "text/csv": ["csv"],
  "text/tab-separated-values": ["tsv", "tab"],
  "application/json": ["json"],
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "audio/wav": ["wav"],
});

/**
 * Characters that change the direction text is shown in (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069).
 *
 * A file name has no use for them, and they are how a name is made to read as something it is not: `hoa-don\u202Egpj.exe`
 * is shown as `hoa-donexe.jpg`. They are removed from every name a widget or a file brings, before it is stored, shown or
 * put in a header.
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

export function stripBidiControls(text: string): string {
  return text.replaceAll(BIDI_CONTROLS, "");
}

/** Other names systems give the allowed types, each to the one this node uses. */
const TYPE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Windows with Office installed registers `.csv` as an Excel file.
  "application/vnd.ms-excel": "text/csv",
  "application/csv": "text/csv",
  "text/x-csv": "text/csv",
  "text/comma-separated-values": "text/csv",
  "text/tsv": "text/tab-separated-values",
  "text/x-markdown": "text/markdown",
  "text/json": "application/json",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
});

/** Types that only say "some bytes": a system that sends one does not know what the file is. */
const GENERIC_TYPES: ReadonlySet<string> = new Set(["", "application/octet-stream", "binary/octet-stream", "application/unknown", "application/x-unknown"]);

/** Text types whose bytes look like any other text, so only a name can tell them apart from `text/plain`. */
const NAMED_TEXT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  tab: "text/tab-separated-values",
  json: "application/json",
});

/**
 * The type a picked file is declared as, before the node reads its bytes.
 *
 * What a browser or an OS says a file is varies by machine: Windows with Office calls a `.csv` `application/vnd.ms-excel`,
 * and a system with no idea says `application/octet-stream`. So another name for an allowed type becomes that type, and
 * a generic type becomes the text type the extension names (text has no magic bytes to tell CSV from plain text) or
 * nothing, which lets the node decide from the bytes. It is still only a claim: the bytes are sniffed and a file that is
 * not what it says is refused.
 */
export function normalizePickedType(declared: string, name: string): string {
  const type = declared.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  const known = TYPE_ALIASES[type] ?? type;
  if (!GENERIC_TYPES.has(known)) return known;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return NAMED_TEXT_TYPES[extension] ?? "";
}

/** A default display name for a working artifact created without one. */
export function defaultArtifactName(mimeType: string): string {
  return `untitled.${ARTIFACT_EXTENSIONS[mimeType]?.[0] ?? "bin"}`;
}

/** How much of a proposed name is looked at, so a huge proposal costs no more than a long one. */
const PROPOSED_NAME_INPUT_MAX = 1_000;

/** Characters a proposed name keeps: letters with their marks, digits, space and `. _ - ( )`. Anything else is a dash. */
const UNSAFE_NAME_CHARACTERS = /[^\p{L}\p{M}\p{N} ._()-]+/gu;

/**
 * The name a file a widget attaches is given: the widget's proposal, made safe, or the default for its type.
 *
 * The proposal is a widget's data, never trusted, so it is reduced rather than refused — a widget offering a bad name
 * still gets its file attached, under a name the node chose. In order: only the last part of anything that looks like
 * a path is kept; control, format, direction and default-ignorable characters go; every character outside a small
 * safe set becomes a dash; a run of dots becomes one, and dots, dashes and spaces are trimmed from both ends, so
 * nothing is `..`, hidden or ends in a dot; the extension becomes the bytes' type's (a PNG proposed as `anh.exe` is
 * `anh.png`, and `kite-v2.1` is `kite-v2.1.png`); the stem is shortened by code point to `proposedNameMaxChars`; and
 * what is left empty becomes `defaultArtifactName`. The node calls this on its canonical attach path, for a proposal
 * and for the artifact's own name alike, so every widget gets the same rule.
 */
export function sanitizeProposedArtifactName(proposed: unknown, mimeType: string): string {
  const fallback = defaultArtifactName(mimeType);
  if (typeof proposed !== "string") return fallback;
  const cleaned = stripBidiControls(proposed.slice(0, PROPOSED_NAME_INPUT_MAX))
    .normalize("NFC")
    // Default-ignorable code points are drawn as nothing (U+3164, U+034F, variation selectors…): a name made of them
    // looks empty, and one with them in it looks like another name.
    .replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");
  // A path's directories are not part of a name: only its last part is.
  const base = cleaned.split(/[\\/]/u).pop() ?? "";
  const reduced = base
    .replace(UNSAFE_NAME_CHARACTERS, "-")
    .replace(/\.{2,}/gu, ".")
    .replace(/ {2,}/gu, " ")
    .replace(/-{2,}/gu, "-");
  // A name that is only an extension (`.png`, or `ㅤ.png` once the filler is gone) has no stem to keep.
  if (/^[ -]*\.[^.]*$/u.test(reduced)) return fallback;
  const safe = reduced.replace(/^[ .-]+|[ .-]+$/gu, "");
  const extensions = ARTIFACT_EXTENSIONS[mimeType] ?? [];
  const dot = safe.lastIndexOf(".");
  /*
   * What follows the last dot is an extension only when it starts with a letter, so `kite-v2.1` keeps its `.1` and
   * becomes `kite-v2.1.png`. An extension that is not the type's is replaced, never kept in front of the right one: a
   * PNG proposed as `hoa-don.exe` is `hoa-don.png`, not `hoa-don.exe.png`, which a system hiding known extensions shows
   * as `hoa-don.exe`.
   */
  const hasExtension = dot > 0 && /^\p{L}[\p{L}\p{N}_-]{0,15}$/u.test(safe.slice(dot + 1));
  const proposedExtension = hasExtension ? safe.slice(dot + 1).toLowerCase() : "";
  const extension = extensions.includes(proposedExtension) ? proposedExtension : (extensions[0] ?? "bin");
  const stem = (hasExtension ? safe.slice(0, dot) : safe).replace(/[ .-]+$/u, "");
  // By code point, so a long Vietnamese or emoji name is never cut through a character.
  const kept = Array.from(stem)
    .slice(0, ARTIFACT_LIMITS.proposedNameMaxChars - extension.length - 1)
    .join("")
    .replace(/[ .-]+$/u, "");
  if (kept === "") return fallback;
  const name = `${kept}.${extension}`;
  return looksLikePathOrUrl(name) ? fallback : name;
}

/**
 * The name a file is saved under: the suggested name, with the extension its bytes' type has.
 *
 * The type is the node's, sniffed from the bytes; the name is a widget's suggestion. So the extension is decided by the
 * type — kept when it already agrees, replaced when it does not, added when there is none — and a `text/plain` artifact
 * a widget suggested as `invoice.bat` is saved as `invoice.txt`, never as something the OS would run.
 */
export function artifactFileName(suggestedName: string, mimeType: string): string {
  const extensions = ARTIFACT_EXTENSIONS[mimeType];
  const trimmed = stripBidiControls(suggestedName).trim().replace(/[. ]+$/u, "");
  if (extensions === undefined) return trimmed === "" ? "file" : trimmed;
  const dot = trimmed.lastIndexOf(".");
  const hasExtension = dot > 0 && /^[\p{L}\p{N}_-]{1,16}$/u.test(trimmed.slice(dot + 1));
  const stem = hasExtension ? trimmed.slice(0, dot) : trimmed;
  const current = hasExtension ? trimmed.slice(dot + 1).toLowerCase() : "";
  if (extensions.includes(current)) return trimmed;
  const extension = extensions[0] ?? "bin";
  // By code point, so a long Vietnamese or emoji name is never cut through a character.
  const kept = Array.from(stem).slice(0, ARTIFACT_LIMITS.nameMaxChars - extension.length - 1).join("");
  return `${kept === "" ? "file" : kept}.${extension}`;
}
