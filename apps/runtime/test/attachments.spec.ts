import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ATTACHMENT_LIMITS,
  type AttachmentRef,
  type Instant,
} from "@clarkcant/contracts";
import {
  attachmentUsageForPrincipal,
  createConversation,
  getAttachment,
  insertAttachment,
  migrate,
  openDatabase,
  type Database,
} from "@clarkcant/storage";

import {
  attachmentBrief,
  attachmentRefFromRecord,
  releaseConversationAttachments,
} from "../src/attachments.ts";
import { blobsDir, readBlob, sniffContentType, writeBlob } from "../src/blobs.ts";

/**
 * The blob store and the attachment service.
 *
 * Two properties are asserted rather than described, because both of them were wrong in the first
 * draft of this feature and neither is visible from the outside:
 *
 * - **The bytes are written once, by one writer, with one mode.** An attachment and an imported
 *   image land in the same directory with the same content-addressed name and the same `0o600`. A
 *   second writer is how a store acquires two schemes and one of them ends up world-readable beside
 *   the node's identity file.
 * - **A prompt never names a location.** The brief is checked for the data directory, for a path
 *   separator and for the word the storage layer uses, so a future edit that leaks a path fails here
 *   instead of in front of a provider.
 */

const AT = "2026-09-19T05:00:00.000Z" as Instant;
const PRINCIPAL = "prin_owner";
const CONVERSATION = "conv_1";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-attach-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  createConversation(db, { conversationId: CONVERSATION, homeNodeId: "node_local", at: AT });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal PNG header carrying real dimensions, the same fixture shape the image suite uses. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(29);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function pdf(): Uint8Array {
  const body = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n";
  return new TextEncoder().encode(body);
}

