import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARTIFACT_LIMITS, ATTACHMENT_LIMITS, type Instant } from "@clarkcant/contracts";
import { createInstance } from "@clarkcant/core";
import { TABLE } from "@clarkcant/data-canvas";
import { getArtifactGrant, getBrokerArtifact, insertAttachment, insertBrokerArtifact, putArtifactGrant } from "@clarkcant/storage";

import {
  type ArtifactBrokerDeps,
  appendArtifactChunk,
  createWorkingArtifact,
  readArtifactRange,
  releaseConversationArtifacts,
  sweepExpiredArtifacts,
} from "../src/artifact-broker.ts";
import { attachmentBrief, releaseConversationAttachments } from "../src/attachments.ts";
import {
  appendStagedBlob,
  createStagedBlob,
  readBlobRange,
  sealStagedBlob,
  stagingDir,
} from "../src/blobs.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { createReadAttachmentTool } from "../src/node-tools.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The ArtifactRef broker, through the node's routes.
 *
 * A widget holds a ref; the node holds the permission. These tests hold the broker to the three things that follow:
 * every use is re-judged against the instance's grant (another instance, another principal, an expired or revoked
 * grant are all refused, each with its own reason), bytes move in bounded chunks and ranges with type, size and quota
 * enforced, and nothing a route answers names where the bytes are.
 */

const AT = "2026-09-30T08:00:00.000Z";

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let conversationId: string;
let instanceId: string;

function owner(): string {
  return services.runtime.identity.ownerPrincipalId;
}

function instance(ownerPrincipalId = owner()): string {
  return createInstance(services.conductor, {
    definition: TABLE,
    packageDigest: "sha256:table",
    ownerPrincipalId: ownerPrincipalId as never,
    props: { title: "Tệp", datasetRef: "dataset_none", columns: ["name"] },
  }).instanceId;
}

