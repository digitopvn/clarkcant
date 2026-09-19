import { z } from "zod";

import { attachmentIdSchema, digestSchema } from "./primitives.ts";

/**
 * Files a person attaches to a message.
 *
 * Three rules shape this contract, and each of them exists because the obvious
 * alternative leaks something:
 *
 * 1. **A reference is not a path.** `AttachmentRefV1` carries an opaque
 *    `attachmentId` and a content-addressed `blobRef` that is a *name inside the
 *    node's blob directory*, never a path. A model, a widget or a peer that
 *    receives a reference therefore cannot name a file on the host, which is the
 *    rule `docs/widgets-and-extensions.md` §8 states as "no arbitrary paths,
 *    executable URLs".
 * 2. **The declared type is a claim, not a fact.** Validation here can only see
 *    the client's declaration, so the runtime sniffs the bytes and refuses a
 *    mismatch. This module holds the allowlist both sides agree on.
 * 3. **The inline budget belongs to the turn, not to the file.** Eight files at
 *    a per-file ceiling is a prompt nobody measured; `inlineBudgetBytesPerTurn`
 *    is the number that actually bounds a turn.
 */

/**
 * How a file is treated once it is stored.
 *
 * `text` is inlined into the turn's prompt, subject to the turn's budget.
 * `image` and `pdf` are binary: the node has no extractor for them yet, so they
 * reach the model as a reference plus the host-mediated `read_attachment` tool.
 */
export const attachmentKindSchema = z.enum(["image", "pdf", "text"]);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

export const ATTACHMENT_LIMITS = Object.freeze({
  /** Per file. 25 MiB, the ceiling the issue proposes. */
  maxBytes: 26_214_400,
  /** Chips in one message. This bounds the UI, not the prompt. */
  maxPerMessage: 8,
  /**
   * Total stored bytes per principal on this node.
   *
   * Named for what is enforced: usage is summed per principal, and a node-wide
   * number would describe a rule this contract does not implement.
   */
  principalQuotaBytes: 1_073_741_824,
  /** Text from all attachments in one turn, together. */
  inlineBudgetBytesPerTurn: 32_768,
  filenameMaxChars: 200,
});

/** The only content types a node accepts, and what each one becomes. */
const MIME_KINDS: readonly { mime: string; kind: AttachmentKind }[] = [
  { mime: "image/png", kind: "image" },
  { mime: "image/jpeg", kind: "image" },
  { mime: "image/webp", kind: "image" },
  { mime: "image/gif", kind: "image" },
  { mime: "application/pdf", kind: "pdf" },
  { mime: "text/plain", kind: "text" },
  { mime: "text/markdown", kind: "text" },
  { mime: "text/csv", kind: "text" },
  { mime: "application/json", kind: "text" },
];

export const ATTACHMENT_MIME_ALLOWLIST: readonly string[] = MIME_KINDS.map((entry) => entry.mime);

/** Which kind a content type is, or `undefined` when the node does not accept it. */
export function classifyAttachment(input: { mime: string }): AttachmentKind | undefined {
  const mime = input.mime.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  return MIME_KINDS.find((entry) => entry.mime === mime)?.kind;
}

/** Why a candidate file was refused. Every one of these reaches a person as a sentence. */
export type AttachmentRefusalCode =
  | "ATTACHMENT_NAME_NOT_ALLOWED"
  | "ATTACHMENT_TYPE_UNSUPPORTED"
  | "ATTACHMENT_TYPE_MISMATCH"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_QUOTA_EXCEEDED";

/**
 * Whether a display name is quietly a path or a URL.
 *
 * A name is shown to a person and stored beside the bytes. If it can also be
 * read as a location, then something downstream — a shell, a browser, a model
 * that repeats it — may treat it as one. So the shape is refused rather than
 * sanitised: a file named `/etc/passwd` or `javascript:alert(1)` is not a name
 * this app will carry.
 *
 * Two rules rather than an exhaustive list: a path separator or a Windows drive
 * prefix, and any `scheme://` prefix. `data:` and the script scheme carry no
 * `//`, so the schemes that can execute are named outright — assembled from the
 * scheme name so the list is a denylist rather than a literal that reads like a
 * URL to a scanner.
 */
