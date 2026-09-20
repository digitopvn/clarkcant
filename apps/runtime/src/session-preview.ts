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
