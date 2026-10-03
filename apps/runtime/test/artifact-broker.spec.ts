import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARTIFACT_LIMITS, ATTACHMENT_LIMITS, type Instant } from "@clarkcant/contracts";
import { createInstance, pinInstance } from "@clarkcant/core";
import { TABLE } from "@clarkcant/data-canvas";
import {
  attachmentUsageForPrincipal,
  getArtifactGrant,
  getBrokerArtifact,
  insertAttachment,
  insertBrokerArtifact,
  putArtifactGrant,
  recordWorkingArtifactWrite,
} from "@clarkcant/storage";

import {
  type ArtifactBrokerDeps,
  readArtifactForContext,
  readArtifactRange,
  releaseConversationArtifacts,
  revokeArtifactAccess,
  startArtifactSweep,
  sweepExpiredArtifacts,
  storedBytesForPrincipal,
  sweepOrphanedStaging,
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

/** A widget instance, pinned in the test conversation — the node refuses an instance a conversation does not hold. */
function instance(ownerPrincipalId = owner(), inConversation = conversationId): string {
  const created = createInstance(services.conductor, {
    definition: TABLE,
    packageDigest: "sha256:table",
    ownerPrincipalId: ownerPrincipalId as never,
    props: { title: "Tệp", datasetRef: "dataset_none", columns: ["name"] },
  }).instanceId;
  const pinned = pinInstance(services.conductor, {
    conversationId: inConversation,
    instanceId: created,
    displayMode: "compact",
    maxPins: 64,
  });
  expect(pinned.ok).toBe(true);
  return created;
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
  // Conversation ids from a counter: the default is the millisecond clock, and a test that opens two in one
  // millisecond would collide on it.
  let conversations = 0;
  deps = { services, now: () => AT as never, newConversationId: () => `conv_broker_${String((conversations += 1))}` };
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
    // Inside the staging folder is not enough: only a name of the shape the node makes is one.
    expect(createStagedBlob({ dataDir: dir, stagingRef: "notes.txt" })).toMatchObject({ ok: false, code: "STAGING_REF_INVALID" });
    expect(readdirSync(dir)).not.toContain("notes.txt");
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

  it("refuses a chunk that would take the artifact past the one-file ceiling, and takes one that fits", async () => {
    const artifactId = await create();
    const nearlyFull = ARTIFACT_LIMITS.maxBytes - 2;
    // Stands in for a hundred chunks already written: a staged file of that length, and the row that says so.
    truncateSync(join(stagingDir(dir), `${artifactId}.part`), nearlyFull);
    recordWorkingArtifactWrite(services.runtime.db, { artifactId, sizeBytes: nearlyFull, expiresAt: "2099-01-01T00:00:00.000Z" as Instant });

    const over = await write(artifactId, nearlyFull, "abc");
    expect(over.status).toBe(413);
    expect(over.body).toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
    const fits = await write(artifactId, nearlyFull, "ab");
    expect(fits.status).toBe(200);
    expect((fits.body as RefBody).artifactRef.sizeBytes).toBe(ARTIFACT_LIMITS.maxBytes);
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
    // The widget is told the quota is full, not how much the person stores: that figure is the person's, not the widget's.
    const told = (refused.body as { message: string }).message;
    expect(told).not.toContain(String(ATTACHMENT_LIMITS.principalQuotaBytes - 2));
    expect(told).not.toMatch(/\d{4,}/u);
    expect(told).toContain("artifacts.discard");
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
    const content = await call("GET", "/artifacts/art_foreign/content");
    expect(content.status).toBe(404);
    expect(content.body).toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
    const exported = await call("POST", "/artifacts/art_foreign/export", {});
    expect(exported.status).toBe(404);
    expect(exported.body).toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
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

    /*
     * Taking a widget's access away is the person's act, and no host chrome offers it yet, so no route reaches it: a
     * relay or an MCP client cannot revoke on the person's behalf. The broker's call is what that chrome will use.
     */
    expect((await call("DELETE", widget(`/${artifactId}/grant`))).status).toBe(404);
    expect(revokeArtifactAccess(brokerAt(new Date().toISOString()), { principalId: owner(), instanceId, artifactId })).toEqual({
      ok: true,
      revoked: true,
    });
    const read = await call("GET", widget(`/${artifactId}/content`));
    expect(read.status).toBe(403);
    expect(read.body).toMatchObject({ code: "ARTIFACT_GRANT_REVOKED" });
    // Revoked stays revoked: a later write does not bring the grant back.
    expect((await write(artifactId, 8, "x")).body).toMatchObject({ code: "ARTIFACT_GRANT_REVOKED" });
  });

  it("keeps a finalized file readable by the widget that made it, and ends every other widget's grant on time", async () => {
    const artifactId = await create("text/plain", "da-luu.txt");
    const writeStarted = Date.now();
    await write(artifactId, 0, "xin chao");
    const writeEnded = Date.now();
    const writtenGrant = getArtifactGrant(services.runtime.db, artifactId, instanceId);
    expect(writtenGrant).toBeDefined();
    const expiry = Date.parse(writtenGrant?.expiresAt ?? "");
    expect(expiry).toBeGreaterThanOrEqual(writeStarted + ARTIFACT_LIMITS.grantTtlMs);
    expect(expiry).toBeLessThanOrEqual(writeEnded + ARTIFACT_LIMITS.grantTtlMs);
    expect((await call("POST", widget(`/${artifactId}/finalize`))).status).toBe(200);
    // Finalization does not extend the maker's last-write grant; saved bytes remain readable after that grant expires.
    const makerGrant = getArtifactGrant(services.runtime.db, artifactId, instanceId);
    expect(makerGrant?.expiresAt).toBe(writtenGrant?.expiresAt);
    // Another widget the file was shared with holds an ordinary grant, which runs out.
    const other = instance();
    putArtifactGrant(services.runtime.db, {
      artifactId,
      instanceId: other,
      principalId: owner(),
      access: "read",
      createdAt: AT as Instant,
      expiresAt: new Date(Date.parse(AT) + ARTIFACT_LIMITS.grantTtlMs).toISOString() as Instant,
    });
    const past = new Date(Date.parse(AT) + ARTIFACT_LIMITS.grantTtlMs + 1).toISOString();
    const later = new Date(Math.max(Date.parse(past), Date.parse(makerGrant?.expiresAt ?? AT) + 1)).toISOString();
    // The widget that saved a file can open it again the next day: a saved file is not a lease.
    expect(readArtifactRange(brokerAt(later), { principalId: owner(), instanceId, artifactId, offset: 0, length: 4 })).toMatchObject({ ok: true });
    expect(readArtifactRange(brokerAt(later), { principalId: owner(), instanceId: other, artifactId, offset: 0, length: 4 })).toMatchObject({
      ok: false,
      code: "ARTIFACT_GRANT_EXPIRED",
    });
    // Revoking still ends the maker's access: keeping the file readable is not keeping it past the person's say.
    services.runtime.db
      .prepare("UPDATE artifact_grants SET revoked_at = ? WHERE artifact_id = ? AND instance_id = ?")
      .run(AT, artifactId, instanceId);
    expect(readArtifactRange(brokerAt(later), { principalId: owner(), instanceId, artifactId, offset: 0, length: 4 })).toMatchObject({
      ok: false,
      code: "ARTIFACT_GRANT_REVOKED",
    });
  });

  it("answers a widget route only for an instance the conversation in its path holds", async () => {
    const elsewhere = (await call("POST", "/conversations", { title: "khác" })).body as { conversationId: string };
    const stranger = instance(owner(), elsewhere.conversationId);
    // A real instance, a real conversation, but not together: the path does not pair them just by naming both.
    const created = await call("POST", widget("", stranger), { mimeType: "text/plain" });
    expect(created.status).toBe(404);
    expect(created.body).toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const artifactId = await create();
    expect((await call("GET", widget(`/${artifactId}`, stranger))).status).toBe(404);
    // An instance nothing holds at all is refused the same way.
    const loose = createInstance(services.conductor, {
      definition: TABLE,
      packageDigest: "sha256:table",
      ownerPrincipalId: owner() as never,
      props: { title: "Tệp", datasetRef: "dataset_none", columns: ["name"] },
    }).instanceId;
    expect((await call("POST", widget("", loose), { mimeType: "text/plain" })).status).toBe(404);
  });
});