function brokerAt(nowIso: string): ArtifactBrokerDeps {
  return {
    db: services.runtime.db,
    dataDir: dir,
    nodeId: services.runtime.identity.nodeId,
    newId: (prefix) => services.conductor.newId(prefix),
    now: () => new Date(nowIso),
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  query: Record<string, string> = {},
): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query,
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

const widget = (suffix = "", target = instanceId): string =>
  `/conversations/${conversationId}/widgets/${target}/artifacts${suffix}`;

type RefBody = { artifactRef: { artifactId: string; kind: string; sizeBytes: number; digest?: string; mimeType: string; name: string } };

async function create(mimeType = "text/plain", name?: string, target = instanceId): Promise<string> {
  const response = await call("POST", widget("", target), { mimeType, ...(name === undefined ? {} : { name }) });
  expect(response.status).toBe(201);
  return (response.body as RefBody).artifactRef.artifactId;
}

async function write(artifactId: string, offset: number, bytes: Uint8Array | string, target = instanceId): Promise<GatewayResponse> {
  return call("POST", widget(`/${artifactId}/chunks`, target), { offset, contentBase64: Buffer.from(bytes).toString("base64") });
}

function textBytes(size: number): Uint8Array {
  // ASCII, so cutting at any byte count still leaves valid UTF-8 text for the sniff.
  const line = "dong van ban thu nghiem 0123456789\n";
  return new TextEncoder().encode(line.repeat(Math.ceil(size / line.length))).subarray(0, size);
}

function expectNoLocation(response: GatewayResponse): void {
  const serialized = JSON.stringify(response.body ?? null);
  expect(serialized).not.toContain(dir);
  expect(serialized).not.toContain("blobPath");
  expect(serialized).not.toContain("staging");
  expect(serialized).not.toContain(".part");
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-artifact-broker-"));
  services = bootNodeServices({ dataDir: dir, label: "artifact broker test node" });
  deps = { services, now: () => AT as never };
  const created = await call("POST", "/conversations", { title: "tệp" });
  conversationId = (created.body as { conversationId: string }).conversationId;
  instanceId = instance();
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("staged blobs", () => {
  it("streams a file larger than one chunk in order and reads it back range by range", () => {
    const bytes = textBytes(ARTIFACT_LIMITS.chunkBytes * 2 + 1234);
    expect(createStagedBlob({ dataDir: dir, stagingRef: "art_stream.part" })).toEqual({ ok: true, sizeBytes: 0 });
    let size = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += ARTIFACT_LIMITS.chunkBytes) {
      const chunk = bytes.subarray(offset, offset + ARTIFACT_LIMITS.chunkBytes);
      const appended = appendStagedBlob({ dataDir: dir, stagingRef: "art_stream.part", expectedSize: size, bytes: chunk });
      expect(appended.ok).toBe(true);
      size += chunk.byteLength;
    }
    // A chunk sent again is refused instead of stored twice.
    expect(appendStagedBlob({ dataDir: dir, stagingRef: "art_stream.part", expectedSize: 0, bytes: bytes.subarray(0, 10) })).toMatchObject({
      ok: false,
      code: "STAGING_OFFSET_MISMATCH",
      sizeBytes: bytes.byteLength,
    });

    const sealed = sealStagedBlob({ dataDir: dir, stagingRef: "art_stream.part", extension: "txt" });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.sizeBytes).toBe(bytes.byteLength);
    expect(existsSync(join(stagingDir(dir), "art_stream.part"))).toBe(false);

    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += ARTIFACT_LIMITS.maxReadBytes) {
      const read = readBlobRange({ dataDir: dir, location: { blobPath: sealed.blobPath }, offset, length: ARTIFACT_LIMITS.maxReadBytes });
      expect(read.ok).toBe(true);
      if (read.ok) parts.push(read.bytes);
    }
    expect(Buffer.concat(parts).equals(Buffer.from(bytes))).toBe(true);
  });

  it("never turns a staging name into a path", () => {
    expect(createStagedBlob({ dataDir: dir, stagingRef: "../identity.json" })).toMatchObject({ ok: false, code: "STAGING_REF_INVALID" });
    expect(createStagedBlob({ dataDir: dir, stagingRef: "x.part/../../y.part" })).toMatchObject({ ok: false, code: "STAGING_REF_INVALID" });
    expect(readBlobRange({ dataDir: dir, location: { blobPath: join(dir, "identity.json") }, offset: 0, length: 10 })).toMatchObject({
      ok: false,
      code: "BLOB_PATH_ESCAPES_ROOT",
    });
  });
});

