import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readBlob } from "../src/blobs.ts";
import { storeSessionPreview } from "../src/session-preview.ts";

/**
 * A preview of a session, stored as bytes (V14).
 *
 * A takeover card has to show the screen the agent is driving, and both ways of getting that wrong are about
 * claiming more than is there: a stale frame shown as live, and an empty frame shown as the screen. So the bytes
 * are checked to be an image before they are stored — the declaration is not evidence — and the viewport travels
 * with them, because a preview without the size it was taken at cannot be laid out honestly.
 *
 * The capture is injected, so what is tested here is what happens to the bytes rather than whether a browser
 * started. The browser half is the driver's, which its own suite launches for real.
 */

let dirs: string[] = [];

function tempDir(): string {
  const made = mkdtempSync(join(tmpdir(), "clarkcant-preview-"));
  dirs.push(made);
  return made;
}

afterEach(() => {
  for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true });
  dirs = [];
});

/**
 * A minimal PNG: the signature, the IHDR length and tag, then the dimensions the sniffer reads at offsets 16 and
 * 20. Twelve bytes of signature is not enough for it to call something an image, which is the point of a sniffer.
 */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length and tag
  0x00, 0x00, 0x05, 0x00, // width 1280
  0x00, 0x00, 0x02, 0xd0, // height 720
  0x08, 0x06, 0x00, 0x00, 0x00,
]);

const capture = (bytes: Uint8Array, contentType = "image/png") => async () => ({
  bytes,
  contentType,
  viewport: { width: 1280, height: 720 },
});

describe("storing a session preview", () => {
  it("stores a real frame and keeps the viewport it was taken at", async () => {
    const dataDir = tempDir();
    const result = await storeSessionPreview({ dataDir, capture: capture(PNG) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentType).toBe("image/png");
    expect(result.viewport).toEqual({ width: 1280, height: 720 });
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Readable back as the same bytes, which is what the card will be served.
    const back = readBlob({ dataDir, blobPath: result.blobPath });
    expect(back.ok).toBe(true);
    expect(back.ok && Array.from(back.bytes)).toEqual(Array.from(PNG));
  });

  it("believes the bytes rather than the declaration", async () => {
    const dataDir = tempDir();
    // A capture that claims to be a PNG and is not: an error page, or a JSON body. Rendering that as the screen
    // is the failure this check exists for.
    const result = await storeSessionPreview({
      dataDir,
      capture: capture(new TextEncoder().encode('{"error":"the page did not load"}')),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("NOT_AN_IMAGE");
    expect(result.ok ? "" : result.message).toContain("image/png");
  });

  it("reports a capture that failed instead of storing nothing quietly", async () => {
    const result = await storeSessionPreview({
      dataDir: tempDir(),
      capture: () => Promise.reject(new Error("the browser is gone")),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("CAPTURE_FAILED");
    expect(result.ok ? "" : result.message).toContain("the browser is gone");
  });

  it("refuses a capture larger than a preview may take", async () => {
    const result = await storeSessionPreview({
      dataDir: tempDir(),
      capture: capture(PNG),
      maxBytes: 4,
    });

    expect(result.ok ? "" : result.code).toBe("TOO_LARGE");
  });

  it("reports the type it found, not the one that was declared", async () => {
    const result = await storeSessionPreview({
      dataDir: tempDir(),
      // A JPEG body declared as a PNG. The card renders what is actually there.
      capture: capture(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]), "image/png"),
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.contentType : "").toBe("image/jpeg");
  });
});