function text(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

function store(input: {
  attachmentId: string;
  bytes: Uint8Array;
  extension: string;
  kind: "text" | "image" | "pdf";
  mime: string;
  filename: string;
  conversationId?: string;
}): AttachmentRef {
  const written = writeBlob({ dataDir: dir, bytes: input.bytes, extension: input.extension });
  const record = {
    attachmentId: input.attachmentId,
    principalId: PRINCIPAL,
    conversationId: input.conversationId ?? CONVERSATION,
    filename: input.filename,
    mime: input.mime,
    kind: input.kind,
    sizeBytes: input.bytes.byteLength,
    sha256: written.digest,
    blobPath: written.blobPath,
    createdAt: AT,
  };
  insertAttachment(db, record);
  return attachmentRefFromRecord(record);
}

describe("the node's blob store", () => {
  it("stores bytes whose digest matches the digest it returns", () => {
    const bytes = text("xin chào");
    const written = writeBlob({ dataDir: dir, bytes, extension: "txt" });
    expect(written.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(written.blobRef).toBe(`${written.digest.slice(7, 39)}.txt`);
    const back = readBlob({ dataDir: dir, blobPath: written.blobPath });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    // Compared as bytes: `readFileSync` hands back a Buffer, which is a Uint8Array view rather than
    // a value that deep-equals one.
    expect(Buffer.from(back.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("a stored blob carries the 0o600 mode the image store already uses", () => {
    const written = writeBlob({ dataDir: dir, bytes: text("private"), extension: "txt" });
    // Windows reports a synthesized mode; the assertion that matters there is that the file exists
    // and the mode was requested. On POSIX this is the real check.
    if (process.platform !== "win32") {
      expect(statSync(written.blobPath).mode & 0o777).toBe(0o600);
    } else {
      expect(statSync(written.blobPath).isFile()).toBe(true);
    }
  });

  it("refuses to read outside the blob root", () => {
    const outside = join(dir, "identity.json");
    const outcome = readBlob({ dataDir: dir, blobPath: outside });
    expect(outcome).toMatchObject({ ok: false, code: "BLOB_PATH_ESCAPES_ROOT" });
    const climbing = readBlob({ dataDir: dir, blobPath: join(blobsDir(dir), "..", "..", "etc", "passwd") });
    expect(climbing).toMatchObject({ ok: false, code: "BLOB_PATH_ESCAPES_ROOT" });
  });

  it("reports missing bytes as missing rather than as a fault", () => {
    const outcome = readBlob({ dataDir: dir, blobPath: join(blobsDir(dir), `${"a".repeat(32)}.txt`) });
    expect(outcome).toMatchObject({ ok: false, code: "BLOB_MISSING" });
  });
});

describe("the bytes decide the type", () => {
  it("sniffing refuses a png that is actually a zip", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    const outcome = sniffContentType(zip, "image/png");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("ATTACHMENT_TYPE_UNSUPPORTED");
  });

  it("sniffing refuses bytes that disagree with the declared type", () => {
    const outcome = sniffContentType(pdf(), "image/png");
    expect(outcome).toMatchObject({ ok: false, code: "ATTACHMENT_TYPE_MISMATCH" });
  });

  it("sniffing accepts a pdf and a markdown file", () => {
    expect(sniffContentType(pdf(), "application/pdf")).toMatchObject({ ok: true, mime: "application/pdf", extension: "pdf" });
    expect(sniffContentType(text("# ghi chú\n"), "text/markdown")).toMatchObject({
      ok: true,
      mime: "text/markdown",
      extension: "md",
    });
    expect(sniffContentType(png(2, 3), "image/png")).toMatchObject({ ok: true, mime: "image/png", extension: "png" });
  });

  it("sniffing refuses an empty file", () => {
    expect(sniffContentType(new Uint8Array(0), "text/plain")).toMatchObject({
      ok: false,
      code: "ATTACHMENT_TYPE_UNSUPPORTED",
    });
  });
});

describe("attachments are scoped, counted and releasable", () => {
  it("counts usage per principal from the rows, not from the disk", () => {
    store({ attachmentId: "att_1", bytes: text("12345"), extension: "txt", kind: "text", mime: "text/plain", filename: "a.txt" });
    store({ attachmentId: "att_2", bytes: text("1234567890"), extension: "txt", kind: "text", mime: "text/plain", filename: "b.txt" });
    expect(attachmentUsageForPrincipal(db, PRINCIPAL)).toBe(15);
    expect(attachmentUsageForPrincipal(db, "prin_other")).toBe(0);
  });

  it("scopes a read to the principal that stored it", () => {
    store({ attachmentId: "att_1", bytes: text("mine"), extension: "txt", kind: "text", mime: "text/plain", filename: "a.txt" });
    expect(getAttachment(db, "att_1", PRINCIPAL)?.filename).toBe("a.txt");
    expect(getAttachment(db, "att_1", "prin_other")).toBeUndefined();
  });

  it("releasing a conversation removes its attachment rows and its blobs", () => {
    createConversation(db, { conversationId: "conv_2", homeNodeId: "node_local", at: AT });
    const first = store({
      attachmentId: "att_1",
      bytes: text("kept"),
      extension: "txt",
      kind: "text",
      mime: "text/plain",
      filename: "kept.txt",
    });
    const second = store({
      attachmentId: "att_2",
      bytes: text("removed"),
      extension: "txt",
      kind: "text",
      mime: "text/plain",
      filename: "removed.txt",
      conversationId: "conv_2",
    });

    const released = releaseConversationAttachments({ db, dataDir: dir, conversationId: "conv_2" });

    expect(released.removed).toBe(1);
    expect(getAttachment(db, "att_2", PRINCIPAL)).toBeUndefined();
    expect(getAttachment(db, "att_1", PRINCIPAL)?.attachmentId).toBe(first.attachmentId);
    // The bytes of the released conversation are gone; the other conversation's bytes are not.
    const removed = join(blobsDir(dir), second.blobRef);
    const kept = join(blobsDir(dir), first.blobRef);
    expect(readBlob({ dataDir: dir, blobPath: removed })).toMatchObject({ ok: false, code: "BLOB_MISSING" });
    expect(readBlob({ dataDir: dir, blobPath: kept }).ok).toBe(true);
  });
});

describe("the brief a turn carries", () => {
  it("is empty when there is nothing attached", () => {
    expect(attachmentBrief({ refs: [], dataDir: dir })).toBe("");
  });

  it("names no disk path and no blob path", () => {
    const ref = store({
      attachmentId: "att_1",
      bytes: text("noi dung"),
      extension: "txt",
      kind: "text",
      mime: "text/plain",
      filename: "notes.txt",
    });
    const brief = attachmentBrief({ refs: [ref], dataDir: dir });
    expect(brief).toContain("noi dung");
    expect(brief).toContain("att_1");
    expect(brief).not.toContain(dir);
    expect(brief).not.toContain(blobsDir(dir));
    expect(brief).not.toContain(ref.blobRef);
    expect(brief).not.toContain("blobs");
    /*
     * The claim is "no location", and a mime type is not a location, so the check is for the shapes
     * a location actually has: an absolute POSIX path outside a mime type, a Windows drive path, or
     * the name of a directory this node keeps files in.
     */
    expect(brief).not.toMatch(/(?:^|[\s"'(])\/(?:tmp|home|Users|private|etc|var)\//);
    expect(brief).not.toMatch(/[A-Za-z]:\\/);
  });

  it("tells the model a binary attachment is readable through the tool", () => {
    const ref = store({
      attachmentId: "att_1",
      bytes: png(4, 4),
      extension: "png",
      kind: "image",
      mime: "image/png",
      filename: "hinh.png",
    });
    const brief = attachmentBrief({ refs: [ref], dataDir: dir });
    expect(brief).toContain("read_attachment");
    expect(brief).toContain("hinh.png");
    expect(brief).not.toContain(dir);
  });

  it("shares one text budget across every attachment in the turn", () => {
    // The payload character is one that cannot appear in a mime type or in these file names, so
    // counting it measures the inlined content and nothing else.
    const big = text("z".repeat(ATTACHMENT_LIMITS.inlineBudgetBytesPerTurn));
    const refs = Array.from({ length: 4 }, (_unused, index) =>
      store({
        attachmentId: `att_${index + 1}`,
        bytes: big,
        extension: "txt",
        kind: "text",
        mime: "text/plain",
        filename: `file-${index + 1}.txt`,
      }),
    );
    const brief = attachmentBrief({ refs, dataDir: dir });
    const inlined = brief.split("z").length - 1;
    expect(inlined).toBeLessThanOrEqual(ATTACHMENT_LIMITS.inlineBudgetBytesPerTurn);
    // The first file exhausted the budget, so the later ones are named without their content.
    expect(brief).toContain("ngân sách");
    expect(brief).toContain("file-4.txt");
  });
});
