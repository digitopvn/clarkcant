import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_LIMITS } from "@clarkcant/contracts";
import { insertAttachment } from "@clarkcant/storage";

import { writeBlob } from "../src/blobs.ts";
import { createReadAttachmentTool } from "../src/node-tools.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The one reading path a prompt points at.
 *
 * The tool takes an attachment id and nothing else, which is the design rather than a simplification:
 * there is no path argument to escape from and no relative form to resolve, so a file's content cannot
 * steer the model into reading a different file. These tests are about that boundary — an id from another
 * principal, an id from another conversation, and an id that is really a path.
 *
 * The last case is the honest one. This node has no extractor for images or PDFs, and a tool that
 * answered a picture with silence would read to the model as an empty file, which it would then summarise.
 */

const AT = "2026-09-19T07:00:00.000Z";

let dir: string;
let services: NodeServices;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-read-attachment-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function owner(): string {
  return services.runtime.identity.ownerPrincipalId;
}

/** Store a file the way the upload route does, and hand back the id it was stored under. */
function store(input: {
  attachmentId: string;
  filename: string;
  mime: string;
  kind: "text" | "image" | "pdf";
  bytes: Uint8Array;
  principalId?: string;
  conversationId?: string;
  extension?: string;
}): string {
  const written = writeBlob({ dataDir: dir, bytes: input.bytes, extension: input.extension ?? "bin" });
  insertAttachment(services.runtime.db, {
    attachmentId: input.attachmentId,
    principalId: input.principalId ?? owner(),
    conversationId: input.conversationId ?? "conv_here",
    filename: input.filename,
    mime: input.mime,
    kind: input.kind,
    sizeBytes: input.bytes.byteLength,
    sha256: written.digest,
    blobPath: written.blobPath,
    createdAt: AT,
  });
  return input.attachmentId;
}

function tool(conversationId = "conv_here") {
  return createReadAttachmentTool({
    db: services.runtime.db as never,
    principalId: owner(),
    conversationId,
    dataDir: dir,
  });
}

async function read(attachmentId: unknown, conversationId = "conv_here"): Promise<string> {
  const result = await tool(conversationId).execute({ attachmentId });
  return result.text;
}

describe("reading an attached file", () => {
  it("reads a text attachment that belongs to the conversation", async () => {
    const id = store({
      attachmentId: "att_text",
      filename: "ghi-chu.md",
      mime: "text/markdown",
      kind: "text",
      bytes: new TextEncoder().encode("# Ghi chú\nNội dung cần đọc."),
      extension: "md",
    });

    const text = await read(id);
    expect(text).toContain("Nội dung cần đọc.");
    expect(text).toContain("ghi-chu.md");
    // The reading path is the id, so nothing about where the bytes live comes back out.
    expect(text).not.toContain(dir);
    expect(text).not.toContain("blobs");
  });

  it("truncates at the same ceiling the prompt's inline budget uses", async () => {
    const id = store({
      attachmentId: "att_long",
      filename: "dai.txt",
      mime: "text/plain",
      kind: "text",
      bytes: new TextEncoder().encode("A".repeat(ATTACHMENT_LIMITS.inlineBudgetBytesPerTurn + 4096)),
      extension: "txt",
    });

    const text = await read(id);
    expect(text).toContain("đã lược bớt");
    // The ceiling is the text's, not the wrapper's: checked by measuring the payload rather than asserting
    // a magic length, so changing the wording does not quietly change the limit.
    const payload = text.split("\n").filter((line) => line.startsWith("A")).join("");
    expect(payload.length).toBeLessThanOrEqual(ATTACHMENT_LIMITS.inlineBudgetBytesPerTurn);
  });

  it("refuses an attachment that belongs to another principal", async () => {
    const id = store({
      attachmentId: "att_theirs",
      filename: "rieng.txt",
      mime: "text/plain",
      kind: "text",
      bytes: new TextEncoder().encode("bí mật"),
      principalId: "prin_ai_khac",
      extension: "txt",
    });

    const text = await read(id);
    expect(text).not.toContain("bí mật");
    expect(text).toBe("Không có tệp đính kèm nào với id đó trong cuộc hội thoại này.");
  });

  it("refuses an attachment that belongs to another conversation", async () => {
    const id = store({
      attachmentId: "att_elsewhere",
      filename: "noi-khac.txt",
      mime: "text/plain",
      kind: "text",
      bytes: new TextEncoder().encode("của cuộc khác"),
      conversationId: "conv_khac",
      extension: "txt",
    });

    const text = await read(id);
    expect(text).not.toContain("của cuộc khác");
    // The same sentence as the other refusals, so the answer cannot be used to ask which ids exist.
    expect(text).toBe("Không có tệp đính kèm nào với id đó trong cuộc hội thoại này.");
  });

  it("refuses an id that is not an attachment id", async () => {
    // Path-like values: the refusal must not echo them, or the model could read its own argument back as a
    // path it had successfully named.
    for (const value of [
      "/etc/passwd",
      "../../../etc/passwd",
      "C:\\Windows\\win.ini",
      "blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt",
      "conv_1",
    ]) {
      const text = await read(value);
      expect(text, value).toContain("attachment id");
      expect(text, value).not.toContain(value);
    }

    // And the shapes that are merely not ids. The answer names the expected format, which is why `att_` is
    // allowed to appear in it: telling the model what an id looks like is not telling it which ids exist.
    for (const value of ["att_", "", 12345, { path: "/etc/passwd" }]) {
      expect(await read(value), JSON.stringify(value)).toContain("attachment id");
    }
  });

  it("refuses a missing argument as firmly as a malformed one", async () => {
    expect(await tool().execute({})).toMatchObject({ text: expect.stringContaining("attachment id") });
  });
});

