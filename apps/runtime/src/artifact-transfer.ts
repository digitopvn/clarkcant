import { createHash } from "node:crypto";

import { writeBlob } from "./blobs.ts";
import { peerArtifactUrl } from "./peer-transport.ts";

/**
 * Moving an artifact's bytes from the node that offered them to the node that accepted.
 *
 * The contract is explicit that transfer is a request rather than an implication, and that the digest
 * "is verified after transfer, not merely advertised". Both halves of that are load-bearing here, and
 * neither is a formality:
 *
 * - The receiver pulls. The offering node published an offer and stopped; it does not get to push
 *   bytes because an offer was accepted, because accepting an offer is a decision about *metadata*
 *   and the bytes are the thing being decided about.
 * - The digest is recomputed from what arrived. A peer that offers one file and sends another is
 *   refused, and nothing is written. Advertising a digest is a claim; hashing the bytes is a check.
 * - The declared size is a ceiling, not a promise. A peer cannot push data by declaring it small,
 *   which is the same rule the acceptance check enforces on the offer itself.
 *
 * A refusal here leaves the receiver with no bytes rather than with bytes it cannot vouch for, which
 * is the only useful outcome: an artifact of unknown provenance is worse than a missing one.
 */

export interface ArtifactTransferOptions {
  /** This node's data directory, where the bytes are stored on arrival. */
  dataDir: string;
  /** The offering node's origin, as the peers table recorded it. */
  endpoint: string;
  /** The token this node presents to that peer. Derived, never exchanged. */
  token: string;
  /** The digest the offer named. Recomputed from the bytes that arrive. */
  digest: string;
  /** File extension to store under. A digest cannot carry one. */
  extension: string;
  /** The ceiling the acceptance check agreed to. A body larger than this is refused unread. */
  maxBytes: number;
  timeoutMs?: number;
  /** Injected so a test can drive a peer without a socket. */
  fetchImpl?: typeof fetch;
}

export type ArtifactTransferResult =
  | { ok: true; blobPath: string; blobRef: string; bytes: number }
  | { ok: false; code: "UNREACHABLE" | "REFUSED" | "DIGEST_MISMATCH" | "TOO_LARGE"; message: string };

export async function fetchArtifactFromPeer(options: ArtifactTransferOptions): Promise<ArtifactTransferResult> {
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = AbortSignal.timeout(timeoutMs);

  let url: string;
  try {
    url = peerArtifactUrl(options.endpoint, options.digest);
  } catch (cause) {
    return {
      ok: false,
      code: "UNREACHABLE",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  let response: Response;
  try {
    response = await call(url, {
      method: "GET",
      headers: { authorization: `Bearer ${options.token}` },
      // A peer that answers with a redirect is not followed: the destination is chosen by the peer,
      // and following it would send this node's token wherever the peer pointed.
      redirect: "error",
      signal: deadline,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, code: "UNREACHABLE", message: `the artifact could not be fetched: ${detail}` };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: "REFUSED",
      message: `the offering node refused the transfer with ${String(response.status)}`,
    };
  }

  /*
   * The declared length is checked before the body is read, and the body is checked again after. A
   * peer that understates the length is the case the second check exists for: the first one is a
   * header, and a header is a claim.
   */
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    return {
      ok: false,
      code: "TOO_LARGE",
      message: `the artifact is ${String(declared)} bytes, more than the ${String(options.maxBytes)} this node agreed to accept`,
    };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > options.maxBytes) {
    return {
      ok: false,
      code: "TOO_LARGE",
      message: `the artifact arrived as ${String(bytes.byteLength)} bytes, more than the ${String(options.maxBytes)} this node agreed to accept`,
    };
  }

  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== options.digest) {
    return {
      ok: false,
      code: "DIGEST_MISMATCH",
      message: `the bytes that arrived are not the artifact that was offered: offered ${options.digest.slice(0, 23)}… received ${actual.slice(0, 23)}…`,
    };
  }

  // Written only after the digest matches, so a refusal never leaves an unverifiable file behind.
  const stored = writeBlob({ dataDir: options.dataDir, bytes, extension: options.extension });
  return { ok: true, blobPath: stored.blobPath, blobRef: stored.blobRef, bytes: bytes.byteLength };
}

/** The extension to store an artifact under, derived from the MIME type the offer declared. */
export function extensionForMimeType(mimeType: string): string {
  const known: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/markdown": "md",
    "application/json": "json",
  };
  return known[mimeType.toLowerCase()] ?? "bin";
}
