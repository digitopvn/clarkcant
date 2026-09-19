import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isWithinRoot } from "./path-roots.ts";

/**
 * The node's blob store.
 *
 * One writer for every kind of byte this node keeps — an imported image, an attached file — because
 * a second writer is how a store acquires two naming schemes, two digest implementations and two
 * file modes, and only one of them gets the mode right. The image store already wrote
 * content-addressed names with `mode: 0o600` under `dataDir/blobs`; this module is that code, lifted
 * out so an attachment cannot land world-readable beside the node's identity file by accident.
 *
 * Three properties are load-bearing:
 *
 * - **Content-addressed.** The name is the first 32 hex characters of the SHA-256 of the bytes, so
 *   identical files are one file and a name cannot be chosen by a caller.
 * - **Owner-only.** `mode: 0o600`. These bytes are the user's; nobody else on the machine has a
 *   reason to read them, and a default umask would otherwise hand them to every account on the host.
 * - **Containment re-checked on read.** A row in the database is a reference, and a reference that
 *   was edited by hand must not become an arbitrary file read, so the resolved path is checked
 *   against the blob root before anything is opened. A length or pattern limit is not a security
 *   boundary; this check is.
 */

export function blobsDir(dataDir: string): string {
  return join(dataDir, "blobs");
}

export type BlobWriteResult = {
  /** Absolute path on this node. Never returned to a client and never put in a prompt. */
  blobPath: string;
  /** `sha256:<64 hex>`, the same shape the image store records. */
  digest: string;
  /** The file name inside the blob directory: content-addressed, and not a path. */
  blobRef: string;
};