describe("a working artifact, written in chunks", () => {
  it("creates, streams more than one chunk, reads every range back and finalizes with a digest", async () => {
    const artifactId = await create("text/markdown", "ghi-chu.md");
    const bytes = textBytes(ARTIFACT_LIMITS.chunkBytes + 5000);

    const first = await write(artifactId, 0, bytes.subarray(0, ARTIFACT_LIMITS.chunkBytes));
    expect(first.status).toBe(200);
    const second = await write(artifactId, ARTIFACT_LIMITS.chunkBytes, bytes.subarray(ARTIFACT_LIMITS.chunkBytes));
    expect(second.status).toBe(200);
    expect((second.body as RefBody).artifactRef).toMatchObject({ kind: "working", sizeBytes: bytes.byteLength });
    expect((second.body as RefBody).artifactRef.digest).toBeUndefined();

    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const read = await call("GET", widget(`/${artifactId}/content`), undefined, { offset: String(offset), length: String(ARTIFACT_LIMITS.maxReadBytes) });
      expect(read.status).toBe(200);
      expectNoLocation(read);
      const body = read.body as { contentBase64: string; eof: boolean };
      const chunk = Buffer.from(body.contentBase64, "base64");
      parts.push(chunk);
      offset += chunk.byteLength;
      if (body.eof) break;
    }
    expect(parts).toHaveLength(2);
    expect(Buffer.concat(parts).equals(Buffer.from(bytes))).toBe(true);

    const finalized = await call("POST", widget(`/${artifactId}/finalize`));
    expect(finalized.status).toBe(200);
    expectNoLocation(finalized);
    expect((finalized.body as RefBody).artifactRef).toMatchObject({ kind: "finalized", mimeType: "text/markdown", name: "ghi-chu.md" });
    expect((finalized.body as RefBody).artifactRef.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Sealed: the staging file is gone and the bytes cannot change again.
    expect(readdirSync(stagingDir(dir))).toEqual([]);
    expect((await write(artifactId, bytes.byteLength, "more")).body).toMatchObject({ code: "ARTIFACT_NOT_WRITABLE" });
  });

  it("refuses an oversized chunk, a chunk out of order, and a range that is a bug in the reader", async () => {
    const artifactId = await create();
    const tooBig = await write(artifactId, 0, textBytes(ARTIFACT_LIMITS.chunkBytes + 1));
    expect(tooBig.status).toBe(413);
    expect((tooBig.body as { code: string }).code).toBe("ARTIFACT_CHUNK_TOO_LARGE");

    expect((await write(artifactId, 0, "abc")).status).toBe(200);
    const repeated = await write(artifactId, 0, "abc");
    expect(repeated.status).toBe(409);
    expect((repeated.body as { code: string }).code).toBe("ARTIFACT_OFFSET_MISMATCH");

    const past = await call("GET", widget(`/${artifactId}/content`), undefined, { offset: "4", length: "10" });
    expect(past.body).toMatchObject({ code: "ARTIFACT_RANGE_INVALID" });
    const huge = await call("GET", widget(`/${artifactId}/content`), undefined, { offset: "0", length: String(ARTIFACT_LIMITS.maxReadBytes + 1) });
    expect(huge.body).toMatchObject({ code: "ARTIFACT_RANGE_INVALID" });
  });

  it("refuses a type the attachment pipeline would not take, and bytes that disagree with the declared type", async () => {
    const html = await call("POST", widget(), { mimeType: "text/html" });
    expect(html.status).toBe(415);
    expect(html.body).toMatchObject({ code: "ARTIFACT_TYPE_UNSUPPORTED" });

    const pathName = await call("POST", widget(), { mimeType: "text/plain", name: "../../etc/passwd" });
    expect(pathName.status).toBe(400);
    expect(pathName.body).toMatchObject({ code: "ARTIFACT_NAME_NOT_ALLOWED" });

    const artifactId = await create("image/png", "anh.png");
    await write(artifactId, 0, "this is text, not a png");
    const mismatch = await call("POST", widget(`/${artifactId}/finalize`));
    expect(mismatch.status).toBe(415);
    expect(mismatch.body).toMatchObject({ code: "ARTIFACT_TYPE_MISMATCH" });
    // Left writable, so the widget can correct what it wrote.
    expect(getBrokerArtifact(services.runtime.db, artifactId)).toMatchObject({ kind: "working", state: "writable" });
  });

  it("counts a chunk against the principal's one quota, attachments included", async () => {
    const artifactId = await create();
    insertAttachment(services.runtime.db, {
      attachmentId: "att_big",
      principalId: owner(),
      conversationId,
      filename: "lon.txt",
      mime: "text/plain",
      kind: "text",
      sizeBytes: ATTACHMENT_LIMITS.principalQuotaBytes - 2,
      sha256: `sha256:${"a".repeat(64)}`,
      blobPath: join(dir, "blobs", "aaaa.txt"),
      createdAt: AT,
    });
    const refused = await write(artifactId, 0, "abc");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "ARTIFACT_QUOTA_EXCEEDED" });
    // And the other way round: an attachment upload sees the artifact's bytes too.
    expect((await write(artifactId, 0, "a")).status).toBe(200);
    const upload = await call("POST", "/attachments", { conversationId, filename: "b.txt", mime: "text/plain", contentBase64: Buffer.from("bb").toString("base64") });
    expect(upload.body).toMatchObject({ code: "ATTACHMENT_QUOTA_EXCEEDED" });
  });
});