describe("a file read as an agent button's context", () => {
  it("is read only for a widget the conversation still holds, even one with a live grant", async () => {
    const artifactId = await create("text/markdown", "ghi-chu.md");
    expect((await write(artifactId, 0, "# Ghi chú\n")).status).toBe(200);
    expect((await call("POST", widget(`/${artifactId}/finalize`))).status).toBe(200);
    const input = { principalId: owner(), instanceId, conversationId, artifactId };
    expect(readArtifactForContext(brokerAt(AT), input)).toMatchObject({ ok: true, excerpt: { text: "# Ghi chú\n", complete: true } });

    // The widget leaves the conversation; its grant to the file has not run out, and still does not reach it here.
    services.runtime.db.prepare("DELETE FROM pins WHERE instance_id = ?").run(instanceId);
    expect(getArtifactGrant(services.runtime.db, artifactId, instanceId)).toBeDefined();
    expect(readArtifactForContext(brokerAt(AT), input)).toMatchObject({ ok: false, code: "ARTIFACT_NOT_GRANTED" });
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
    // A name is stored without the characters that reverse how it reads, for a picked file and a made one alike.
    const reversed = await pick({ name: "anh\u202Egpj.txt", mimeType: "text/plain", contentBase64: Buffer.from("x").toString("base64") });
    expect((reversed.body as RefBody).artifactRef.name).toBe("anhgpj.txt");
    const made = await call("POST", widget(), { mimeType: "text/plain", name: "ghi\u2067chu.txt" });
    expect((made.body as RefBody).artifactRef.name).toBe("ghichu.txt");
    // Read only: a picked file is a snapshot the widget may not write over.
    expect((await write(artifactRef.artifactId, 0, "x")).body).toMatchObject({ code: "ARTIFACT_NOT_WRITABLE" });
  });

  it("takes a file whose system named its type by another name, or by none, and reads what it is from the bytes", async () => {
    const csv = Buffer.from("ten,so\nan,1\n").toString("base64");
    // Windows with Office installed calls a .csv `application/vnd.ms-excel`.
    const excel = await pick({ name: "so-lieu.csv", mimeType: "application/vnd.ms-excel", contentBase64: csv, accept: ["text/csv"] });
    expect(excel.status).toBe(201);
    expect((excel.body as RefBody).artifactRef).toMatchObject({ mimeType: "text/csv", name: "so-lieu.csv" });
    // A system with no idea sends a generic binary type; the extension names a text type the bytes cannot.
    const generic = await pick({ name: "ghi-chu.md", mimeType: "application/octet-stream", contentBase64: Buffer.from("# Ghi chú\n").toString("base64") });
    expect((generic.body as RefBody).artifactRef).toMatchObject({ mimeType: "text/markdown" });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const picture = await pick({ name: "anh", mimeType: "application/octet-stream", contentBase64: png.toString("base64"), accept: ["image/*"] });
    expect((picture.body as RefBody).artifactRef).toMatchObject({ mimeType: "image/png" });
    // The name is not what decides: text under a picture's name, sent as generic bytes, is text, and a widget that asked
    // for pictures is refused it. A specific claim the bytes contradict is still refused as a mismatch.
    const named = await pick({ name: "anh.png", mimeType: "application/octet-stream", contentBase64: csv, accept: ["image/*"] });
    expect(named.body).toMatchObject({ code: "ARTIFACT_TYPE_NOT_ACCEPTED" });
    const disguised = await pick({ name: "anh.png", mimeType: "image/x-png", contentBase64: csv });
    expect(disguised.body).toMatchObject({ code: "ARTIFACT_TYPE_MISMATCH" });
  });

  it("takes tab-separated values as text like comma-separated ones, saves them as .tsv, and refuses binary bytes under that type", async () => {
    const tsv = Buffer.from("ten\tso\nan\t1\n").toString("base64");
    const declared = await pick({ name: "so-lieu.tsv", mimeType: "text/tab-separated-values", contentBase64: tsv, accept: ["text/tab-separated-values"] });
    expect(declared.status).toBe(201);
    expect((declared.body as RefBody).artifactRef).toMatchObject({ mimeType: "text/tab-separated-values", name: "so-lieu.tsv" });
    // Another name for the type, and a generic type with the extension, land on the same type.
    const aliased = await pick({ name: "so-lieu.tab", mimeType: "text/tsv", contentBase64: tsv, accept: ["text/*"] });
    expect((aliased.body as RefBody).artifactRef).toMatchObject({ mimeType: "text/tab-separated-values" });
    const generic = await pick({ name: "so-lieu.tsv", mimeType: "application/octet-stream", contentBase64: tsv });
    expect((generic.body as RefBody).artifactRef).toMatchObject({ mimeType: "text/tab-separated-values" });
    // A picture declared as tab-separated values is still refused: the bytes decide.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const binary = await pick({ name: "so-lieu.tsv", mimeType: "text/tab-separated-values", contentBase64: png.toString("base64") });
    expect(binary.status).toBe(415);
    expect(binary.body).toMatchObject({ code: "ARTIFACT_TYPE_MISMATCH" });

    const artifactId = await create("text/tab-separated-values", "bang.tsv");
    await write(artifactId, 0, "a\tb\n1\t2\n");
    expect((await call("POST", widget(`/${artifactId}/finalize`))).status).toBe(200);
    const saved = await call("POST", `/artifacts/${artifactId}/export`, { suggestedName: "bang" });
    expect(saved.binary?.headers?.["content-disposition"]).toContain('filename="bang.tsv"');
    const written = await create("text/tab-separated-values", "nhi-phan.tsv");
    await write(written, 0, png);
    expect((await call("POST", widget(`/${written}/finalize`))).body).toMatchObject({ code: "ARTIFACT_TYPE_MISMATCH" });
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

  it("attaches one file once, however often the widget asks", async () => {
    const artifactId = await finalized("# Một lần\n");
    const usage = (): number => attachmentUsageForPrincipal(services.runtime.db, owner());
    const first = await call("POST", widget(`/${artifactId}/attach`));
    expect(first.status).toBe(201);
    const afterFirst = usage();
    for (let again = 0; again < 3; again += 1) {
      const repeated = await call("POST", widget(`/${artifactId}/attach`));
      expect(repeated.status).toBe(201);
      expect((repeated.body as { attachmentRef: { attachmentId: string } }).attachmentRef.attachmentId).toBe(
        (first.body as { attachmentRef: { attachmentId: string } }).attachmentRef.attachmentId,
      );
    }
    expect(usage()).toBe(afterFirst);
  });

  it("attaches under the name the widget proposes, made safe by the node", async () => {
    const first = await finalized("# Kế hoạch\n");
    const named = await call("POST", widget(`/${first}/attach`), { name: "../../etc/Kế hoạch‮.exe" });
    expect(named.status).toBe(201);
    expect((named.body as { attachmentRef: { filename: string } }).attachmentRef.filename).toBe("Kế hoạch.md");

    // Nothing usable left: the type's default name, still attached.
    const second = await finalized("# Hai\n");
    const emptied = await call("POST", widget(`/${second}/attach`), { name: "/// .." });
    expect((emptied.body as { attachmentRef: { filename: string } }).attachmentRef.filename).toBe("untitled.md");

    // A proposal that is not a string is a malformed request, refused before anything is attached.
    const third = await finalized("# Ba\n");
    const malformed = await call("POST", widget(`/${third}/attach`), { name: 42 });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ code: "INVALID_SCHEMA" });
    // Without a proposal the attachment keeps the artifact's own name.
    const plain = await call("POST", widget(`/${third}/attach`));
    expect((plain.body as { attachmentRef: { filename: string } }).attachmentRef.filename).toBe("tom-tat.md");
  });

  it("saves as a download on the person's route only once it is finalized, under a name and never a path", async () => {
    const working = await create();
    await write(working, 0, "chua xong");
    expect((await call("POST", `/artifacts/${working}/export`, {})).body).toMatchObject({ code: "ARTIFACT_NOT_FINALIZED" });

    const artifactId = await finalized("# Xuất\n");
    const saved = await call("POST", `/artifacts/${artifactId}/export`, { suggestedName: "ban-luu.md" });
    expect(saved.status).toBe(200);
    expect(saved.binary?.headers?.["content-disposition"]).toBe("attachment; filename=\"ban-luu.md\"; filename*=UTF-8''ban-luu.md");
    expect(Buffer.from(saved.binary?.bytes ?? new Uint8Array()).toString()).toBe("# Xuất\n");
    expect((await call("POST", `/artifacts/${artifactId}/export`, { suggestedName: "../ban.md" })).status).toBe(400);

    // The saved name ends in the type's extension, whatever the widget suggested, so the file opens as what it is.
    const bare = await call("POST", `/artifacts/${artifactId}/export`, { suggestedName: "ban-luu" });
    expect(bare.binary?.headers?.["content-disposition"]).toContain('filename="ban-luu.md"');
    const disguised = await call("POST", `/artifacts/${artifactId}/export`, { suggestedName: "chay-toi.exe" });
    expect(disguised.binary?.headers?.["content-disposition"]).toContain('filename="chay-toi.md"');

    const opened = await call("GET", `/artifacts/${artifactId}/content`);
    expect(opened.binary?.headers?.["content-disposition"]).toContain("inline");
    expect(opened.binary?.headers?.["x-content-type-options"]).toBe("nosniff");
  });
});

