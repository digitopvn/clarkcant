import { describe, expect, it } from "vitest";

import { ATTACHMENT_LIMITS } from "@clarkcant/contracts";

import {
  attachmentReducer,
  clientAccepts,
  formatFileSize,
  nameForPastedFile,
  readyAttachmentIds,
  toBase64,
  type AttachmentChip,
} from "../src/attachments.ts";

/**
 * The composer's attachment rules, without a browser.
 *
 * The chip list is a small state machine and these are its edges: an upload that lands after its chip was
 * removed must not bring it back, and a message must carry only the ids whose bytes are actually stored.
 * The rest is the contract's own rules, reached from the client side so a person finds out in a millisecond
 * what the node would have told them after a 25 MB upload.
 */

function chip(overrides: Partial<AttachmentChip> = {}): AttachmentChip {
  return {
    id: "chip_1",
    filename: "ghi-chu.md",
    mime: "text/markdown",
    sizeBytes: 2048,
    state: "checking",
    ...overrides,
  };
}

describe("a size a person can read", () => {
  it("formats a file size in the units a person reads", () => {
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(12 * 1024)).toBe("12 KB");
    expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
    // A negative size is not a size, and a dash says so without inventing a unit for it.
    expect(formatFileSize(-1)).toBe("—");
  });
});

describe("what the composer refuses before any upload", () => {
  it("mirrors the server's acceptance rules before an upload is attempted", () => {
    expect(clientAccepts({ filename: "ghi-chu.md", mime: "text/markdown", sizeBytes: 100 })).toEqual({ ok: true });

    const oversized = clientAccepts({
      filename: "to.txt",
      mime: "text/plain",
      sizeBytes: ATTACHMENT_LIMITS.maxBytes + 1,
    });
    expect(oversized).toMatchObject({ ok: false, code: "ATTACHMENT_TOO_LARGE" });

    const unsupported = clientAccepts({ filename: "chay.exe", mime: "application/x-msdownload", sizeBytes: 10 });
    expect(unsupported).toMatchObject({ ok: false, code: "ATTACHMENT_TYPE_UNSUPPORTED" });

    const path = clientAccepts({ filename: "/etc/passwd", mime: "text/plain", sizeBytes: 10 });
    expect(path).toMatchObject({ ok: false, code: "ATTACHMENT_NAME_NOT_ALLOWED" });

    const nameless = clientAccepts({ filename: "   ", mime: "text/plain", sizeBytes: 10 });
    expect(nameless).toMatchObject({ ok: false, code: "ATTACHMENT_NAME_NOT_ALLOWED" });
  });

  it("says why in a sentence that names the number involved", () => {
    const refusal = clientAccepts({
      filename: "to.txt",
      mime: "text/plain",
      sizeBytes: ATTACHMENT_LIMITS.maxBytes + 1,
    });
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.message).toContain(String(ATTACHMENT_LIMITS.maxBytes));
  });
});

describe("the chip list", () => {
  it("a chip can be removed before the message is sent", () => {
    const added = attachmentReducer([], { type: "add", chips: [chip(), chip({ id: "chip_2", filename: "b.txt" })] });
    expect(added).toHaveLength(2);
    expect(attachmentReducer(added, { type: "remove", id: "chip_1" }).map((entry) => entry.id)).toEqual(["chip_2"]);
  });

  it("a failed upload keeps the chip and its reason", () => {
    const added = attachmentReducer([], { type: "add", chips: [chip()] });
    const failed = attachmentReducer(added, {
      type: "failed",
      id: "chip_1",
      reason: "đó là tệp 30 MB, quá trần 25 MB",
    });
    expect(failed[0]).toMatchObject({ state: "failed", reason: "đó là tệp 30 MB, quá trần 25 MB" });
    // Kept across a send, because nothing was sent for it and its reason is the only explanation there is.
    expect(attachmentReducer(failed, { type: "sent" })).toHaveLength(1);
  });

  it("an upload that finishes after its chip was removed does not bring it back", () => {
    const added = attachmentReducer([], { type: "add", chips: [chip()] });
    const removed = attachmentReducer(added, { type: "remove", id: "chip_1" });
    const late = attachmentReducer(removed, { type: "stored", id: "chip_1", attachmentId: "att_1" });
    expect(late).toEqual([]);
  });

  it("carries only the ids whose bytes are stored, in the order they were added", () => {
    let state = attachmentReducer([], {
      type: "add",
      chips: [chip(), chip({ id: "chip_2", filename: "b.txt" }), chip({ id: "chip_3", filename: "c.txt" })],
    });
    state = attachmentReducer(state, { type: "stored", id: "chip_1", attachmentId: "att_1" });
    state = attachmentReducer(state, { type: "failed", id: "chip_2", reason: "bị từ chối" });
    state = attachmentReducer(state, { type: "stored", id: "chip_3", attachmentId: "att_3" });
    expect(readyAttachmentIds(state)).toEqual(["att_1", "att_3"]);
  });

  it("clearing after a send removes the stored chips and leaves the failed ones", () => {
    let state = attachmentReducer([], { type: "add", chips: [chip(), chip({ id: "chip_2", filename: "b.txt" })] });
    state = attachmentReducer(state, { type: "stored", id: "chip_1", attachmentId: "att_1" });
    state = attachmentReducer(state, { type: "failed", id: "chip_2", reason: "bị từ chối" });
    expect(attachmentReducer(state, { type: "sent" }).map((entry) => entry.id)).toEqual(["chip_2"]);
  });
});

describe("a file with no name", () => {
  it("a pasted file without a name gets one derived from its type", () => {
    const at = new Date("2026-09-19T05:30:00.000Z");
    expect(nameForPastedFile("image/png", at)).toBe("pasted-2026-09-19T05-30-00.png");
    expect(nameForPastedFile("image/jpeg", at)).toBe("pasted-2026-09-19T05-30-00.jpg");
    expect(nameForPastedFile("text/plain", at)).toBe("pasted-2026-09-19T05-30-00.txt");
    expect(nameForPastedFile("image/png; charset=binary", at)).toBe("pasted-2026-09-19T05-30-00.png");
    // Whatever it is, the name the node will see is one it accepts.
    expect(clientAccepts({ filename: nameForPastedFile("image/png", at), mime: "image/png", sizeBytes: 10 })).toEqual({
      ok: true,
    });
  });
});

describe("encoding the bytes", () => {
  it("encodes a file larger than the argument limit without overflowing the stack", () => {
    // The failure this exists for is a stack overflow, which reads as nothing to do with the file, so the
    // size is chosen to be well past the spread limit rather than near it.
    const bytes = new Uint8Array(200_000).fill(65);
    const encoded = toBase64(bytes);
    expect(Buffer.from(encoded, "base64")).toEqual(Buffer.from(bytes));
  });

  it("encodes a multi-byte file exactly", () => {
    const bytes = new TextEncoder().encode("nội dung tiếng Việt");
    expect(Buffer.from(toBase64(bytes), "base64").toString("utf8")).toBe("nội dung tiếng Việt");
  });
});