describe("a ref is a pointer, not a permission", () => {
  it("refuses another instance that was never granted the artifact", async () => {
    const artifactId = await create();
    await write(artifactId, 0, "noi dung");
    const other = instance();
    const read = await call("GET", widget(`/${artifactId}/content`, other));
    expect(read.status).toBe(403);
    expect(read.body).toMatchObject({ code: "ARTIFACT_NOT_GRANTED" });
    expect((await write(artifactId, 8, "x", other)).body).toMatchObject({ code: "ARTIFACT_NOT_GRANTED" });
    expect((await call("POST", widget(`/${artifactId}/finalize`, other))).body).toMatchObject({ code: "ARTIFACT_NOT_GRANTED" });
  });

  it("refuses an instance of another principal, and an artifact of another principal", async () => {
    const foreignInstance = instance("prin_other");
    const denied = await call("POST", widget("", foreignInstance), { mimeType: "text/plain" });
    expect(denied.status).toBe(403);

    insertBrokerArtifact(services.runtime.db, {
      artifactId: "art_foreign",
      ownerPrincipalId: "prin_other",
      kind: "working",
      state: "writable",
      conversationId,
      instanceId,
      name: "cua-nguoi-khac.txt",
      mimeType: "text/plain",
      sizeBytes: 0,
      digest: undefined,
      blobPath: undefined,
      stagingRef: "art_foreign.part",
      createdAt: AT as Instant,
      expiresAt: "2099-01-01T00:00:00.000Z" as Instant,
      originNodeId: services.runtime.identity.nodeId,
    });
    // Even with a grant row naming this instance, the owner decides first.
    putArtifactGrant(services.runtime.db, {
      artifactId: "art_foreign",
      instanceId,
      principalId: owner(),
      access: "write",
      createdAt: AT as Instant,
      expiresAt: "2099-01-01T00:00:00.000Z" as Instant,
    });
    const read = await call("GET", widget("/art_foreign"));
    expect(read.status).toBe(403);
    expect(read.body).toMatchObject({ code: "ARTIFACT_CROSS_PRINCIPAL" });
    // The person's own routes answer "not found" rather than say whose it is.
    expect((await call("GET", "/artifacts/art_foreign")).status).toBe(404);
  });

  it("refuses once the grant expires, and once it is revoked", async () => {
    const artifactId = await create();
    await write(artifactId, 0, "noi dung");
    const grant = getArtifactGrant(services.runtime.db, artifactId, instanceId);
    expect(grant).toBeDefined();
    const later = new Date(Date.parse(grant?.expiresAt ?? AT) + 1000).toISOString();
    expect(readArtifactRange(brokerAt(later), { principalId: owner(), instanceId, artifactId, offset: 0, length: 4 })).toMatchObject({
      ok: false,
      // The artifact itself also expired by then; the grant would be the next reason. Both are refusals.
      code: expect.stringMatching(/^ARTIFACT_(GRANT_)?EXPIRED$/),
    });

    const revoked = await call("DELETE", widget(`/${artifactId}/grant`));
    expect(revoked.body).toEqual({ revoked: true });
    const read = await call("GET", widget(`/${artifactId}/content`));
    expect(read.status).toBe(403);
    expect(read.body).toMatchObject({ code: "ARTIFACT_GRANT_REVOKED" });
    // Revoked stays revoked: a later write does not bring the grant back.
    expect((await write(artifactId, 8, "x")).body).toMatchObject({ code: "ARTIFACT_GRANT_REVOKED" });
  });

  it("refuses an expired grant on a finalized artifact that does not itself expire", () => {
    const broker = brokerAt(AT);
    const created = createWorkingArtifact(broker, { principalId: owner(), conversationId, instanceId, mimeType: "text/plain" });
    if (!created.ok) throw new Error(created.message);
    const artifactId = created.ref.artifactId;
    appendArtifactChunk(broker, { principalId: owner(), instanceId, artifactId, offset: 0, bytes: new TextEncoder().encode("xin chao") });
    services.runtime.db
      .prepare("UPDATE artifacts SET expires_at = NULL, state = 'sealed', kind = 'finalized' WHERE artifact_id = ?")
      .run(artifactId);
    const past = new Date(Date.parse(AT) + ARTIFACT_LIMITS.grantTtlMs + 1).toISOString();
    expect(readArtifactRange(brokerAt(past), { principalId: owner(), instanceId, artifactId, offset: 0, length: 4 })).toMatchObject({
      ok: false,
      code: "ARTIFACT_GRANT_EXPIRED",
    });
  });
});