describe("a widget lets go of a file it made", () => {
  const discard = (artifactId: string, target = instanceId) => call("DELETE", widget(`/${artifactId}`, target));

  it("discards a working file with its staged bytes, and a finalized one with bytes nothing else holds", async () => {
    const working = await create();
    await write(working, 0, "nhap");
    const gone = await discard(working);
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ discarded: true, artifactId: working });
    expect(getBrokerArtifact(services.runtime.db, working)).toBeUndefined();
    expect(getArtifactGrant(services.runtime.db, working, instanceId)).toBeUndefined();
    expect(readdirSync(stagingDir(dir))).toEqual([]);

    const sealed = await create("text/plain", "xong.txt");
    await write(sealed, 0, "da xong");
    await call("POST", widget(`/${sealed}/finalize`));
    const blobs = (): string[] => readdirSync(join(dir, "blobs")).filter((name) => name !== "staging");
    expect(blobs()).toHaveLength(1);
    expect((await discard(sealed)).status).toBe(200);
    expect(blobs()).toHaveLength(0);
    // Gone is gone: a second discard, or any use of the old ref, is told it is not there.
    expect((await discard(sealed)).body).toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
    expect((await call("GET", widget(`/${sealed}/content`))).status).toBe(404);
  });

  it("keeps the bytes of a file it attached, because the attachment points at them too", async () => {
    const artifactId = await create("text/plain", "dinh-kem.txt");
    await write(artifactId, 0, "gui kem");
    await call("POST", widget(`/${artifactId}/finalize`));
    const attached = await call("POST", widget(`/${artifactId}/attach`));
    const { attachmentRef } = attached.body as { attachmentRef: { attachmentId: string } };
    expect((await discard(artifactId)).status).toBe(200);
    const tool = createReadAttachmentTool({ db: services.runtime.db as never, principalId: owner(), conversationId, dataDir: dir });
    expect((await tool.execute({ attachmentId: attachmentRef.attachmentId })).text).toContain("gui kem");
  });

  it("refuses a file the person chose, and a file another widget made, even one it was granted", async () => {
    const picked = await call("POST", widget("/pick"), { name: "cua-toi.txt", mimeType: "text/plain", contentBase64: Buffer.from("cua toi").toString("base64") });
    const pickedId = (picked.body as RefBody).artifactRef.artifactId;
    const chosen = await discard(pickedId);
    expect(chosen.status).toBe(403);
    expect(chosen.body).toMatchObject({ code: "ARTIFACT_NOT_CREATOR" });
    expect(getBrokerArtifact(services.runtime.db, pickedId)).toBeDefined();

    const artifactId = await create();
    const other = instance();
    putArtifactGrant(services.runtime.db, {
      artifactId,
      instanceId: other,
      principalId: owner(),
      access: "write",
      createdAt: AT as Instant,
      expiresAt: "2099-01-01T00:00:00.000Z" as Instant,
    });
    const notMine = await discard(artifactId, other);
    expect(notMine.status).toBe(403);
    expect(notMine.body).toMatchObject({ code: "ARTIFACT_NOT_CREATOR" });
    expect(getBrokerArtifact(services.runtime.db, artifactId)).toBeDefined();
  });

  it("refuses once the person revoked the widget's access", async () => {
    const artifactId = await create();
    revokeArtifactAccess(brokerAt(new Date().toISOString()), { principalId: owner(), instanceId, artifactId });
    expect((await discard(artifactId)).body).toMatchObject({ code: "ARTIFACT_GRANT_REVOKED" });
  });
});