export function writeBlob(input: {
  dataDir: string;
  bytes: Uint8Array;
  /** File extension without the dot, e.g. `png`, `pdf`, `md`. */
  extension: string;
}): BlobWriteResult {
  const digest = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`;
  const directory = blobsDir(input.dataDir);
  mkdirSync(directory, { recursive: true });
  const blobRef = `${digest.slice("sha256:".length, "sha256:".length + 32)}.${input.extension}`;
  const blobPath = join(directory, blobRef);
  writeFileSync(blobPath, input.bytes, { mode: 0o600 });
  return { blobPath, digest, blobRef };
}

export type BlobReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: "BLOB_MISSING" | "BLOB_PATH_ESCAPES_ROOT"; message: string };

/**
 * Read back the bytes a stored row points at.
 *
 * `BLOB_MISSING` is deliberately distinct from a server fault: a row whose bytes are gone is a
 * missing file the interface can explain, and the row stays so the reader can see what was there.
 */
export function readBlob(input: { dataDir: string; blobPath: string }): BlobReadResult {
  const root = resolve(blobsDir(input.dataDir));
  const target = resolve(input.blobPath);
  if (!isWithinRoot(root, target)) {
    return {
      ok: false,
      code: "BLOB_PATH_ESCAPES_ROOT",
      message: "the stored blob path is outside the blob directory",
    };
  }
  try {
    return { ok: true, bytes: readFileSync(target) };
  } catch {
    return { ok: false, code: "BLOB_MISSING", message: "the stored bytes for that file are no longer on disk" };
  }
}

/** Remove bytes this node wrote. A file that is already gone is not an error. */
export function removeBlob(input: { dataDir: string; blobPath: string }): boolean {
  const root = resolve(blobsDir(input.dataDir));
  const target = resolve(input.blobPath);
  if (!isWithinRoot(root, target)) return false;
  try {
    unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * What the bytes actually are
 * ------------------------------------------------------------------ */

export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export type ImageFormat = {
  mimeType: (typeof ALLOWED_IMAGE_TYPES)[number];
  width: number | undefined;
  height: number | undefined;
};

/**
 * Identify an image from its own bytes.
 *
 * The declared MIME type is not trusted and the extension is not consulted, because both are
 * supplied by whoever is uploading. This is the one implementation: the image importer needs the
 * dimensions it returns, and the attachment path needs the format, and neither may disagree.
 */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR at offset 16.
  if (
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }

  // JPEG: FF D8 FF, then scan for a start-of-frame marker carrying the dimensions.
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return {
          mimeType: "image/jpeg",
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
        };
      }
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
    return { mimeType: "image/jpeg", width: undefined, height: undefined };
  }

  // GIF: "GIF87a" or "GIF89a", little-endian dimensions.
  if (bytes.byteLength >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === "GIF") {
    return { mimeType: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // WebP: "RIFF" .... "WEBP".
  if (
    bytes.byteLength >= 16 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X") {
      const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
      const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
      return { mimeType: "image/webp", width, height };
    }
    return { mimeType: "image/webp", width: undefined, height: undefined };
  }

  return undefined;
}

export type ContentTypeSniff =
  | { ok: true; mime: string; extension: string }
  | { ok: false; code: "ATTACHMENT_TYPE_MISMATCH" | "ATTACHMENT_TYPE_UNSUPPORTED"; message: string };

/**
 * Decide what an uploaded file is, from its bytes.
 *
 * The declared type is a claim and this is the check that has to hold: a declared `image/png` whose
 * bytes are a zip is refused, and a refused candidate is never stored under the type the client
 * asked for. `text/html` is not in this set and cannot be reached here, which is what keeps the
 * content route from ever serving a document that a browser would execute.
 *
 * Text has no magic bytes, so the test is the honest one: it must decode as UTF-8 and must not carry
 * a NUL byte in its first kilobyte. A binary file that happens to pass that test would be treated as
 * text and inlined into a prompt, which is a wrong answer rather than an unsafe one.
 */
export function sniffContentType(bytes: Uint8Array, declaredMime: string): ContentTypeSniff {
  if (bytes.byteLength === 0) {
    return { ok: false, code: "ATTACHMENT_TYPE_UNSUPPORTED", message: "the file is empty" };
  }

  const declared = declaredMime.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  const image = detectImageFormat(bytes);
  if (image !== undefined) {
    if (declared !== "" && declared !== image.mimeType) {
      return {
        ok: false,
        code: "ATTACHMENT_TYPE_MISMATCH",
        message: `the file is a ${image.mimeType} but was declared as ${declared}`,
      };
    }
    return { ok: true, mime: image.mimeType, extension: image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1] ?? "bin" };
  }

  if (hasPdfHeader(bytes)) {
    if (declared !== "" && declared !== "application/pdf") {
      return {
        ok: false,
        code: "ATTACHMENT_TYPE_MISMATCH",
        message: `the file is a pdf but was declared as ${declared}`,
      };
    }
    return { ok: true, mime: "application/pdf", extension: "pdf" };
  }

  if (looksLikeText(bytes)) {
    const textMime = declared === "" ? "text/plain" : declared;
    if (!TEXT_MIMES.includes(textMime)) {
      return {
        ok: false,
        code: "ATTACHMENT_TYPE_MISMATCH",
        message: `the file reads as text but was declared as ${declared}`,
      };
    }
    return { ok: true, mime: textMime, extension: extensionForText(textMime) };
  }

  return {
    ok: false,
    code: "ATTACHMENT_TYPE_UNSUPPORTED",
    message: declared === "" ? "the file is not an image, a pdf or readable text" : `${declared} does not match the file's bytes`,
  };
}

const TEXT_MIMES: readonly string[] = ["text/plain", "text/markdown", "text/csv", "application/json"];

function extensionForText(mime: string): string {
  if (mime === "text/markdown") return "md";
  if (mime === "text/csv") return "csv";
  if (mime === "application/json") return "json";
  return "txt";
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
}

/**
 * Whether the bytes are plausibly text.
 *
 * Three conditions, all cheap, and the middle one is what stops a binary file from being treated as
 * text just because it happens to decode: no NUL anywhere in the first kilobyte, no control byte
 * other than tab, newline and carriage return, and the whole thing decodes as UTF-8. `TextDecoder`
 * with `fatal` is the platform doing the decoding rather than a hand-rolled table.
 *
 * A zip header (`PK\x03\x04`) is the case this exists for: it decodes as UTF-8 and carries no NUL,
 * so without the control-byte test it would be inlined into a prompt as text.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  for (const byte of head) {
    if (byte === 0) return false;
    const printable = byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte !== 0x7f);
    if (!printable) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
