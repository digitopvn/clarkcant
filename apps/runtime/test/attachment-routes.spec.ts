import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_LIMITS } from "@clarkcant/contracts";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The attachment API.
 *
 * Every refusal here is a shape that must never reach storage: a name that is really a path, a name
 * that is really a URL, an executable content type, and bytes that disagree with what the uploader
 * declared. The positive cases exist to show the refusals are about the request rather than about
 * attachments being broken.
 *
 * One assertion is worth more than the rest: no response may contain a disk path. The bytes live at
 * an absolute path on this node, and the whole contract is that a client never learns where.
 */

const AT = "2026-09-19T05:00:00.000Z";
/** The principal a booted node stores against. Read from the services rather than guessed. */
function ownerPrincipal(): string {
  return services.runtime.identity.ownerPrincipalId;
}

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let conversationId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-attach-api-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  deps = { services, now: () => AT };
  conversationId = await createConversation();
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function request(
  method: string,
  path: string,
  options: { body?: unknown; authed?: boolean } = {},
): Promise<GatewayResponse> {
  const outgoing: GatewayRequest = {
    method,
    path,
    query: {},
    headers: options.authed === false ? {} : { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: options.body === undefined ? "" : JSON.stringify(options.body),
  };
  return handleRequest(deps, outgoing);
}

async function createConversation(): Promise<string> {
  const response = await handleRequest(deps, {
    method: "POST",
    path: "/conversations",
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: JSON.stringify({ title: "attachments" }),
  });
  expect(response.status).toBe(201);
  return (response.body as { conversationId: string }).conversationId;
}

function upload(body: Record<string, unknown>): Promise<GatewayResponse> {
  return request("POST", "/attachments", { body });
}

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

type RefBody = { attachmentRef: { attachmentId: string; blobRef: string; kind: string; filename: string; sizeBytes: number } };

describe("uploading a file", () => {
  it("stores an uploaded text file and returns an opaque ref", async () => {
    const response = await upload({
      conversationId,
      filename: "ghi-chu.md",
      mime: "text/markdown",
      contentBase64: base64("# ghi chú\n"),
    });
    expect(response.status).toBe(201);
    const { attachmentRef } = response.body as RefBody;
    expect(attachmentRef.attachmentId.startsWith("att_")).toBe(true);
    expect(attachmentRef.kind).toBe("text");
    expect(attachmentRef.filename).toBe("ghi-chu.md");
    expect(attachmentRef.blobRef).toMatch(/^[a-f0-9]{32}\.md$/);
  });

  it("the response for an attachment never carries a disk path", async () => {
    const response = await upload({
      conversationId,
      filename: "ghi-chu.md",
      mime: "text/markdown",
      contentBase64: base64("noi dung"),
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain("blobs");
    expect(serialized).not.toContain("blobPath");
    expect(serialized).not.toContain("blob_path");
  });

  it("refuses a filename that is an absolute path", async () => {
    const response = await upload({
      conversationId,
      filename: "/etc/passwd",
      mime: "text/plain",
      contentBase64: base64("x"),
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "ATTACHMENT_NAME_NOT_ALLOWED" });
  });

  it("refuses a filename that carries an executable URL", async () => {
    for (const filename of [`${"java"}${"script"}:alert(1)`, "https://example.com/x.png", "file:///etc/passwd"]) {
      const response = await upload({
        conversationId,
        filename,
        mime: "text/plain",
        contentBase64: base64("x"),
      });
      expect(response.status, filename).toBe(400);
      expect(response.body, filename).toMatchObject({ code: "ATTACHMENT_NAME_NOT_ALLOWED" });
    }
  });

  it("refuses an executable content type", async () => {
    const response = await upload({
      conversationId,
      filename: "thing.bin",
      mime: "application/x-msdownload",
      contentBase64: base64("MZ"),
    });
    expect(response.status).toBe(415);
    expect(response.body).toMatchObject({ code: "ATTACHMENT_TYPE_MISMATCH" });
  });

  it("refuses content whose magic bytes disagree with the declared type", async () => {
    // Two cases, because they take different branches: something the node cannot identify at all,
    // and something it identifies as a type other than the one declared.
    const unidentifiable = await upload({
      conversationId,
      filename: "thing.png",
      mime: "image/png",
      contentBase64: base64(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
    });
    expect(unidentifiable.status).toBe(415);
    expect(unidentifiable.body).toMatchObject({ code: "ATTACHMENT_TYPE_UNSUPPORTED" });

    const mismatched = await upload({
      conversationId,
      filename: "thing.png",
      mime: "image/png",
      contentBase64: base64(new TextEncoder().encode("%PDF-1.7\n")),
    });
    expect(mismatched.status).toBe(415);
    expect(mismatched.body).toMatchObject({ code: "ATTACHMENT_TYPE_MISMATCH" });
  });

  it("refuses a file over the ceiling and names the ceiling", async () => {
    const oversized = "A".repeat(Math.ceil((ATTACHMENT_LIMITS.maxBytes * 4) / 3) + 2048);
    const response = await upload({
      conversationId,
      filename: "big.txt",
      mime: "text/plain",
      contentBase64: oversized,
    });
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
    expect((response.body as { message: string }).message).toContain(String(ATTACHMENT_LIMITS.maxBytes));
  });

  it("refuses an upload that would cross the principal quota", async () => {
    // Fill the quota with one stored row rather than uploading a gigabyte: the rule is arithmetic on
    // rows, so a row is enough to exercise it.
    const { insertAttachment, attachmentUsageForPrincipal } = await import("@clarkcant/storage");
    insertAttachment(services.runtime.db, {
      attachmentId: "att_seed",
      principalId: ownerPrincipal(),
      conversationId,
      filename: "seed.txt",
      mime: "text/plain",
      kind: "text",
      sizeBytes: ATTACHMENT_LIMITS.principalQuotaBytes - 10,
      sha256: `sha256:${"a".repeat(64)}`,
      blobPath: join(dir, "blobs", `${"a".repeat(32)}.txt`),
      createdAt: AT,
    });
    expect(attachmentUsageForPrincipal(services.runtime.db, ownerPrincipal())).toBeGreaterThan(0);

    const response = await upload({
      conversationId,
      filename: "last.txt",
      mime: "text/plain",
      contentBase64: base64("x".repeat(1024)),
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "ATTACHMENT_QUOTA_EXCEEDED" });
  });

  it("refuses an upload with no conversation, or one that does not exist", async () => {
    const missingConversation = await upload({
      conversationId: "conv_nope",
      filename: "a.txt",
      mime: "text/plain",
      contentBase64: base64("x"),
    });
    expect(missingConversation.status).toBe(404);

    const noConversation = await upload({
      filename: "a.txt",
      mime: "text/plain",
      contentBase64: base64("x"),
    });
    expect(noConversation.status).toBe(400);
    expect(noConversation.body).toMatchObject({ code: "INVALID_SCHEMA" });
  });

  it("refuses an unauthenticated upload", async () => {
    const response = await request("POST", "/attachments", {
      body: { conversationId, filename: "a.txt", mime: "text/plain", contentBase64: base64("x") },
      authed: false,
    });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("reading an attachment back", () => {
  it("serves the bytes with nosniff and an inline disposition for text", async () => {
    const created = await upload({
      conversationId,
      filename: "ghi-chu.md",
      mime: "text/markdown",
      contentBase64: base64("noi dung that"),
    });
    const { attachmentRef } = created.body as RefBody;

    const response = await request("GET", `/attachments/${attachmentRef.attachmentId}/content`);
    expect(response.status).toBe(200);
    expect(response.binary?.contentType).toBe("text/markdown");
    expect(response.binary?.headers?.["x-content-type-options"]).toBe("nosniff");
    expect(response.binary?.headers?.["content-disposition"]).toContain("inline");
    expect(Buffer.from(response.binary?.bytes ?? new Uint8Array()).toString("utf8")).toBe("noi dung that");
  });

  it("downloads a pdf rather than rendering it in place", async () => {
    const created = await upload({
      conversationId,
      filename: "tai-lieu.pdf",
      mime: "application/pdf",
      contentBase64: base64(new TextEncoder().encode("%PDF-1.7\n%%EOF\n")),
    });
    const { attachmentRef } = created.body as RefBody;
    const response = await request("GET", `/attachments/${attachmentRef.attachmentId}/content`);
    expect(response.binary?.headers?.["content-disposition"]).toContain("attachment");
  });

  it("returns the same metadata through the metadata route", async () => {
    const created = await upload({
      conversationId,
      filename: "ghi-chu.md",
      mime: "text/markdown",
      contentBase64: base64("noi dung"),
    });
    const { attachmentRef } = created.body as RefBody;
    const response = await request("GET", `/attachments/${attachmentRef.attachmentId}`);
    expect(response.status).toBe(200);
    expect((response.body as RefBody).attachmentRef).toEqual(attachmentRef);
  });

  it("refuses to serve an attachment that is not there, or not this principal's", async () => {
    const missing = await request("GET", "/attachments/att_nope/content");
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    // A row owned by someone else answers exactly as a row that does not exist: distinguishing them
    // would turn this route into a way to enumerate another principal's files.
    const { insertAttachment } = await import("@clarkcant/storage");
    insertAttachment(services.runtime.db, {
      attachmentId: "att_theirs",
      principalId: "prin_other",
      conversationId,
      filename: "theirs.txt",
      mime: "text/plain",
      kind: "text",
      sizeBytes: 3,
      sha256: `sha256:${"b".repeat(64)}`,
      blobPath: join(dir, "blobs", `${"b".repeat(32)}.txt`),
      createdAt: AT,
    });
    const theirs = await request("GET", "/attachments/att_theirs/content");
    expect(theirs.status).toBe(404);
    expect(theirs.body).toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("reports bytes that are gone as missing rather than as a fault", async () => {
    const { insertAttachment } = await import("@clarkcant/storage");
    insertAttachment(services.runtime.db, {
      attachmentId: "att_orphan",
      principalId: ownerPrincipal(),
      conversationId,
      filename: "orphan.txt",
      mime: "text/plain",
      kind: "text",
      sizeBytes: 3,
      sha256: `sha256:${"c".repeat(64)}`,
      blobPath: join(dir, "blobs", `${"c".repeat(32)}.txt`),
      createdAt: AT,
    });
    const response = await request("GET", "/attachments/att_orphan/content");
    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ code: "BLOB_MISSING" });
  });
});