describe("a file the person picked", () => {
  const pick = (body: Record<string, unknown>) => call("POST", widget("/pick"), body);

  it("stores the bytes as an external, sealed artifact and grants it to that instance only", async () => {
    const response = await pick({ name: "bao-cao.md", mimeType: "text/markdown", contentBase64: Buffer.from("# Báo cáo\n").toString("base64"), accept: ["text/*"] });
    expect(response.status).toBe(201);
    expectNoLocation(response);
    const { artifactRef } = response.body as RefBody;
    expect(artifactRef).toMatchObject({ kind: "external", mimeType: "text/markdown", name: "bao-cao.md" });
    expect(artifactRef.digest).toMatch(/^sha256:/);
    const read = await call("GET", widget(`/${artifactRef.artifactId}/content`));
    expect(Buffer.from((read.body as { contentBase64: string }).contentBase64, "base64").toString()).toBe("# Báo cáo\n");
    const described = await call("GET", `/artifacts/${artifactRef.artifactId}`);
    expect(described.body).toMatchObject({ artifactRef: { artifactId: artifactRef.artifactId, kind: "external" } });
    expectNoLocation(described);
    // Read only: a picked file is a snapshot the widget may not write over.
    expect((await write(artifactRef.artifactId, 0, "x")).body).toMatchObject({ code: "ARTIFACT_NOT_WRITABLE" });
  });

  it("refuses bytes that are not what the widget asked for, or not what they claim to be", async () => {
    const notAccepted = await pick({ name: "a.txt", mimeType: "text/plain", contentBase64: Buffer.from("hi").toString("base64"), accept: ["image/*"] });
    expect(notAccepted.status).toBe(415);
    expect(notAccepted.body).toMatchObject({ code: "ARTIFACT_TYPE_NOT_ACCEPTED" });
    const lying = await pick({ name: "a.png", mimeType: "image/png", contentBase64: Buffer.from("hi").toString("base64") });
    expect(lying.body).toMatchObject({ code: "ARTIFACT_TYPE_MISMATCH" });
    const pathName = await pick({ name: "C:\\Users\\a.txt", mimeType: "text/plain", contentBase64: Buffer.from("hi").toString("base64") });
    expect(pathName.body).toMatchObject({ code: "ARTIFACT_NAME_NOT_ALLOWED" });
    const badAccept = await pick({ name: "a.txt", mimeType: "text/plain", contentBase64: Buffer.from("hi").toString("base64"), accept: ["../x"] });
    expect(badAccept.status).toBe(400);
  });
});