describe("a binary attachment", () => {
  it("answers honestly that a binary attachment has no extractor yet", async () => {
    const id = store({
      attachmentId: "att_png",
      filename: "anh.png",
      mime: "image/png",
      kind: "image",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      extension: "png",
    });

    const text = await read(id);
    expect(text).toContain("anh.png");
    expect(text).toContain("image/png");
    // Said in words, so the model does not fill the gap with invented detail.
    expect(text).toContain("chưa có bộ trích");
    expect(text).toContain("Đừng đoán nội dung.");
    expect(text).not.toContain(dir);
  });

  it("reads the text out of a pdf rather than naming it", async () => {
    const id = store({
      attachmentId: "att_pdf",
      filename: "tai-lieu.pdf",
      mime: "application/pdf",
      kind: "pdf",
      bytes: new TextEncoder().encode(
        "%PDF-1.4\n4 0 obj << /Length 40 >>\nstream\nBT (Noi dung trong PDF) Tj ET\nendstream\nendobj\n%%EOF\n",
      ),
      extension: "pdf",
    });

    const text = await read(id);
    // The file's own words, which is what the issue asks an attachment to give the agent.
    expect(text).toContain("Noi dung trong PDF");
    expect(text).toContain("tai-lieu.pdf");
  });

  it("names a pdf it cannot read, with the reason rather than an empty answer", async () => {
    const id = store({
      attachmentId: "att_pdf_flat",
      filename: "tai-lieu.pdf",
      mime: "application/pdf",
      kind: "pdf",
      bytes: new TextEncoder().encode("%PDF-1.7\n%%EOF\n"),
      extension: "pdf",
    });

    const text = await read(id);
    expect(text).toContain("tai-lieu.pdf");
    expect(text).toMatch(/no text operators/i);
  });
});

describe("a file whose bytes are gone", () => {
  it("says the file is missing rather than answering with nothing", async () => {
    insertAttachment(services.runtime.db, {
      attachmentId: "att_orphan",
      principalId: owner(),
      conversationId: "conv_here",
      filename: "mat-roi.txt",
      mime: "text/plain",
      kind: "text",
      sizeBytes: 5,
      sha256: `sha256:${"d".repeat(64)}`,
      blobPath: join(dir, "blobs", `${"d".repeat(32)}.txt`),
      createdAt: AT,
    });

    const text = await read("att_orphan");
    expect(text).toContain("mat-roi.txt");
    // The reader's own sentence, in words: a message whose bytes are gone is a missing file the model can
    // report, not an empty file it would then summarise as having no content.
    expect(text).toContain("no longer on disk");
    expect(text).not.toContain(dir);
  });
});