describe("one widget's share of the quota", () => {
  /** Stands in for files this widget already saved: a finalized row of that size, owned by the instance. */
  function alreadyHolds(sizeBytes: number, target = instanceId): void {
    insertBrokerArtifact(services.runtime.db, {
      artifactId: `art_held_${target}`,
      ownerPrincipalId: owner(),
      kind: "finalized",
      state: "sealed",
      conversationId,
      instanceId: target,
      name: "da-luu.txt",
      mimeType: "text/plain",
      sizeBytes,
      digest: `sha256:${"f".repeat(64)}`,
      blobPath: join(dir, "blobs", "ffff.txt"),
      stagingRef: undefined,
      createdAt: AT as Instant,
      expiresAt: undefined,
      originNodeId: services.runtime.identity.nodeId,
    });
  }

  it("refuses bytes past the instance cap long before the principal's quota, and only for that widget", async () => {
    expect(ARTIFACT_LIMITS.instanceQuotaBytes).toBe(128 * 1024 * 1024);
    expect(ARTIFACT_LIMITS.instanceQuotaBytes).toBeLessThan(ATTACHMENT_LIMITS.principalQuotaBytes);
    const artifactId = await create();
    alreadyHolds(ARTIFACT_LIMITS.instanceQuotaBytes - 2);

    const over = await write(artifactId, 0, "abc");
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: "ARTIFACT_INSTANCE_QUOTA_EXCEEDED" });
    expect((over.body as { message: string }).message).toContain("artifacts.discard");
    expect((await write(artifactId, 0, "ab")).status).toBe(200);

    // Full: a new file is refused for this widget. A file the person picks is theirs, and is still taken.
    expect((await call("POST", widget(), { mimeType: "text/plain" })).body).toMatchObject({ code: "ARTIFACT_INSTANCE_QUOTA_EXCEEDED" });
    const picked = await call("POST", widget("/pick"), { name: "a.txt", mimeType: "text/plain", contentBase64: Buffer.from("x").toString("base64") });
    expect(picked.status).toBe(201);

    // Another widget in the same conversation still has its own share.
    const other = instance();
    expect((await call("POST", widget("", other), { mimeType: "text/plain" })).status).toBe(201);

    // Discarding frees the share.
    expect((await call("DELETE", widget(`/${artifactId}`))).status).toBe(200);
    expect((await call("DELETE", widget(`/art_held_${instanceId}`))).status).toBe(200);
    expect((await call("POST", widget(), { mimeType: "text/plain" })).status).toBe(201);
  });

  it("counts what the widget attached to the conversation against its share, for as long as the attachment is kept", async () => {
    const artifactId = await create("text/plain", "gui-kem.txt");
    expect((await write(artifactId, 0, "x".repeat(20))).status).toBe(200);
    expect((await call("POST", widget(`/${artifactId}/finalize`))).status).toBe(200);
    alreadyHolds(ARTIFACT_LIMITS.instanceQuotaBytes - 30);

    // The file (20 bytes) and the files already held leave 10 bytes: attaching 20 more is past the share.
    const tooMuch = await call("POST", widget(`/${artifactId}/attach`));
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body).toMatchObject({ code: "ARTIFACT_INSTANCE_QUOTA_EXCEEDED" });
    expect(attachmentUsageForPrincipal(services.runtime.db, owner())).toBe(0);

    // With room for it, the attachment is made and counted; discarding the file does not take the attachment's bytes
    // off the share, because the conversation still keeps them.
    expect((await call("DELETE", widget(`/art_held_${instanceId}`))).status).toBe(200);
    alreadyHolds(ARTIFACT_LIMITS.instanceQuotaBytes - 40);
    expect((await call("POST", widget(`/${artifactId}/attach`))).status).toBe(201);
    expect((await call("POST", widget(), { mimeType: "text/plain" })).body).toMatchObject({ code: "ARTIFACT_INSTANCE_QUOTA_EXCEEDED" });
    expect((await call("DELETE", widget(`/${artifactId}`))).status).toBe(200);
    const next = await create();
    expect((await write(next, 0, "x".repeat(21))).body).toMatchObject({ code: "ARTIFACT_INSTANCE_QUOTA_EXCEEDED" });
    expect((await write(next, 0, "x".repeat(20))).status).toBe(200);
  });

  it("does not count a file the person picked, so a widget that was handed files is never locked out by them", async () => {
    alreadyHolds(ARTIFACT_LIMITS.instanceQuotaBytes - 2);
    const picked = await call("POST", widget("/pick"), { name: "cua-toi.txt", mimeType: "text/plain", contentBase64: Buffer.from("cua toi chon").toString("base64") });
    expect(picked.status).toBe(201);
    const artifactId = await create();
    expect((await write(artifactId, 0, "ab")).status).toBe(200);
    // The person's quota still counts it: picking is not a way around the principal's one quota.
    expect(storedBytesForPrincipal(services.runtime.db, owner())).toBe(ARTIFACT_LIMITS.instanceQuotaBytes + "cua toi chon".length);
  });
});

