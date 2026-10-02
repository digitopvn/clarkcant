/**
 * What a person reads about a widget's files: the types a widget asks for, and why a pick or a save did not happen.
 *
 * Both are said in the person's language and from fixed sentences. A reason is chosen by the refusal's code — the
 * node's, or the desktop shell's — and never copied from an error's message: the node words its refusals in English
 * for the widget that reads them, and an error from the file system names the path on disk.
 */

import { GatewayError } from "./api.ts";
import type { MessageKey } from "./i18n/messages.ts";

type Translate = (key: MessageKey) => string;

/**
 * A pick or a save the desktop shell refused, by its fixed code (`file-bridge.mjs`): what failed, never where.
 * `errorCode` is the file system's own code (`EBUSY`, `EACCES`) when that was the cause.
 */
export class DesktopFileError extends Error {
  readonly code: string;
  readonly errorCode: string | undefined;

  constructor(code: string, errorCode?: string) {
    // Kept only in their own shapes, so nothing an older or broken shell put in these fields can carry a path onward.
    const safeCode = /^[A-Z_]{1,40}$/u.test(code) ? code : "DESKTOP_FAILED";
    super(`the desktop did not finish the file request (${safeCode})`);
    this.name = "DesktopFileError";
    this.code = safeCode;
    this.errorCode = errorCode !== undefined && /^E[A-Z]{2,15}$/u.test(errorCode) ? errorCode : undefined;
  }
}

const TYPE_LABELS: Readonly<Record<string, MessageKey>> = {
  "text/*": "widgets.artifacts.type.textAny",
  "text/plain": "widgets.artifacts.type.textPlain",
  "text/markdown": "widgets.artifacts.type.markdown",
  "text/csv": "widgets.artifacts.type.csv",
  "application/json": "widgets.artifacts.type.json",
  "application/pdf": "widgets.artifacts.type.pdf",
  "image/*": "widgets.artifacts.type.imageAny",
  "image/png": "widgets.artifacts.type.png",
  "image/jpeg": "widgets.artifacts.type.jpeg",
  "image/webp": "widgets.artifacts.type.webp",
  "image/gif": "widgets.artifacts.type.gif",
  "audio/*": "widgets.artifacts.type.audioAny",
  "audio/wav": "widgets.artifacts.type.wav",
};

/** One accepted type as a person says it: "ảnh PNG", "text files". A type with no name is shown as itself. */
export function artifactTypeLabel(mime: string, t: Translate): string {
  const key = TYPE_LABELS[mime.trim().toLowerCase()];
  return key === undefined ? t("widgets.artifacts.type.other").replace("{mime}", mime) : t(key);
}

/** The types a widget accepts, as one line; nothing named is everything the node takes. */
export function artifactTypesLabel(accept: readonly string[], t: Translate): string {
  if (accept.length === 0) return t("widgets.artifacts.anyType");
  return [...new Set(accept.map((mime) => artifactTypeLabel(mime, t)))].join(", ");
}

const NODE_REASONS: Readonly<Record<string, MessageKey>> = {
  ARTIFACT_NOT_FOUND: "widgets.artifacts.reason.gone",
  ARTIFACT_EXPIRED: "widgets.artifacts.reason.gone",
  ARTIFACT_BYTES_MISSING: "widgets.artifacts.reason.gone",
  ARTIFACT_CROSS_PRINCIPAL: "widgets.artifacts.reason.notAllowed",
  ARTIFACT_NOT_GRANTED: "widgets.artifacts.reason.notAllowed",
  ARTIFACT_GRANT_REVOKED: "widgets.artifacts.reason.notAllowed",
  ARTIFACT_NOT_CREATOR: "widgets.artifacts.reason.notAllowed",
  ARTIFACT_GRANT_EXPIRED: "widgets.artifacts.reason.grantExpired",
  ARTIFACT_NOT_FINALIZED: "widgets.artifacts.reason.notFinalized",
  ARTIFACT_TOO_LARGE: "widgets.artifacts.reason.tooLarge",
  ARTIFACT_QUOTA_EXCEEDED: "widgets.artifacts.reason.quota",
  ARTIFACT_INSTANCE_QUOTA_EXCEEDED: "widgets.artifacts.reason.instanceQuota",
  ARTIFACT_TYPE_MISMATCH: "widgets.artifacts.reason.typeMismatch",
  ARTIFACT_TYPE_UNSUPPORTED: "widgets.artifacts.reason.typeUnsupported",
  ARTIFACT_TYPE_NOT_ACCEPTED: "widgets.artifacts.reason.typeNotAccepted",
  ARTIFACT_NAME_NOT_ALLOWED: "widgets.artifacts.reason.name",
};

const DESKTOP_REASONS: Readonly<Record<string, MessageKey>> = {
  NOT_A_FILE: "widgets.artifacts.reason.notAFile",
  FILE_TOO_LARGE: "widgets.artifacts.reason.tooLarge",
  READ_FAILED: "widgets.artifacts.reason.readFailed",
  WRITE_FAILED: "widgets.artifacts.reason.writeFailed",
  HANDLE_UNKNOWN: "widgets.artifacts.reason.handleUnknown",
  REPLACE_TYPE_MISMATCH: "widgets.artifacts.reason.replaceTypeMismatch",
  NO_WINDOW: "widgets.artifacts.reason.noWindow",
};

/**
 * Why a file request did not happen, as a sentence for the person.
 *
 * A node refusal is worded by its code; one this page has no sentence for is said generally rather than in the node's
 * English. A desktop refusal is worded by its code too, with the file system's own code after it when there is one. Any
 * other failure — the node unreachable, a bridge that threw — says only that the node could not be reached.
 */
export function artifactReason(cause: unknown, t: Translate): string {
  if (cause instanceof GatewayError) return t(NODE_REASONS[cause.code] ?? "widgets.artifacts.reason.refused");
  if (cause instanceof DesktopFileError) {
    const sentence = t(DESKTOP_REASONS[cause.code] ?? "widgets.artifacts.reason.desktop");
    return cause.errorCode === undefined ? sentence : `${sentence} (${cause.errorCode})`;
  }
  return t("widgets.artifacts.reason.unreachable");
}

/** The desktop dialogs' own words, so a Save As and its Replace question speak the person's language. */
export function desktopDialogLabels(t: Translate): {
  filterName: string;
  replaceTitle: string;
  replaceMessage: string;
  replace: string;
  cancel: string;
} {
  return {
    filterName: t("widgets.artifacts.dialog.filterName"),
    replaceTitle: t("widgets.artifacts.dialog.replaceTitle"),
    replaceMessage: t("widgets.artifacts.dialog.replaceMessage"),
    replace: t("widgets.artifacts.dialog.replace"),
    cancel: t("widgets.artifacts.cancel"),
  };
}