describe("handing a finalized artifact to the conversation", () => {
  async function finalized(text: string): Promise<string> {
    const artifactId = await create("text/markdown", "tom-tat.md");
    await write(artifactId, 0, text);
    expect((await call("POST", widget(`/${artifactId}/finalize`))).status).toBe(200);
    return artifactId;
  }

  it("refuses a working artifact, and attaches a finalized one the model can read", async () => {
    const working = await create();
    await write(working, 0, "chua xong");
    expect((await call("POST", widget(`/${working}/attach`))).body).toMatchObject({ code: "ARTIFACT_NOT_FINALIZED" });

    const artifactId = await finalized("# Tóm tắt\nba ý chính\n");
    const attached = await call("POST", widget(`/${artifactId}/attach`));
    expect(attached.status).toBe(201);
    expectNoLocation(attached);
    const { attachmentRef } = attached.body as { attachmentRef: { attachmentId: string; kind: string; filename: string; blobRef: string } };
    expect(attachmentRef).toMatchObject({ kind: "text", filename: "tom-tat.md" });

    const tool = createReadAttachmentTool({ db: services.runtime.db as never, principalId: owner(), conversationId, dataDir: dir });
    const read = await tool.execute({ attachmentId: attachmentRef.attachmentId });
    expect(read.text).toContain("ba ý chính");
    const brief = attachmentBrief({ refs: [attachmentRef as never], dataDir: dir });
    expect(brief).toContain("ba ý chính");
    expect(brief).not.toContain(dir);
  });

  it("saves as a download on the person's route only once it is finalized, under a name and never a path", async () => {
    const working = await create();
    await write(working, 0, "chua xong");
    expect((await call("POST", `/artifacts/${working}/export`, {})).body).toMatchObject({ code: "ARTIFACT_NOT_FINALIZED" });

    const artifactId = await finalized("# Xuất\n");
    const saved = await call("POST", `/artifacts/${artifactId}/export`, { suggestedName: "ban-luu.md" });
    expect(saved.status).toBe(200);
    expect(saved.binary?.headers?.["content-disposition"]).toBe('attachment; filename="ban-luu.md"');
    expect(Buffer.from(saved.binary?.bytes ?? new Uint8Array()).toString()).toBe("# Xuất\n");
    expect((await call("POST", `/artifacts/${artifactId}/export`, { suggestedName: "../ban.md" })).status).toBe(400);

    const opened = await call("GET", `/artifacts/${artifactId}/content`);
    expect(opened.binary?.headers?.["content-disposition"]).toContain("inline");
    expect(opened.binary?.headers?.["x-content-type-options"]).toBe("nosniff");
  });
});

describe("retention", () => {
  it("sweeps a working artifact whose time ran out, with its staged bytes", async () => {
    const artifactId = await create();
    await write(artifactId, 0, "tam thoi");
    const expiresAt = getBrokerArtifact(services.runtime.db, artifactId)?.expiresAt ?? AT;
    const after = new Date(Date.parse(expiresAt) + 1).toISOString();
    expect(readArtifactRange(brokerAt(after), { principalId: owner(), instanceId, artifactId, offset: 0, length: 4 })).toMatchObject({
      code: "ARTIFACT_EXPIRED",
    });
    expect(sweepExpiredArtifacts(brokerAt(after))).toEqual({ removed: 1 });
    expect(getBrokerArtifact(services.runtime.db, artifactId)).toBeUndefined();
    expect(readdirSync(stagingDir(dir))).toEqual([]);
  });

  it("removes a deleted conversation's artifacts, keeping a blob an attachment still shares until that goes too", async () => {
    const artifactId = await create("text/plain", "giu.txt");
    await write(artifactId, 0, "noi dung chia se");
    await call("POST", widget(`/${artifactId}/finalize`));
    await call("POST", widget(`/${artifactId}/attach`));
    const working = await create();
    await write(working, 0, "dang viet");

    const blobs = (): string[] => readdirSync(join(dir, "blobs")).filter((name) => name !== "staging");
    expect(blobs()).toHaveLength(1);

    expect(releaseConversationArtifacts({ db: services.runtime.db, dataDir: dir, conversationId })).toEqual({ removed: 2 });
    expect(getBrokerArtifact(services.runtime.db, artifactId)).toBeUndefined();
    expect(readdirSync(stagingDir(dir))).toEqual([]);
    // The attachment row still points at the content-addressed file.
    expect(blobs()).toHaveLength(1);

    releaseConversationAttachments({ db: services.runtime.db, dataDir: dir, conversationId });
    expect(blobs()).toHaveLength(0);
  });
});