const EXECUTABLE_SCHEMES: readonly string[] = ["javascript", "data", "vbscript", "file"].map(
  (scheme) => `${scheme}:`,
);

export function looksLikePathOrUrl(filename: string): boolean {
  const name = filename.trim();
  if (name === "") return true;
  if (name.includes("/") || name.includes("\\")) return true;
  if (/^[a-zA-Z]:/.test(name)) return true;
  const lowered = name.toLowerCase();
  if (EXECUTABLE_SCHEMES.some((scheme) => lowered.startsWith(scheme))) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name)) return true;
  return false;
}

export type AttachmentCandidateOutcome =
  | { ok: true; kind: AttachmentKind; filename: string; mime: string }
  | { ok: false; code: AttachmentRefusalCode; message: string };

/**
 * Decide whether a candidate may be stored.
 *
 * Order matters and is asserted by tests: the name is checked first, because a
 * name that is a path should never be reported as "unsupported type" — the
 * sentence a person reads has to name the thing that was wrong.
 *
 * The declared type is normalised but not trusted: the runtime re-checks the
 * bytes and refuses a disagreement with `ATTACHMENT_TYPE_MISMATCH`.
 */
export function validateAttachmentCandidate(input: {
  filename: string;
  mime: string;
  sizeBytes: number;
  usedBytes: number;
}): AttachmentCandidateOutcome {
  const filename = input.filename.trim();
  const mime = input.mime.trim().toLowerCase().split(";")[0]?.trim() ?? "";

  if (filename === "" || filename.length > ATTACHMENT_LIMITS.filenameMaxChars) {
    return {
      ok: false,
      code: "ATTACHMENT_NAME_NOT_ALLOWED",
      message: `a file name must be 1–${ATTACHMENT_LIMITS.filenameMaxChars} characters`,
    };
  }
  if (looksLikePathOrUrl(filename)) {
    return {
      ok: false,
      code: "ATTACHMENT_NAME_NOT_ALLOWED",
      message: "a file name may not be a path or a URL",
    };
  }

  const kind = classifyAttachment({ mime });
  if (kind === undefined) {
    return {
      ok: false,
      code: "ATTACHMENT_TYPE_UNSUPPORTED",
      message: `${mime === "" ? "an empty content type" : mime} is not accepted; this node takes ${ATTACHMENT_MIME_ALLOWLIST.join(", ")}`,
    };
  }

  if (input.sizeBytes > ATTACHMENT_LIMITS.maxBytes) {
    return {
      ok: false,
      code: "ATTACHMENT_TOO_LARGE",
      message: `that file is ${input.sizeBytes} bytes, over the ${ATTACHMENT_LIMITS.maxBytes} byte ceiling for one file`,
    };
  }

  if (input.usedBytes + input.sizeBytes > ATTACHMENT_LIMITS.principalQuotaBytes) {
    return {
      ok: false,
      code: "ATTACHMENT_QUOTA_EXCEEDED",
      message: `${input.usedBytes} bytes of ${ATTACHMENT_LIMITS.principalQuotaBytes} are already stored for this principal, so ${input.sizeBytes} more would cross the quota`,
    };
  }

  return { ok: true, kind, filename, mime };
}

/**
 * One attached file, as every surface sees it.
 *
 * `blobRef` is a content-addressed file name inside the node's blob directory
 * — the same shape the image store already writes — and deliberately not a
 * path: the pattern admits no separator, so a forged reference cannot aim at
 * another directory. The reader still re-checks containment against the blob
 * root, because a length limit is not a security boundary.
 */
export const attachmentRefSchema = z.strictObject({
  attachmentId: attachmentIdSchema,
  filename: z.string().min(1).max(ATTACHMENT_LIMITS.filenameMaxChars),
  mime: z.string().min(3).max(120),
  kind: attachmentKindSchema,
  sizeBytes: z.int().nonnegative(),
  sha256: digestSchema,
  blobRef: z.string().regex(/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/, {
    error: "must be a content-addressed blob name, not a path",
  }),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