describe("an empty file", () => {
  it("finalizes an empty text file, and still refuses an empty picture", async () => {
    const note = await create("text/markdown", "trong.md");
    const finalized = await call("POST", widget(`/${note}/finalize`));
    expect(finalized.status).toBe(200);
    expect((finalized.body as RefBody).artifactRef).toMatchObject({ kind: "finalized", sizeBytes: 0, mimeType: "text/markdown" });
    expect((finalized.body as RefBody).artifactRef.digest).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );

    const picture = await create("image/png", "trong.png");
    const refused = await call("POST", widget(`/${picture}/finalize`));
    expect(refused.status).toBe(415);
    expect(getBrokerArtifact(services.runtime.db, picture)).toMatchObject({ kind: "working" });
  });
});

describe("retention", () => {
  it("clears staged files a previous process left behind, and only those, when the node starts", async () => {
    const live = await create();
    await write(live, 0, "dang viet");
    mkdirSync(stagingDir(dir), { recursive: true });
    writeFileSync(join(stagingDir(dir), "art_leftover.part"), "mo coi");
    // Not a name the node makes: not the node's to delete.
    writeFileSync(join(stagingDir(dir), "someone-elses.txt"), "giu");

    expect(sweepOrphanedStaging({ db: services.runtime.db, dataDir: dir })).toEqual({ removed: 1 });
    expect(readdirSync(stagingDir(dir)).sort()).toEqual([`${live}.part`, "someone-elses.txt"]);
    expect((await write(live, 9, " tiep")).status).toBe(200);

    // And the node's start runs it.
    writeFileSync(join(stagingDir(dir), "art_leftover2.part"), "mo coi");
    const sweep = startArtifactSweep({ db: services.runtime.db, dataDir: dir }, { intervalMs: 60_000 });
    sweep.stop();
    expect(readdirSync(stagingDir(dir))).not.toContain("art_leftover2.part");
  });

  it("does nothing when there is no staging folder yet", () => {
    expect(sweepOrphanedStaging({ db: services.runtime.db, dataDir: join(dir, "nowhere") })).toEqual({ removed: 0 });
  });

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
