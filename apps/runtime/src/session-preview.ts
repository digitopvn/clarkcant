import { type Instant, nowInstant } from "@clarkcant/contracts";

import { detectImageFormat, writeBlob } from "./blobs.ts";

/**
 * A preview of a session, stored as bytes this node can serve.
 *
 * A takeover card has to show the screen the agent is driving, and the two failure modes are both about claiming
 * more than is there: showing a stale frame as if it were live, and showing an empty frame as if it were the
 * screen. So the capture happens when somebody asks, the bytes are checked to be an image before they are stored,
 * and the viewport travels with them — a preview without the size it was taken at cannot be laid out honestly.
 *
 * The capture is injected rather than called here. That is not only for tests: the driver that captures is a
 * browser, and this module's job is what happens to the bytes afterwards.
 */

export const SESSION_PREVIEW_STATUS = "capture-to-blob-implemented";

export interface SessionPreviewCapture {
  bytes: Uint8Array;
  contentType: string;
  viewport: { width: number; height: number };
}

export interface SessionPreviewInput {
  dataDir: string;
  /** The capture. Injected so the store can be proven without launching a browser. */
  capture: () => Promise<SessionPreviewCapture>;
  /**
   * The ceiling a preview may take. A frame is a few hundred kilobytes, so this is a guard rather than an
   * expectation: a capture that returns something enormous is not a frame, and storing it would be the node
   * keeping a file it cannot explain.
   */
  maxBytes?: number;
}

export type SessionPreviewResult =
  | {
      ok: true;
      blobPath: string;
      blobRef: string;
      digest: string;
      bytes: number;
      contentType: string;
      viewport: { width: number; height: number };
    }
  | { ok: false; code: "CAPTURE_FAILED" | "TOO_LARGE" | "NOT_AN_IMAGE"; message: string };

/**
 * A browser, narrowed to the one method this path needs.
 *
 * Not the packs' `BrowserDriver`: what this module is about is the bytes, so a driver that can hand it a frame is
 * all it may require. The pack's driver satisfies this without being named here, and a test can satisfy it with
 * something that is not a browser at all.
 */
export interface SessionPreviewDriver {
  capturePreview(): Promise<SessionPreviewCapture>;
}

export interface SessionPreviewCaptureRequest {
  dataDir: string;
  driver: SessionPreviewDriver;
  /** The node's clock, injected so a test can pin the instant instead of reading the wall. */
  at?: () => Instant;
  maxBytes?: number;
}

/**
 * A frame that was captured, stored and stamped, or the reason it was not.
 *
 * `capturedAt` is the moment the frame was taken. It travels with the bytes because a card without it cannot say
 * what it is showing, and it is deliberately **not** part of the store's own answer: the store does not know when
 * a driver took the picture, and a store that guessed would let a card claim a moment nobody observed.
 */
export type SessionPreviewCaptureOutcome =
  | {
      ok: true;
      digest: string;
      blobRef: string;
      bytes: number;
      contentType: string;
      viewport: { width: number; height: number };
      capturedAt: Instant;
    }
  | Extract<SessionPreviewResult, { ok: false }>;

/**
 * Capture the screen through a driver and store it as this node's frame.
 *
 * The whole real path in one call, and the stamp is taken **inside** the capture rather than before it: the instant
 * a card shows has to be the instant the driver was asked, because a caller that stamped its own frame would be
 * reporting a moment it never observed. Everything after that — the size guard, the sniffed type, the content
 * address — is `storeSessionPreview`'s, so there is one implementation of what a stored frame is.
 */
export async function captureSessionPreview(
  input: SessionPreviewCaptureRequest,
): Promise<SessionPreviewCaptureOutcome> {
  const at = input.at ?? ((): Instant => nowInstant());
  let capturedAt: Instant | undefined;
  const stored = await storeSessionPreview({
    dataDir: input.dataDir,
    capture: () => {
      capturedAt = at();
      return input.driver.capturePreview();
    },
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  });
  if (!stored.ok) return stored;
  if (capturedAt === undefined) {
    // Unreachable by construction — the store only reports success once the capture it was handed has run — and
    // reported rather than asserted, so a frame can never be handed on with no moment attached to it.
    return { ok: false, code: "CAPTURE_FAILED", message: "the frame was stored without the moment it was taken" };
  }
  return {
    ok: true,
    digest: stored.digest,
    blobRef: stored.blobRef,
    bytes: stored.bytes,
    contentType: stored.contentType,
    viewport: stored.viewport,
    capturedAt,
  };
}

export async function storeSessionPreview(input: SessionPreviewInput): Promise<SessionPreviewResult> {
  let captured: SessionPreviewCapture;
  try {
    captured = await input.capture();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, code: "CAPTURE_FAILED", message: `the screen could not be captured: ${detail}` };
  }

  const maxBytes = input.maxBytes ?? 8 * 1024 * 1024;
  if (captured.bytes.byteLength > maxBytes) {
    return {
      ok: false,
      code: "TOO_LARGE",
      message: `the capture is ${String(captured.bytes.byteLength)} bytes, more than the ${String(maxBytes)} a preview may take`,
    };
  }

  /*
   * The bytes decide the type, not the declaration. A capture that returned JSON or an error page would otherwise
   * be stored and rendered as a frame, which is the same mistake the attachment path refuses: a card showing
   * something that is not the screen as if it were the screen.
   */
  const format = detectImageFormat(captured.bytes);
  if (format === undefined) {
    return {
      ok: false,
      code: "NOT_AN_IMAGE",
      message: `the capture is not an image this node can show (declared ${captured.contentType})`,
    };
  }

  // The sniffed type rather than the declared one, because the card renders what is actually there. The extension
  // follows from it: a digest cannot carry one, so the blob's name has to be told what it holds.
  const extension = format.mimeType === "image/jpeg" ? "jpg" : format.mimeType.slice("image/".length);
  const stored = writeBlob({ dataDir: input.dataDir, bytes: captured.bytes, extension });
  return {
    ok: true,
    blobPath: stored.blobPath,
    blobRef: stored.blobRef,
    digest: stored.digest,
    bytes: captured.bytes.byteLength,
    contentType: format.mimeType,
    viewport: captured.viewport,
  };
}
